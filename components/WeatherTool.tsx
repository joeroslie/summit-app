'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import StormMap from '@/components/StormMap';
import {
  STORM_CATEGORIES,
  STORM_WINDOWS,
  US_STATES,
  directionsUrl,
  eventStyle,
  formatMagnitude,
  haversineMiles,
  relativeTimeFrom,
  type StormEventCategory,
  type StormReport,
  type StormReportsResponse,
  type StormWindow,
} from '@/lib/weather';
import { CLUSTER_SEVERITY_STYLES, clusterStormReports } from '@/lib/storm-clusters';

const AUTO_REFRESH_MS = 5 * 60 * 1000;

type LatLngPoint = { lat: number; lng: number };

type WeatherToolProps = {
  /** Reuse the app's single global toast instead of a second one. */
  showToast: (message: string) => void;
};

function absoluteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function WeatherTool({ showToast }: WeatherToolProps) {
  const [timeWindow, setTimeWindow] = useState<StormWindow>('24h');
  const [stateFilter, setStateFilter] = useState('');
  const [activeCategories, setActiveCategories] = useState<Record<StormEventCategory, boolean>>({
    hail: true,
    wind: true,
    tornado: true,
  });

  const [reports, setReports] = useState<StormReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flyTo, setFlyTo] = useState<LatLngPoint | null>(null);
  const [fitSignal, setFitSignal] = useState(0);

  const [userLocation, setUserLocation] = useState<LatLngPoint | null>(null);
  const [locating, setLocating] = useState(false);

  const [showDamageZones, setShowDamageZones] = useState(false);

  // Tick every 30s so relative timestamps ("3m ago") stay fresh without refetching.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setClockTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const requestSeq = useRef(0);

  const loadReports = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent ?? false;
      const seq = ++requestSeq.current;
      if (silent) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ window: timeWindow });
        if (stateFilter) params.set('state', stateFilter);
        const res = await fetch(`/api/storm-reports?${params.toString()}`, {
          cache: 'no-store',
        });
        const data = (await res.json()) as StormReportsResponse & { error?: string };
        if (seq !== requestSeq.current) return;
        if (!res.ok) {
          setError(data?.error || 'Could not load storm reports');
          return;
        }
        setReports(data.reports || []);
        setFetchedAt(data.fetchedAt || new Date().toISOString());
      } catch {
        if (seq !== requestSeq.current) return;
        setError('Could not reach the storm report service — check your connection');
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [timeWindow, stateFilter]
  );

  useEffect(() => {
    void (async () => {
      await loadReports();
    })();
  }, [loadReports]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void loadReports({ silent: true });
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [autoRefresh, loadReports]);

  const counts = useMemo(() => {
    const c: Record<StormEventCategory, number> = { hail: 0, wind: 0, tornado: 0 };
    reports.forEach((r) => {
      c[r.category] += 1;
    });
    return c;
  }, [reports]);

  const filteredReports = useMemo(
    () => reports.filter((r) => activeCategories[r.category]),
    [reports, activeCategories]
  );

  // Clustered from whatever is currently filtered (time window / state /
  // category), so the zones always match what's plotted. Memoized so
  // toggling the "Show damage zones" switch never recomputes the geometry —
  // only a change in the underlying report set does.
  const damageZoneClusters = useMemo(
    () => clusterStormReports(filteredReports),
    [filteredReports]
  );

  const listReports = useMemo(() => {
    const withDistance = filteredReports.map((r) => ({
      report: r,
      distanceMiles: userLocation ? haversineMiles(userLocation, r) : null,
    }));
    return withDistance.sort(
      (a, b) => new Date(b.report.validTime).getTime() - new Date(a.report.validTime).getTime()
    );
  }, [filteredReports, userLocation]);

  const selectedReport = useMemo(() => {
    const rep = reports.find((r) => r.id === selectedId);
    if (!rep || !activeCategories[rep.category]) return null;
    return rep;
  }, [reports, selectedId, activeCategories]);

  const selectedDistance =
    selectedReport && userLocation ? haversineMiles(userLocation, selectedReport) : null;

  const selectReport = useCallback(
    (id: string) => {
      setSelectedId(id);
      const rep = reports.find((r) => r.id === id);
      if (rep) setFlyTo({ lat: rep.lat, lng: rep.lng });
    },
    [reports]
  );

  const toggleCategory = (cat: StormEventCategory) => {
    setActiveCategories((prev) => ({ ...prev, [cat]: !prev[cat] }));
  };

  const useMyLocation = useCallback(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      showToast('Location not available on this device');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setUserLocation(loc);
        setFlyTo(loc);
      },
      () => {
        setLocating(false);
        showToast('Could not get your location — check permissions');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }, [showToast]);

  const lastUpdatedLabel = fetchedAt ? `Updated ${relativeTimeFrom(fetchedAt)}` : null;

  return (
    <div className="page-shell page-fade">
      <div className="mb-8 flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-3xl font-semibold text-zinc-900 tracking-tight">Weather</h1>
        <div className="flex items-center gap-3">
          {lastUpdatedLabel && (
            <span className="text-xs text-zinc-400 tabular-nums">
              {lastUpdatedLabel}
              {refreshing ? ' · refreshing…' : ''}
            </span>
          )}
          <button
            type="button"
            onClick={() => void loadReports()}
            disabled={loading || refreshing}
            className="btn-primary px-4 py-2 rounded-2xl text-sm font-semibold disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {STORM_CATEGORIES.map((cat) => {
          const style = eventStyle(cat);
          return (
            <button
              key={cat}
              type="button"
              onClick={() => toggleCategory(cat)}
              className={`text-left rounded-3xl border p-5 transition-opacity ${
                activeCategories[cat]
                  ? 'border-zinc-200 bg-white'
                  : 'border-zinc-200 bg-white opacity-40'
              }`}
            >
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-zinc-400 font-medium">
                <span className={`w-2 h-2 rounded-full ${style.dot}`} />
                {style.label} reports
              </div>
              <div className="text-3xl font-semibold tabular-nums text-zinc-900 mt-1">
                {counts[cat]}
              </div>
            </button>
          );
        })}
      </div>

      <div className="rounded-3xl border border-zinc-200 bg-white p-5 sm:p-6 mb-6">
        <div className="flex flex-col lg:flex-row lg:items-center gap-4">
          <div className="flex items-center gap-1.5 rounded-2xl bg-zinc-100 p-1">
            {STORM_WINDOWS.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => setTimeWindow(w.id)}
                className={`px-3.5 py-2 rounded-xl text-sm font-medium transition-colors ${
                  timeWindow === w.id
                    ? 'bg-white text-zinc-900 shadow-sm'
                    : 'text-zinc-500 hover:text-zinc-800'
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>

          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
            className="rounded-2xl border border-zinc-200 px-4 py-2.5 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-sky-300"
          >
            <option value="">All states</option>
            {US_STATES.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>

          <div className="flex-1" />

          <button
            type="button"
            onClick={() => setAutoRefresh((v) => !v)}
            className={`px-3.5 py-2 rounded-xl text-xs font-medium border transition-colors ${
              autoRefresh
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : 'border-zinc-200 text-zinc-500'
            }`}
          >
            Auto-refresh {autoRefresh ? 'on' : 'off'}
          </button>

          <button
            type="button"
            onClick={useMyLocation}
            disabled={locating}
            className="btn-primary px-4 py-2.5 rounded-2xl text-sm font-semibold whitespace-nowrap disabled:opacity-50"
          >
            {locating ? 'Finding you…' : userLocation ? 'Re-center on me' : 'Show my location'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-100 bg-red-50 text-red-700 px-4 py-3 text-sm mb-6 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void loadReports()}
            className="font-semibold underline shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      <StormMap
        reports={filteredReports}
        selectedReportId={selectedId}
        onSelectReport={selectReport}
        userLocation={userLocation}
        center={flyTo}
        fitSignal={fitSignal}
        clusters={damageZoneClusters}
        showDamageZones={showDamageZones}
        height={520}
        className="mb-3"
      />

      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => setShowDamageZones((v) => !v)}
            disabled={damageZoneClusters.length === 0}
            className={`px-3.5 py-2 rounded-xl text-xs font-medium border transition-colors disabled:opacity-40 ${
              showDamageZones
                ? 'border-sky-200 bg-sky-50 text-sky-700'
                : 'border-zinc-200 text-zinc-500'
            }`}
          >
            Show damage zones {showDamageZones ? 'on' : 'off'}
            {damageZoneClusters.length > 0 ? ` · ${damageZoneClusters.length}` : ''}
          </button>
          {showDamageZones && (
            <div className="flex items-center gap-3 text-xs text-zinc-500">
              {(['marginal', 'moderate', 'severe'] as const).map((tier) => (
                <span key={tier} className="flex items-center gap-1.5">
                  <span
                    className="w-3 h-3 rounded-sm border border-zinc-400/60"
                    style={{
                      backgroundColor: '#64748b',
                      opacity: CLUSTER_SEVERITY_STYLES[tier].fillOpacity + 0.3,
                    }}
                  />
                  {CLUSTER_SEVERITY_STYLES[tier].label}
                </span>
              ))}
              <span className="text-zinc-400">
                Approximate zones from clustered ground/spotter reports — not official radar-verified swaths
              </span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setFitSignal((n) => n + 1)}
          disabled={filteredReports.length === 0}
          className="text-xs font-medium text-sky-700 hover:text-sky-800 disabled:opacity-30"
        >
          Fit map to all reports
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4">
        <div className="rounded-3xl border border-zinc-200 bg-white p-5 sm:p-6">
          {!selectedReport ? (
            <div className="text-sm text-zinc-500 py-10 text-center">
              Select a pin on the map to see the report
            </div>
          ) : (
            <ReportDetail
              report={selectedReport}
              distanceMiles={selectedDistance}
            />
          )}
        </div>

        <div className="rounded-3xl border border-zinc-200 bg-white p-5 sm:p-6">
          <div className="text-sm font-semibold text-zinc-900 mb-3">
            Reports
            {filteredReports.length > 0 ? (
              <span className="font-normal text-zinc-400"> · {filteredReports.length}</span>
            ) : null}
          </div>
          {loading ? (
            <div className="text-sm text-zinc-500 py-6 text-center">Loading reports…</div>
          ) : listReports.length === 0 ? (
            <div className="text-sm text-zinc-500 py-6 text-center">
              No hail, wind, or tornado reports in this window
            </div>
          ) : (
            <div className="space-y-2 max-h-[560px] overflow-y-auto -mx-1 px-1">
              {listReports.map(({ report, distanceMiles }) => {
                const style = eventStyle(report.category);
                const active = report.id === selectedId;
                const mag = formatMagnitude(report);
                return (
                  <button
                    key={report.id}
                    type="button"
                    onClick={() => selectReport(report.id)}
                    className={`w-full text-left rounded-2xl border px-3 py-2.5 transition-colors ${
                      active
                        ? 'border-zinc-900 bg-zinc-50'
                        : 'border-zinc-200 hover:bg-zinc-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-zinc-900 truncate">
                        {report.locDesc || report.state || 'Unknown location'}
                      </span>
                      <span className={`shrink-0 w-2 h-2 rounded-full ${style.dot}`} />
                    </div>
                    <div className="text-xs text-zinc-400 mt-0.5">
                      {style.label}
                      {mag ? ` · ${mag}` : ''} · {relativeTimeFrom(report.validTime)}
                      {distanceMiles != null ? ` · ${distanceMiles.toFixed(1)} mi away` : ''}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type ReportDetailProps = {
  report: StormReport;
  distanceMiles: number | null;
};

function ReportDetail({ report, distanceMiles }: ReportDetailProps) {
  const style = eventStyle(report.category);
  const mag = formatMagnitude(report);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${style.badge}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
            {style.label}
          </div>
          <div className="text-xs text-zinc-400 mt-2">
            {absoluteTime(report.validTime)} · {relativeTimeFrom(report.validTime)}
          </div>
        </div>
        <a
          href={directionsUrl(report.lat, report.lng)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium text-sky-700 hover:text-sky-800 shrink-0"
        >
          Get directions
        </a>
      </div>

      <div>
        <div className="text-xl font-semibold text-zinc-900">
          {report.locDesc || 'Unknown location'}
        </div>
        <div className="text-sm text-zinc-500 mt-0.5">
          {[report.state, report.wfo].filter(Boolean).join(' · ')}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div>
          <div className="text-[11px] text-zinc-400">Magnitude</div>
          <div className="text-zinc-900 font-medium">{mag || 'Not reported'}</div>
        </div>
        <div>
          <div className="text-[11px] text-zinc-400">Distance from you</div>
          <div className="text-zinc-900 font-medium">
            {distanceMiles != null ? `${distanceMiles.toFixed(1)} mi` : '—'}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-zinc-50/70 p-4">
        <div className="text-xs font-semibold text-zinc-700 mb-2">Remarks</div>
        <p className="text-sm text-zinc-600 leading-relaxed">
          {report.remarks || 'No narrative provided with this report.'}
        </p>
      </div>
    </div>
  );
}
