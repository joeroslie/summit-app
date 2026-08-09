'use client';

import { useEffect, useMemo, useState } from 'react';
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';
import {
  eventOccursOnDay,
  formatEventTimeLabel,
  minutesFromMidnight,
  type SummitCalendarEvent,
} from '@/lib/summit-calendar';
import { isActiveSummitTask, type SummitTask } from '@/lib/google-tasks';
import {
  localDateKey,
  type CanvassPin,
  type TallyEntry,
  type TallyType,
} from '@/lib/canvassing';
import {
  eventStyle,
  formatMagnitude,
  relativeTimeFrom,
  type StormReport,
  type StormReportsResponse,
} from '@/lib/weather';
import { severityForReport } from '@/lib/storm-clusters';

const PINS_STORAGE_KEY = 'summitCanvassPins';
const TALLIES_STORAGE_KEY = 'summitCanvassTallies';

function loadLocalArray<T>(key: string): T[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Local YYYY-MM-DD, matching the calendar's own day-boundary logic. */
function toLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export type HomeStageStat = {
  stage: string;
  count: number;
  value: number;
  active: boolean;
  cardClass: string;
  ringClass: string;
  dashClass: string;
};

export type HomeRecentLead = {
  id: number;
  name: string;
  address: string;
  jobNumber: string;
  stageLabel: string;
  stageBadgeClass: string;
};

type HomeDashboardProps = {
  greeting: string;
  firstName: string;
  stageStats: HomeStageStat[];
  totalPipelineValue: number;
  totalActiveLeads: number;
  estimatesCount: number;
  recentLead: HomeRecentLead | null;
  calendarEvents: SummitCalendarEvent[];
  gcalConnected: boolean;
  tasks: SummitTask[];
  onSelectStage: (stage: string) => void;
  onCreateLead: () => void;
  onOpenCalendar: () => void;
  onOpenTasks: () => void;
  onOpenLead: (id: number) => void;
  onOpenCanvassing: () => void;
  onOpenWeather: () => void;
};

type GlimpseCardProps = {
  title: string;
  onOpen: () => void;
  children: React.ReactNode;
  accentClass?: string;
};

function GlimpseCard({ title, onOpen, children, accentClass }: GlimpseCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onOpen();
      }}
      className={`group bg-white border border-zinc-200/80 hover:border-zinc-300 hover:shadow-md hover:-translate-y-0.5 rounded-3xl p-5 sm:p-6 cursor-pointer transition-all duration-200 ${
        accentClass || ''
      }`}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="text-base font-semibold text-zinc-900">{title}</div>
        <span className="text-zinc-300 group-hover:text-zinc-500 transition-colors text-lg leading-none">
          →
        </span>
      </div>
      {children}
    </div>
  );
}

