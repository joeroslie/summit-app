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
  formatStormDayLabel,
  haversineMiles,
  isLiveStormWindow,
  localDateInputValue,
  parseStormDay,
  readStoredNearRadiusMiles,
  relativeTimeFrom,
  stormDayMinValue,
  writeStoredNearRadiusMiles,
  type StormEventCategory,
  type StormReport,
  type StormReportsResponse,
  type StormWarning,
  type StormWindow,
} from '@/lib/weather';
import {
  CLUSTER_SEVERITY_STYLES,
  mergeDamageZones,
  readStoredDamageZones,
  writeStoredDamageZones,
} from '@/lib/storm-clusters';
import {
  RADAR_FRAMES_REFRESH_MS,
  readStoredWeatherOverlay,
  writeStoredWeatherOverlay,
  type RadarFrame,
  type RadarFramesResponse,
} from '@/lib/radar';

const AUTO_REFRESH_MS = 5 * 60 * 1000;

type LatLngPoint = { lat: number; lng: number };

type WeatherToolProps = {
  /** Reuse the app's single global toast instead of a second one. */
  showToast: (message: string) => void;
};

function absoluteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

type LocationKey = 'near' | 'anywhere' | string;

function readBrowserLocation(): Promise<LatLngPoint | null> {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5 * 60 * 1000 }
    );
  });
}

export default function WeatherTool({ showToast }: WeatherToolProps) {
  const [timeWindow, setTimeWindow] = useState<StormWindow>('24h');
  const [selectedDay, setSelectedDay] = useState('');
  const [locationKey, setLocationKey] = useState<LocationKey>('near');
  const [radiusMiles, setRadiusMiles] = useState(readStoredNearRadiusMiles);
  const [radiusPreview, setRadiusPreview] = useState(readStoredNearRadiusMiles);
  const [editingRadius, setEditingRadius] = useState(false);
  const [activeCategories, setActiveCategories] = useState<Record<StormEventCategory, boolean>>({
    hail: true,
    wind: true,
    tornado: true,
  });

  const [reports, setReports] = useState<StormReport[]>([]);
  const [warnings, setWarnings] = useState<StormWarning[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flyTo, setFlyTo] = useState<LatLngPoint | null>(null);
  const [fitSignal, setFitSignal] = useState(0);

  const [userLocation, setUserLocation] = useState<LatLngPoint | null>(null);
  const [locating, setLocating] = useState(true);
  const [geoReady, setGeoReady] = useState(false);

  const [showDamageZones, setShowDamageZones] = useState(readStoredDamageZones);
  const [showWeatherOverlay, setShowWeatherOverlay] = useState(readStoredWeatherOverlay);

  const [radarHost, setRadarHost] = useState('');
  const [radarFrames, setRadarFrames] = useState<RadarFrame[]>([]);
  const [radarLoading, setRadarLoading] = useState(false);
  const [radarError, setRadarError] = useState<string | null>(null);

  // Tick every 30s so relative timestamps ("3m ago") stay fresh without refetching.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setClockTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const requestSeq = useRef(0);

  const loadReports = useCallback(
    async (opts?: { silent?: boolean; origin?: LatLngPoint | null }) => {
      const origin = opts?.origin !== undefined ? opts.origin : userLocation;
      if (locationKey === 'near' && !origin) return;
      const silent = opts?.silent ?? false;
      const seq = ++requestSeq.current;
      const params = new URLSearchParams();
      const day = parseStormDay(selectedDay);
      if (day) {
        params.set('day', day);
        params.set('tzOffset', String(new Date().getTimezoneOffset()));
      } else {
        params.set('window', timeWindow);
      }
      if (locationKey === 'near' && origin) {
        params.set('lat', String(origin.lat));
        params.set('lng', String(origin.lng));
        params.set('radius', String(radiusMiles));
      } else if (locationKey !== 'near' && locationKey !== 'anywhere') {
        params.set('state', locationKey);
      }
      try {
        const res = await fetch(`/api/storm-reports?${params.toString()}`, {
          cache: 'no-store',
        });
        if (seq !== requestSeq.current) return;
        if (silent) setRefreshing(true);
        else setLoading(true);
        setError(null);
        const data = (await res.json()) as StormReportsResponse & { error?: string };
        if (seq !== requestSeq.current) return;
        if (!res.ok) {
          setError(data?.error || 'Could not load storm reports');
          return;
        }
        setReports(data.reports || []);
        setWarnings(data.warnings || []);
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
    [timeWindow, selectedDay, locationKey, userLocation, radiusMiles]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loc = await readBrowserLocation();
      if (cancelled) return;
      setLocating(false);
      setGeoReady(true);
      if (loc) {
        setUserLocation(loc);
        setFlyTo(loc);
        setLocationKey((prev) => (prev === 'anywhere' ? prev : 'near'));
      } else {
        setLocationKey((prev) => (prev === 'near' ? 'anywhere' : prev));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    writeStoredWeatherOverlay(showWeatherOverlay);
  }, [showWeatherOverlay]);

  useEffect(() => {
    writeStoredDamageZones(showDamageZones);
  }, [showDamageZones]);

  useEffect(() => {
    if (!geoReady) return;
    if (locationKey === 'near' && !userLocation) return;
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      await loadReports();
    })();
    return () => {
      cancelled = true;
    };
  }, [geoReady, loadReports, locationKey, userLocation]);

  useEffect(() => {
    if (!autoRefresh || selectedDay || !isLiveStormWindow(timeWindow)) return;
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void loadReports({ silent: true });
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [autoRefresh, loadReports, timeWindow, selectedDay]);

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

  const filteredWarnings = useMemo(
    () => warnings.filter((w) => activeCategories[w.category]),
    [warnings, activeCategories]
  );

  // Official NWS warning polygons when the feed has them (Recon's yellow
  // outlines). Clustered LSRs fill in categories that had no warning.
  const damageZoneClusters = useMemo(
    () => mergeDamageZones(filteredReports, filteredWarnings),
    [filteredReports, filteredWarnings]
  );

  const listReports = useMemo(() => {
    const withDistance = filteredReports.map((r) => ({
      report: r,
      distanceMiles: userLocation ? haversineMiles(userLocation, r) : null,
    }));
    return withDistance.sort((a, b) => {
      if (locationKey === 'near' && a.distanceMiles != null && b.distanceMiles != null) {
        const byDist = a.distanceMiles - b.distanceMiles;
        if (byDist !== 0) return byDist;
      }
      return b.report.validTime.localeCompare(a.report.validTime);
    });
  }, [filteredReports, userLocation, locationKey]);

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

  const goToMyLocation = useCallback(async () => {
    setLocating(true);
    const loc = await readBrowserLocation();
    setLocating(false);
    if (!loc) {
      showToast('Could not get your location — check permissions');
      return;
    }
    setUserLocation(loc);
    setFlyTo(loc);
    setLocationKey('near');
  }, [showToast]);

  const onLocationChange = (value: string) => {
    if (value === 'near') {
      if (userLocation) {
        setLocationKey('near');
        setFlyTo(userLocation);
      } else {
        void goToMyLocation();
      }
      return;
    }
    setEditingRadius(false);
    setLocationKey(value);
  };

  const startChangeDistance = () => {
    if (!userLocation) {
      void goToMyLocation();
      return;
    }
    setRadiusPreview(radiusMiles);
    setEditingRadius(true);
    setFlyTo(userLocation);
  };

  const saveDistance = () => {
    setRadiusMiles(radiusPreview);
    writeStoredNearRadiusMiles(radiusPreview);
    setEditingRadius(false);
  };

  const lastUpdatedLabel = fetchedAt ? `Updated ${relativeTimeFrom(fetchedAt)}` : null;

  const radarSeq = useRef(0);
  const loadRadarFrames = useCallback(async (opts?: { silent?: boolean }) => {
    const seq = ++radarSeq.current;
    if (!opts?.silent) setRadarLoading(true);
    setRadarError(null);
    try {
      const res = await fetch('/api/radar/frames', { cache: 'no-store' });
      if (seq !== radarSeq.current) return;
      const data = (await res.json()) as RadarFramesResponse & { error?: string };
      if (!res.ok) {
        setRadarError(data?.error || 'Could not load radar');
        return;
      }
      setRadarHost(data.host);
      setRadarFrames(data.frames || []);
    } catch {
      if (seq !== radarSeq.current) return;
      setRadarError('Could not reach the radar service — check your connection');
    } finally {
      if (seq === radarSeq.current) setRadarLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!showWeatherOverlay) return;
    void loadRadarFrames();
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void loadRadarFrames({ silent: true });
    }, RADAR_FRAMES_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [showWeatherOverlay, loadRadarFrames]);

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

      <StormTrackerView
        timeWindow={timeWindow}
        setTimeWindow={setTimeWindow}
        selectedDay={selectedDay}
        setSelectedDay={setSelectedDay}
        locationKey={locationKey}
        locating={locating}
        userLocation={userLocation}
        onLocationChange={onLocationChange}
        editingRadius={editingRadius}
        saveDistance={saveDistance}
        startChangeDistance={startChangeDistance}
        autoRefresh={autoRefresh}
        setAutoRefresh={setAutoRefresh}
        goToMyLocation={goToMyLocation}
        error={error}
        loadReports={loadReports}
        counts={counts}
        activeCategories={activeCategories}
        toggleCategory={toggleCategory}
        filteredReports={filteredReports}
        selectedId={selectedId}
        selectReport={selectReport}
        radiusPreview={radiusPreview}
        setRadiusPreview={setRadiusPreview}
        flyTo={flyTo}
        fitSignal={fitSignal}
        setFitSignal={setFitSignal}
        damageZoneClusters={damageZoneClusters}
        showDamageZones={showDamageZones}
        setShowDamageZones={setShowDamageZones}
        showWeatherOverlay={showWeatherOverlay}
        setShowWeatherOverlay={setShowWeatherOverlay}
        radarHost={radarHost}
        radarFrames={radarFrames}
        radarLoading={radarLoading}
        radarError={radarError}
        selectedReport={selectedReport}
        selectedDistance={selectedDistance}
        listReports={listReports}
        loading={loading}
      />
    </div>
  );
}