export default function HomeDashboard({
  greeting,
  firstName,
  stageStats,
  totalPipelineValue,
  totalActiveLeads,
  estimatesCount,
  recentLead,
  calendarEvents,
  gcalConnected,
  tasks,
  onSelectStage,
  onCreateLead,
  onOpenCalendar,
  onOpenTasks,
  onOpenLead,
  onOpenCanvassing,
  onOpenWeather,
}: HomeDashboardProps) {
  // --- Today's schedule (reuses the calendar's own day/time helpers) ---
  const { todaysEvents, todaysEventsTotal } = useMemo(() => {
    const todayIso = toLocalIsoDate(new Date());
    const all = (calendarEvents || []).filter(
      (e) =>
        e &&
        typeof e.startDate === 'string' &&
        (gcalConnected || e.source !== 'google') &&
        eventOccursOnDay(e, todayIso)
    );
    const sorted = [...all].sort((a, b) => {
      const am = a.allDay || !a.startTime ? -1 : minutesFromMidnight(a.startTime);
      const bm = b.allDay || !b.startTime ? -1 : minutesFromMidnight(b.startTime);
      return am - bm;
    });
    return { todaysEvents: sorted.slice(0, 3), todaysEventsTotal: sorted.length };
  }, [calendarEvents, gcalConnected]);

  // --- Open tasks needing attention ---
  const { openTasksCount, urgentTasks } = useMemo(() => {
    const todayIso = toLocalIsoDate(new Date());
    const open = (tasks || []).filter(
      (t) =>
        t &&
        typeof t.title === 'string' &&
        isActiveSummitTask(t) &&
        !t.completed &&
        (gcalConnected || t.source !== 'google')
    );
    const withDueDate = open
      .filter((t) => Boolean(t.dueDate))
      .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : a.dueDate! > b.dueDate! ? 1 : 0));
    const urgent = withDueDate.slice(0, 2).map((t) => {
      const overdue = t.dueDate! < todayIso;
      const dueToday = t.dueDate === todayIso;
      return {
        id: t.id,
        title: t.title,
        overdue,
        dueLabel: overdue ? 'Overdue' : dueToday ? 'Due today' : `Due ${formatShortDate(t.dueDate!)}`,
      };
    });
    return { openTasksCount: open.length, urgentTasks: urgent };
  }, [tasks, gcalConnected]);

  // --- Live storm alert (self-fetched, mirrors WeatherTool's fetch pattern) ---
  const [stormReports, setStormReports] = useState<StormReport[]>([]);
  const [stormStatus, setStormStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/storm-reports?window=24h&state=AZ', {
          cache: 'no-store',
        });
        const data = (await res.json()) as StormReportsResponse & { error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setStormStatus('error');
          return;
        }
        setStormReports(data.reports || []);
        setStormStatus('ready');
      } catch {
        if (!cancelled) setStormStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const severeReports = useMemo(
    () =>
      stormReports
        .filter((r) => severityForReport(r) !== 'marginal')
        .sort((a, b) => new Date(b.validTime).getTime() - new Date(a.validTime).getTime()),
    [stormReports]
  );
  const topSevere = severeReports[0] ?? null;

  const stormCounts = useMemo(() => {
    let hail = 0;
    let wind = 0;
    let tornado = 0;
    for (const r of stormReports) {
      if (r.category === 'hail') hail += 1;
      else if (r.category === 'wind') wind += 1;
      else if (r.category === 'tornado') tornado += 1;
    }
    return { hail, wind, tornado, total: stormReports.length };
  }, [stormReports]);

  // --- Canvassing tally (self-fetched, mirrors CanvassingTool's load + today stats) ---
  const [canvassStats, setCanvassStats] = useState<Record<TallyType, number> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = getSupabase();
      const supabaseEnabled = isSupabaseConfigured() && supabase != null;
      let pins: CanvassPin[] = [];
      let tallies: TallyEntry[] = [];
      if (supabaseEnabled && supabase) {
        const [pinsRes, talliesRes] = await Promise.all([
          supabase.from('canvass_pins').select('*'),
          supabase.from('canvass_tallies').select('*'),
        ]);
        pins = pinsRes.error
          ? loadLocalArray<CanvassPin>(PINS_STORAGE_KEY)
          : ((pinsRes.data || []) as CanvassPin[]);
        tallies = talliesRes.error
          ? loadLocalArray<TallyEntry>(TALLIES_STORAGE_KEY)
          : ((talliesRes.data || []) as TallyEntry[]);
      } else {
        pins = loadLocalArray<CanvassPin>(PINS_STORAGE_KEY);
        tallies = loadLocalArray<TallyEntry>(TALLIES_STORAGE_KEY);
      }
      if (cancelled) return;
      const todayKey = localDateKey();
      const doorsAuto = pins.filter((p) => localDateKey(p.created_at) === todayKey).length;
      const conversationsAuto = pins.filter(
        (p) =>
          localDateKey(p.status_changed_at) === todayKey &&
          p.disposition !== 'not_contacted' &&
          p.disposition !== 'not_home'
      ).length;
      const signedAuto = pins.filter(
        (p) => localDateKey(p.status_changed_at) === todayKey && p.disposition === 'signed'
      ).length;
      const manualCount = (type: TallyType) =>
        tallies.filter((t) => t.type === type && localDateKey(t.created_at) === todayKey).length;
      setCanvassStats({
        door: doorsAuto + manualCount('door'),
        conversation: conversationsAuto + manualCount('conversation'),
        signed: signedAuto + manualCount('signed'),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="pb-8 w-full">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-5 mb-8">
        <div className="text-4xl sm:text-5xl font-bold tracking-tighter text-zinc-900">
          {greeting}, {firstName}
        </div>
        <button
          type="button"
          onClick={onCreateLead}
          className="btn-primary px-6 py-3 rounded-3xl font-medium shrink-0"
        >
          New Lead
        </button>
      </div>

      {/* Pipeline snapshot — the visual anchor of the page */}
      <div className="rounded-3xl border border-zinc-200 bg-white p-6 sm:p-8 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-5 mb-6">
          <div>
            <div className="text-xs uppercase tracking-widest text-zinc-400 font-medium">
              Pipeline value
            </div>
            <div className="text-4xl sm:text-5xl font-bold tabular-nums text-zinc-900 mt-1">
              ${totalPipelineValue.toLocaleString()}
            </div>
          </div>
          <div className="flex items-center gap-6">
            <div>
              <div className="text-2xl font-semibold tabular-nums text-zinc-900">
                {totalActiveLeads}
              </div>
              <div className="text-xs text-zinc-400">
                active job{totalActiveLeads === 1 ? '' : 's'}
              </div>
            </div>
            <div>
              <div className="text-2xl font-semibold tabular-nums text-zinc-900">
                {estimatesCount}
              </div>
              <div className="text-xs text-zinc-400">
                estimate{estimatesCount === 1 ? '' : 's'} on file
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
          {stageStats.map((s) => (
            <button
              key={s.stage}
              type="button"
              onClick={() => onSelectStage(s.stage)}
              className={`rounded-3xl border p-4 sm:p-5 text-center transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${
                s.active
                  ? `border-zinc-800 ring-2 ${s.ringClass} shadow-sm`
                  : s.cardClass
              }`}
              title={`View ${s.stage} leads`}
            >
              <div className="flex items-center justify-center gap-1.5 mb-2">
                <span
                  className={`w-2.5 h-2.5 rounded-full shrink-0 shadow-sm ring-2 ring-white ${s.dashClass}`}
                  aria-hidden
                />
                <div className="text-[10px] sm:text-xs font-medium uppercase tracking-wide text-zinc-500">
                  {s.stage}
                </div>
              </div>
              <div className="text-3xl sm:text-4xl font-semibold tabular-nums tracking-tight text-zinc-900">
                {s.count}
              </div>
              <div className="text-xs font-semibold text-zinc-600 mt-1 tabular-nums">
                ${s.value.toLocaleString()}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Live storm watch — stands out via space + sky chrome, not a red alarm box */}
      <div
        role="button"
        tabIndex={0}
        onClick={onOpenWeather}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          onOpenWeather();
        }}
        className={`group rounded-3xl border p-7 sm:p-9 cursor-pointer transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md mb-6 ${
          topSevere
            ? 'border-danger/40 bg-[var(--danger-soft)]'
            : 'border-zinc-200/80 bg-white hover:border-zinc-300'
        }`}
      >
        <div className="flex items-start justify-between gap-5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-3">
              {topSevere && (
                <span className="w-2 h-2 rounded-full bg-danger animate-pulse shrink-0" />
              )}
              <span
                className={`text-xs font-semibold uppercase tracking-widest ${
                  topSevere ? 'text-danger' : 'text-zinc-400'
                }`}
              >
                {topSevere ? 'Active storm alert' : 'Storm watch'}
              </span>
            </div>

            {stormStatus === 'loading' ? (
              <div className="h-7 w-56 max-w-full bg-zinc-100 rounded-lg animate-pulse" />
            ) : stormStatus === 'error' ? (
              <div className="text-lg font-medium text-zinc-500">
                Storm data unavailable right now
              </div>
            ) : topSevere ? (
              <>
                <div className="text-xl sm:text-2xl font-semibold text-zinc-900">
                  {eventStyle(topSevere.category).label}
                  {formatMagnitude(topSevere) ? ` · ${formatMagnitude(topSevere)}` : ''} near{' '}
                  {topSevere.locDesc || topSevere.state || 'your area'}
                </div>
                <div className="text-sm text-zinc-500 mt-1.5">
                  {relativeTimeFrom(topSevere.validTime)}
                  {severeReports.length > 1
                    ? ` · ${severeReports.length} severe reports in the last 24h`
                    : ' · last 24h'}
                </div>
              </>
            ) : (
              <div className="text-xl sm:text-2xl font-semibold text-zinc-900">
                {stormCounts.total > 0
                  ? `${stormCounts.total} report${stormCounts.total === 1 ? '' : 's'} in the last 24h`
                  : 'No active storm activity'}
              </div>
            )}

            {stormStatus === 'ready' && stormCounts.total > 0 && (
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-5 pt-5 border-t border-zinc-200/70">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-lg font-semibold tabular-nums text-zinc-900">
                    {stormCounts.hail}
                  </span>
                  <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                    Hail
                  </span>
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-lg font-semibold tabular-nums text-zinc-900">
                    {stormCounts.wind}
                  </span>
                  <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                    Wind
                  </span>
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-lg font-semibold tabular-nums text-zinc-900">
                    {stormCounts.tornado}
                  </span>
                  <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                    Tornado
                  </span>
                </div>
              </div>
            )}
          </div>
          <span className="text-zinc-300 group-hover:text-zinc-500 transition-colors text-lg leading-none shrink-0 mt-1">
            →
          </span>
        </div>
      </div>

      {/* Everything else — quick real-data glimpses, tap through for the full picture */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-5">
        <GlimpseCard title="Today's Schedule" onOpen={onOpenCalendar}>
          {todaysEvents.length === 0 ? (
            <p className="text-sm text-zinc-400">Nothing on the calendar today</p>
          ) : (
            <div className="space-y-2.5">
              {todaysEvents.map((ev) => (
                <div key={ev.id} className="flex items-center gap-3">
                  <div className="text-xs font-semibold tabular-nums text-zinc-600 bg-zinc-100 border border-zinc-200 rounded-lg px-2 py-1 shrink-0 min-w-[4.25rem] text-center">
                    {ev.allDay ? 'All day' : formatEventTimeLabel(ev)}
                  </div>
                  <div className="text-sm text-zinc-700 truncate">{ev.title}</div>
                </div>
              ))}
              {todaysEventsTotal > todaysEvents.length && (
                <div className="text-xs text-zinc-400 pt-0.5">
                  +{todaysEventsTotal - todaysEvents.length} more today
                </div>
              )}
            </div>
          )}
        </GlimpseCard>

        <GlimpseCard title="Open Tasks" onOpen={onOpenTasks}>
          {openTasksCount === 0 ? (
            <p className="text-sm text-zinc-400">No open tasks</p>
          ) : (
            <>
              <div className="text-3xl font-semibold tabular-nums text-zinc-900 mb-2.5">
                {openTasksCount}
              </div>
              <div className="space-y-1.5">
                {urgentTasks.map((t) => (
                  <div key={t.id} className="flex items-center gap-2 min-w-0">
                    <span
                      className={`text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 shrink-0 ${
                        t.overdue
                          ? 'bg-red-50 text-red-700'
                          : 'bg-amber-50 text-amber-700'
                      }`}
                    >
                      {t.dueLabel}
                    </span>
                    <span className="text-sm text-zinc-700 truncate">{t.title}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </GlimpseCard>

        <GlimpseCard
          title="Jump Back In"
          onOpen={() => recentLead && onOpenLead(recentLead.id)}
        >
          {!recentLead ? (
            <p className="text-sm text-zinc-400">No leads yet</p>
          ) : (
            <div>
              <div className="text-base font-medium text-zinc-900 truncate">
                {recentLead.name || recentLead.address || 'Unnamed lead'}
              </div>
              {recentLead.address && (
                <div className="text-sm text-zinc-500 truncate mt-0.5">
                  {recentLead.address}
                </div>
              )}
              <div className="flex items-center gap-2 mt-3">
                <span
                  className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${recentLead.stageBadgeClass}`}
                >
                  {recentLead.stageLabel}
                </span>
                {recentLead.jobNumber && (
                  <span className="text-xs text-zinc-400">{recentLead.jobNumber}</span>
                )}
              </div>
            </div>
          )}
        </GlimpseCard>

        <GlimpseCard title="Canvassing Today" onOpen={onOpenCanvassing}>
          {!canvassStats ? (
            <div className="grid grid-cols-3 gap-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-11 bg-zinc-100 rounded-xl animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <div className="text-2xl font-semibold tabular-nums text-zinc-900">
                  {canvassStats.door}
                </div>
                <div className="text-[11px] text-zinc-400 mt-0.5">Doors</div>
              </div>
              <div>
                <div className="text-2xl font-semibold tabular-nums text-stage-completed">
                  {canvassStats.conversation}
                </div>
                <div className="text-[11px] text-zinc-400 mt-0.5">Convos</div>
              </div>
              <div>
                <div className="text-2xl font-semibold tabular-nums text-stage-closed">
                  {canvassStats.signed}
                </div>
                <div className="text-[11px] text-zinc-400 mt-0.5">Signed</div>
              </div>
            </div>
          )}
        </GlimpseCard>
      </div>
    </div>
  );
}