function StormTrackerView({
  timeWindow,
  setTimeWindow,
  selectedDay,
  setSelectedDay,
  locationKey,
  locating,
  userLocation,
  onLocationChange,
  editingRadius,
  saveDistance,
  startChangeDistance,
  autoRefresh,
  setAutoRefresh,
  goToMyLocation,
  error,
  loadReports,
  counts,
  activeCategories,
  toggleCategory,
  filteredReports,
  selectedId,
  selectReport,
  radiusPreview,
  setRadiusPreview,
  flyTo,
  fitSignal,
  setFitSignal,
  damageZoneClusters,
  showDamageZones,
  setShowDamageZones,
  showWeatherOverlay,
  setShowWeatherOverlay,
  radarHost,
  radarFrames,
  radarLoading,
  radarError,
  selectedReport,
  selectedDistance,
  listReports,
  loading,
}: {
  timeWindow: StormWindow;
  setTimeWindow: (w: StormWindow) => void;
  selectedDay: string;
  setSelectedDay: (v: string) => void;
  locationKey: LocationKey;
  locating: boolean;
  userLocation: LatLngPoint | null;
  onLocationChange: (value: string) => void;
  editingRadius: boolean;
  saveDistance: () => void;
  startChangeDistance: () => void;
  autoRefresh: boolean;
  setAutoRefresh: (fn: (v: boolean) => boolean) => void;
  goToMyLocation: () => void;
  error: string | null;
  loadReports: () => Promise<void>;
  counts: Record<StormEventCategory, number>;
  activeCategories: Record<StormEventCategory, boolean>;
  toggleCategory: (cat: StormEventCategory) => void;
  filteredReports: StormReport[];
  selectedId: string | null;
  selectReport: (id: string) => void;
  radiusPreview: number;
  setRadiusPreview: (n: number) => void;
  flyTo: LatLngPoint | null;
  fitSignal: number;
  setFitSignal: (fn: (n: number) => number) => void;
  damageZoneClusters: ReturnType<typeof mergeDamageZones>;
  showDamageZones: boolean;
  setShowDamageZones: (fn: (v: boolean) => boolean) => void;
  showWeatherOverlay: boolean;
  setShowWeatherOverlay: (fn: (v: boolean) => boolean) => void;
  radarHost: string;
  radarFrames: RadarFrame[];
  radarLoading: boolean;
  radarError: string | null;
  selectedReport: StormReport | null;
  selectedDistance: number | null;
  listReports: Array<{ report: StormReport; distanceMiles: number | null }>;
  loading: boolean;
}) {
  return (
    <>
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
          <select
            aria-label="Time range"
            value={selectedDay ? 'day' : timeWindow}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'day') return;
              setSelectedDay('');
              setTimeWindow(v as StormWindow);
            }}
            className="rounded-2xl border border-zinc-200 px-4 py-2.5 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-300"
          >
            {selectedDay ? (
              <option value="day">{formatStormDayLabel(selectedDay)}</option>
            ) : null}
            {STORM_WINDOWS.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>

          <input
            type="date"
            aria-label="Calendar day"
            value={selectedDay}
            min={stormDayMinValue()}
            max={localDateInputValue()}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) {
                setSelectedDay('');
                return;
              }
              const parsed = parseStormDay(v);
              if (parsed) setSelectedDay(parsed);
            }}
            className="rounded-2xl border border-zinc-200 px-4 py-2.5 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-300"
          />

          <select
            value={locationKey}
            onChange={(e) => onLocationChange(e.target.value)}
            className="rounded-2xl border border-zinc-200 px-4 py-2.5 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-300"
          >
            <option value="near" disabled={!userLocation && locating}>
              {locating && !userLocation ? 'Finding you…' : 'Near me'}
            </option>
            <option value="anywhere">Anywhere</option>
            {US_STATES.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>

          {locationKey === 'near' ? (
            editingRadius ? (
              <button
                type="button"
                onClick={saveDistance}
                className="btn-primary px-4 py-2.5 rounded-2xl text-sm font-semibold whitespace-nowrap"
              >
                Save distance
              </button>
            ) : (
              <button
                type="button"
                onClick={startChangeDistance}
                disabled={locating}
                className="px-4 py-2.5 rounded-2xl text-sm font-semibold border border-zinc-200 text-zinc-800 whitespace-nowrap disabled:opacity-50"
              >
                Change distance
              </button>
            )
          ) : null}

          <div className="flex-1" />

          {isLiveStormWindow(timeWindow) && !selectedDay && (
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
          )}

          <button
            type="button"
            onClick={() => void goToMyLocation()}
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
        nearRadiusMiles={locationKey === 'near' && editingRadius ? radiusPreview : null}
        onNearRadiusChange={(miles) => {
          setRadiusPreview(miles);
        }}
        center={flyTo}
        fitSignal={fitSignal}
        clusters={damageZoneClusters}
        showDamageZones={showDamageZones}
        showWeatherOverlay={showWeatherOverlay}
        radarHost={radarHost}
        radarFrames={radarFrames}
        className="mb-3"
      />

      <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => setShowWeatherOverlay((v) => !v)}
            className={`px-3.5 py-2 rounded-xl text-xs font-medium border transition-colors ${
              showWeatherOverlay
                ? 'border-[var(--accent-blue)] bg-[var(--accent-blue-soft)] text-[var(--accent-blue-ink)]'
                : 'border-zinc-200 text-zinc-500'
            }`}
          >
            Weather overlay {showWeatherOverlay ? 'on' : 'off'}
            {radarLoading && showWeatherOverlay ? ' · loading…' : ''}
          </button>
          {showWeatherOverlay && radarError ? (
            <span className="text-xs text-red-600">{radarError}</span>
          ) : null}
          <button
            type="button"
            onClick={() => setShowDamageZones((v) => !v)}
            disabled={damageZoneClusters.length === 0}
            className={`px-3.5 py-2 rounded-xl text-xs font-medium border transition-colors disabled:opacity-40 ${
              showDamageZones
                ? 'border-danger/40 bg-[var(--danger-soft)] text-danger'
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
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setFitSignal((n) => n + 1)}
          disabled={filteredReports.length === 0}
          className="text-xs font-medium text-zinc-600 hover:text-zinc-900 disabled:opacity-30"
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
              No hail, wind, or tornado reports
              {locationKey === 'near' ? ' near you' : locationKey === 'anywhere' ? '' : ` in ${locationKey}`}
              {selectedDay
                ? ` on ${formatStormDayLabel(selectedDay)}`
                : ' in this window'}
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
    </>
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
          className="text-xs font-medium text-zinc-600 hover:text-zinc-900 shrink-0"
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
