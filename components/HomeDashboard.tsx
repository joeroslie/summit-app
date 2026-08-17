'use client';

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';
import './stage-funnel.css';
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
  readStoredNearRadiusMiles,
  eventStyle,
  formatMagnitude,
  newestStormReport,
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
  totalJobs: number;
  pipelineValue: number;
  recentLead: HomeRecentLead | null;
  calendarEvents: SummitCalendarEvent[];
  gcalConnected: boolean;
  tasks: SummitTask[];
  onSelectStage: (stage: string) => void;
  onCreateLead: () => void;
  onOpenPipeline: () => void;
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
  className?: string;
  /** Featured = full glass (resume + tasks). Quiet = flatter metric tiles. */
  quiet?: boolean;
};

function GlimpseCard({
  title,
  onOpen,
  children,
  className,
  quiet,
}: GlimpseCardProps) {
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
      className={
        quiet
          ? `group glass-quiet rounded-[24px] p-4 cursor-pointer ${className || ''}`
          : `group glass glass-hover rounded-[32px] p-5 sm:p-6 cursor-pointer ${className || ''}`
      }
    >
      <div
        className={`flex items-center justify-between ${quiet ? 'mb-3' : 'mb-4'}`}
      >
        <div
          className={
            quiet
              ? 'text-sm font-medium text-zinc-500'
              : 'text-base font-semibold text-zinc-900'
          }
        >
          {title}
        </div>
        <span
          className={`text-zinc-400 group-hover:text-[var(--accent-blue)] transition-colors leading-none ${
            quiet ? 'text-base' : 'text-lg'
          }`}
        >
          →
        </span>
      </div>
      {children}
    </div>
  );
}

/**
 * Stage mix — proportional bar plus count chips.
 * Desktop: one row; hover/focus swaps the chip for that stage's $.
 * Phone: 3-col count grid, no prices.
 */
function StageBar({
  stageStats,
  total,
  className,
}: {
  stageStats: HomeStageStat[];
  total: number;
  className: string;
}) {
  return (
    <div
      className={`stage-funnel-fill flex w-full gap-1 rounded-full overflow-hidden bg-black/[0.05] ${className}`}
    >
      {stageStats.map((s, i) => (
        <div
          key={s.stage}
          className={`funnel-seg ${s.dashClass} rounded-full`}
          data-stage={s.stage}
          style={
            {
              flex: `${total === 0 ? 1 : Math.max(s.count, 0.4)} 0 0%`,
              '--funnel-i': i,
            } as CSSProperties
          }
          aria-hidden
        />
      ))}
    </div>
  );
}

function StageFunnel({
  stageStats,
  onSelectStage,
  embedded,
}: {
  stageStats: HomeStageStat[];
  onSelectStage: (stage: string) => void;
  embedded?: boolean;
}) {
  const total = stageStats.reduce((sum, s) => sum + s.count, 0);
  return (
    <div className={embedded ? '' : 'mt-6 pt-6 border-t border-[var(--glass-border)]'}>
      <div className="sm:hidden">
        <StageBar stageStats={stageStats} total={total} className="h-1.5" />
        <div className="grid grid-cols-3 gap-x-1 gap-y-1.5 mt-2.5">
          {stageStats.map((s) => (
            <button
              key={s.stage}
              type="button"
              onClick={() => onSelectStage(s.stage)}
              className={`min-h-11 py-1 px-0.5 text-center rounded-2xl ${
                s.active ? 'bg-[var(--accent-blue-soft)]' : ''
              }`}
              data-stage={s.stage}
              title={`View ${s.stage} leads`}
            >
              <span className="block text-2xl font-extrabold tabular-nums tracking-tight leading-none text-zinc-900">
                {s.count}
              </span>
              <span className="mt-1 flex items-center justify-center gap-1 min-w-0">
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 border border-[var(--dot-ring)] ${s.dashClass}`}
                  aria-hidden
                />
                <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 leading-tight">
                  {s.stage}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="hidden sm:block">
        <StageBar
          stageStats={stageStats}
          total={total}
          className={embedded ? 'h-4' : 'h-2.5'}
        />
        <div
          className={
            embedded
              ? 'stage-funnel-chips is-tight flex flex-nowrap gap-0.5 mt-3'
              : 'stage-funnel-chips flex flex-wrap gap-2 mt-4'
          }
        >
          {stageStats.map((s) => (
            <button
              key={s.stage}
              type="button"
              onClick={() => onSelectStage(s.stage)}
              className={
                embedded
                  ? `inline-flex flex-1 min-w-0 items-center justify-center gap-1 rounded-full px-1 py-1.5 transition-colors ${
                      s.active ? 'bg-[var(--accent-blue-soft)]' : 'hover:bg-black/[0.04]'
                    }`
                  : `inline-flex items-center gap-2 rounded-full pl-2.5 pr-3.5 py-1.5 transition-colors ${
                      s.active ? 'bg-[var(--accent-blue-soft)]' : 'hover:bg-black/[0.04]'
                    }`
              }
              data-stage={s.stage}
              data-active={s.active ? 'true' : undefined}
              title={
                s.value > 0
                  ? `View ${s.stage} leads · $${s.value.toLocaleString()}`
                  : `View ${s.stage} leads`
              }
            >
              <span className="funnel-meta inline-flex min-w-0 items-center justify-center gap-1">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 border border-[var(--dot-ring)] ${s.dashClass}`}
                  aria-hidden
                />
                <span
                  className={`text-[11px] font-medium uppercase tracking-wide text-zinc-500 ${
                    embedded ? 'truncate' : ''
                  }`}
                >
                  {s.stage}
                </span>
                <span className="text-xs font-semibold tabular-nums text-zinc-900 shrink-0">
                  {s.count}
                </span>
              </span>
              <span className="funnel-value text-[11px] font-semibold tabular-nums text-[var(--graphite)]">
                ${s.value.toLocaleString()}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

type ListedHomeTask = {
  id: string;
  title: string;
  overdue: boolean;
  dueLabel: string | null;
};

function HomeStormBlock({
  activeSevere,
  stormStatus,
  latestReport,
  stormCounts,
  onOpenWeather,
  className,
}: {
  activeSevere: boolean;
  stormStatus: 'loading' | 'ready' | 'error';
  latestReport: StormReport | undefined;
  stormCounts: { hail: number; wind: number; tornado: number; last24h: number };
  onOpenWeather: () => void;
  className?: string;
}) {
  const tint = activeSevere ? 'glass-tint-coral' : 'glass-tint-blue';
  const extra = className ? ` ${className}` : '';
  const pipOn = activeSevere ? 'bg-danger' : 'bg-[var(--accent-blue)]';
  const kickerOn = activeSevere ? 'text-danger' : 'text-[var(--accent-blue)]';
  const countItems = [
    { n: stormCounts.hail, label: 'Hail' },
    { n: stormCounts.wind, label: 'Wind' },
    { n: stormCounts.tornado, label: 'Tornado' },
  ];
  const showCounts = stormStatus === 'ready' && stormCounts.last24h > 0;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpenWeather}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onOpenWeather();
      }}
      className={`group glass glass-hover rounded-[32px] p-5 sm:p-6 mb-4 cursor-pointer min-h-[9.5rem] ${tint}${extra}`}
    >
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`st-pip w-2 h-2 rounded-full shrink-0 ${pipOn}`} />
          <span className={`st-kicker text-[11px] font-semibold uppercase tracking-widest ${kickerOn}`}>
            {activeSevere ? 'Storm alert' : 'Storm watch'}
          </span>
        </div>
        <span className="st-arrow text-zinc-400 group-hover:text-[var(--accent-blue)] transition-colors text-lg leading-none shrink-0">
          →
        </span>
      </div>
      <div className="st-line text-base sm:text-lg font-medium text-zinc-900">
        <StormLine stormStatus={stormStatus} latestReport={latestReport} />
      </div>
      {showCounts && (
        <div className="st-counts flex flex-wrap gap-2.5 mt-5">
          {countItems.map((i) => (
            <span
              key={i.label}
              className={`st-chip inline-flex items-baseline gap-1.5 rounded-full px-3.5 py-1.5 ${
                i.n > 0 ? 'st-hot bg-[var(--danger-soft)]' : 'bg-black/[0.04]'
              }`}
            >
              <span className="st-count text-sm font-semibold tabular-nums text-zinc-900">{i.n}</span>
              <span className="st-label text-[0.75rem] font-medium uppercase tracking-[0.08em] text-[var(--steel)]">
                {i.label}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function StormLine({
  stormStatus,
  latestReport,
}: {
  stormStatus: 'loading' | 'ready' | 'error';
  latestReport: StormReport | undefined;
}) {
  if (stormStatus === 'loading') {
    return <span className="inline-block h-5 w-48 bg-black/[0.05] rounded-full animate-pulse align-middle" />;
  }
  if (stormStatus === 'error') return 'Storm data unavailable right now';
  if (!latestReport) return 'No storms in your radius';
  return (
    <>
      {eventStyle(latestReport.category).label}
      {formatMagnitude(latestReport) ? ` · ${formatMagnitude(latestReport)}` : ''} near{' '}
      {latestReport.locDesc || latestReport.state || 'your area'}
      <span className="text-zinc-400 font-normal">
        {' '}
        · {relativeTimeFrom(latestReport.validTime)}
      </span>
    </>
  );
}

function HomeStageTiles({
  stageStats,
  onSelectStage,
  onInk,
}: {
  stageStats: HomeStageStat[];
  onSelectStage: (stage: string) => void;
  onInk?: boolean;
}) {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
      {stageStats.map((s) => (
        <button
          key={s.stage}
          type="button"
          onClick={() => onSelectStage(s.stage)}
          className={
            onInk
              ? 'rounded-[24px] px-2 py-4 text-center bg-white/10 hover:bg-white/15 transition-colors'
              : 'rounded-[24px] px-2 py-4 text-center glass hover:bg-white/50 transition-colors'
          }
        >
          <span className={`mx-auto mb-2 block h-1 w-8 rounded-full ${s.dashClass}`} />
          <div
            className={`text-xl font-extrabold tabular-nums tracking-tight ${
              onInk ? 'text-[var(--metal-ink)]' : 'text-zinc-900'
            }`}
          >
            {s.count}
          </div>
          <div
            className={`text-[11px] font-medium uppercase tracking-wide mt-1 ${
              onInk ? 'text-[var(--metal-ink)] opacity-60' : 'text-zinc-500'
            }`}
          >
            {s.stage}
          </div>
        </button>
      ))}
    </div>
  );
}

function HomeLeadPeak({
  recentLead,
  onOpenLead,
}: {
  recentLead: HomeRecentLead | null;
  onOpenLead: (id: number) => void;
}) {
  const canOpen = Boolean(recentLead);
  return (
    <div
      role={canOpen ? 'button' : undefined}
      tabIndex={canOpen ? 0 : undefined}
      onClick={() => recentLead && onOpenLead(recentLead.id)}
      onKeyDown={(e) => {
        if (!recentLead) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onOpenLead(recentLead.id);
      }}
      className={`group glass rounded-[32px] p-5 sm:p-6 mb-4 ${
        canOpen ? 'glass-hover cursor-pointer' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="text-base font-semibold text-zinc-900">Jump Back In</div>
        {canOpen && (
          <span className="text-zinc-400 group-hover:text-[var(--accent-blue)] transition-colors text-lg leading-none shrink-0">
            →
          </span>
        )}
      </div>
      {!recentLead ? (
        <p className="text-sm text-zinc-400">No leads yet</p>
      ) : (
        <div>
          <div className="text-[1.875rem] font-extrabold tracking-tight leading-[1.15] text-zinc-900">
            {recentLead.name || recentLead.address || 'Unnamed lead'}
          </div>
          {recentLead.address && recentLead.name && (
            <div className="text-base text-zinc-500 mt-3 truncate">
              {recentLead.address}
            </div>
          )}
          <div className="flex items-center gap-2 mt-4">
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
    </div>
  );
}

function HomeGlimpseGrid({
  recentLead,
  canvassStats,
  todaysEvents,
  todaysEventsTotal,
  openTasksCount,
  listedTasks,
  onOpenLead,
  onOpenCanvassing,
  onOpenCalendar,
  onOpenTasks,
  stacked,
  omitJump,
}: {
  recentLead: HomeRecentLead | null;
  canvassStats: { door: number; conversation: number; signed: number } | null;
  todaysEvents: SummitCalendarEvent[];
  todaysEventsTotal: number;
  openTasksCount: number;
  listedTasks: ListedHomeTask[];
  onOpenLead: (id: number) => void;
  onOpenCanvassing: () => void;
  onOpenCalendar: () => void;
  onOpenTasks: () => void;
  stacked?: boolean;
  omitJump?: boolean;
}) {
  return (
    <div
      className={
        stacked
          ? 'flex flex-col gap-3'
          : 'grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 items-start'
      }
    >
      {!omitJump && (
      <GlimpseCard
        title="Jump Back In"
        onOpen={() => recentLead && onOpenLead(recentLead.id)}
        className={stacked ? '' : 'sm:col-span-2'}
      >
        {!recentLead ? (
          <p className="text-sm text-zinc-400">No leads yet</p>
        ) : (
          <div>
            <div className="text-base font-medium text-zinc-900 truncate">
              {recentLead.name || recentLead.address || 'Unnamed lead'}
            </div>
            {recentLead.address && (
              <div className="text-sm text-zinc-500 truncate mt-0.5">{recentLead.address}</div>
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
      )}

      <div
        role="button"
        tabIndex={0}
        onClick={onOpenCanvassing}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          onOpenCanvassing();
        }}
        className="group glass-quiet rounded-[24px] cursor-pointer p-5"
      >
        <div className="flex items-center justify-between mb-3">
          <div className="text-base font-semibold text-[var(--graphite)]">Canvassing Today</div>
          <span className="text-zinc-400 group-hover:text-[var(--accent-blue)] transition-colors leading-none text-base">
            →
          </span>
        </div>
        {!canvassStats ? (
          <div className="grid grid-cols-3 gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 bg-black/[0.04] rounded-xl animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <div className="text-[2.34375rem] font-extrabold tabular-nums tracking-tight leading-none text-zinc-900">
                {canvassStats.door}
              </div>
              <div className="text-[11px] text-zinc-400 mt-1.5">Doors</div>
            </div>
            <div>
              <div className="text-[2.34375rem] font-extrabold tabular-nums tracking-tight leading-none text-zinc-900">
                {canvassStats.conversation}
              </div>
              <div className="text-[11px] text-zinc-400 mt-1.5">Convos</div>
            </div>
            <div>
              <div className="text-[2.34375rem] font-extrabold tabular-nums tracking-tight leading-none text-[var(--accent-green)]">
                {canvassStats.signed}
              </div>
              <div className="text-[11px] text-zinc-400 mt-1.5">Signed</div>
            </div>
          </div>
        )}
      </div>

      <GlimpseCard title="Today's Schedule" onOpen={onOpenCalendar} quiet>
        {todaysEvents.length === 0 ? (
          <p className="text-sm text-zinc-400">Nothing on the calendar today</p>
        ) : (
          <div className="space-y-2.5">
            {todaysEvents.map((ev) => (
              <div key={ev.id} className="flex items-center gap-3">
                <div className="text-xs font-semibold tabular-nums text-zinc-600 bg-black/[0.04] border border-black/[0.06] rounded-full px-2.5 py-1 shrink-0 min-w-[4.25rem] text-center">
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

      <GlimpseCard title="Open Tasks" onOpen={onOpenTasks} className={stacked || omitJump ? '' : 'sm:col-span-2'}>
        {openTasksCount === 0 ? (
          <p className="text-sm text-zinc-400">No open tasks</p>
        ) : (
          <div className="flex items-start gap-5">
            <div className="text-3xl font-semibold tabular-nums text-zinc-900 shrink-0">
              {openTasksCount}
            </div>
            <div className="space-y-1.5 min-w-0 flex-1 pt-1">
              {listedTasks.map((t) => (
                <div key={t.id} className="flex items-center gap-2 min-w-0">
                  {t.dueLabel && (
                    <span
                      className={`text-xs font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 shrink-0 ${
                        t.overdue
                          ? 'bg-[var(--danger-soft)] text-danger'
                          : 'bg-black/[0.04] text-zinc-500'
                      }`}
                    >
                      {t.dueLabel}
                    </span>
                  )}
                  <span className="text-sm text-zinc-700 truncate">{t.title}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </GlimpseCard>
    </div>
  );
}

export default function HomeDashboard({
  greeting,
  firstName,
  stageStats,
  totalJobs,
  pipelineValue,
  recentLead,
  calendarEvents,
  gcalConnected,
  tasks,
  onSelectStage,
  onCreateLead,
  onOpenPipeline,
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
    return { todaysEvents: sorted.slice(0, 5), todaysEventsTotal: sorted.length };
  }, [calendarEvents, gcalConnected]);

  // --- Open tasks needing attention ---
  const { openTasksCount, listedTasks } = useMemo(() => {
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
    const withoutDue = open.filter((t) => !t.dueDate);
    const listed = [...withDueDate, ...withoutDue].slice(0, 4).map((t) => {
      if (!t.dueDate) {
        return { id: t.id, title: t.title, overdue: false, dueLabel: null as string | null };
      }
      const overdue = t.dueDate < todayIso;
      const dueToday = t.dueDate === todayIso;
      return {
        id: t.id,
        title: t.title,
        overdue,
        dueLabel: overdue
          ? 'Overdue'
          : dueToday
            ? 'Due today'
            : `Due ${formatShortDate(t.dueDate)}`,
      };
    });
    return { openTasksCount: open.length, listedTasks: listed };
  }, [tasks, gcalConnected]);

  // --- Live storm alert (self-fetched, near the device when location is allowed) ---
  const [stormReports, setStormReports] = useState<StormReport[]>([]);
  const [latestNearby, setLatestNearby] = useState<StormReport | undefined>(undefined);
  const [stormStatus, setStormStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;

    const load = async (origin: { lat: number; lng: number } | null) => {
      try {
        const params = new URLSearchParams({
          window: '24h',
          latest: '1',
        });
        if (origin) {
          params.set('lat', String(origin.lat));
          params.set('lng', String(origin.lng));
          params.set('radius', String(readStoredNearRadiusMiles()));
        } else {
          params.set('state', 'AZ');
        }
        const res = await fetch(`/api/storm-reports?${params.toString()}`, {
          cache: 'no-store',
        });
        const data = (await res.json()) as StormReportsResponse & { error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setStormStatus('error');
          return;
        }
        const reports = data.reports || [];
        setStormReports(reports);
        setLatestNearby(data.latest ?? newestStormReport(reports));
        setStormStatus('ready');
      } catch {
        if (!cancelled) setStormStatus('error');
      }
    };

    const fallbackAnywhere = () => {
      void load(null);
    };

    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      fallbackAnywhere();
      return () => {
        cancelled = true;
      };
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (cancelled) return;
        void load({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        if (!cancelled) fallbackAnywhere();
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000 }
    );

    return () => {
      cancelled = true;
    };
  }, []);

  const latestReport = latestNearby ?? newestStormReport(stormReports);

  const activeSevere = useMemo(
    () => stormReports.some((r) => severityForReport(r) !== 'marginal'),
    [stormReports]
  );

  const stormCounts = useMemo(() => {
    let hail = 0;
    let wind = 0;
    let tornado = 0;
    for (const r of stormReports) {
      if (r.category === 'hail') hail += 1;
      else if (r.category === 'wind') wind += 1;
      else if (r.category === 'tornado') tornado += 1;
    }
    return { hail, wind, tornado, last24h: stormReports.length };
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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-5 mb-6">
        <h1 className="page-title">
          {greeting}, {firstName}
        </h1>
        <button
          type="button"
          onClick={onCreateLead}
          className="btn-primary px-6 py-3 rounded-3xl font-medium shrink-0"
        >
          New Lead
        </button>
      </div>

      <HomeLeadPeak recentLead={recentLead} onOpenLead={onOpenLead} />

      {/* Storm — glass; blue/coral is a whisper tint + dot, not a painted slab. */}
      <HomeStormBlock
        activeSevere={activeSevere}
        stormStatus={stormStatus}
        latestReport={latestReport}
        stormCounts={stormCounts}
        onOpenWeather={onOpenWeather}
      />

      {/* CRM left (pipeline + tasks); today right (canvass + schedule).
          Flatten on phone so order is pipeline → canvass → schedule → tasks. */}
      <div className="flex flex-col gap-3 sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] sm:items-start sm:gap-4">
        <div className="flex flex-col gap-3 sm:gap-4 max-sm:contents">
          <div className="glass rounded-[32px] p-5 sm:p-6 order-1 sm:order-none">
            <button
              type="button"
              onClick={onOpenPipeline}
              className="group flex w-full items-center justify-between gap-4 min-h-11 mb-4"
            >
              <span className="text-base font-semibold text-zinc-900">Pipeline</span>
              <span className="text-zinc-400 group-hover:text-[var(--accent-blue)] transition-colors text-lg leading-none shrink-0">
                →
              </span>
            </button>
            <div className="sm:hidden">
              <StageBar
                stageStats={stageStats}
                total={stageStats.reduce((n, s) => n + s.count, 0)}
                className="h-4 mb-3"
              />
              <div className="flex flex-col">
                {stageStats.map((s) => (
                  <button
                    key={s.stage}
                    type="button"
                    onClick={() => onSelectStage(s.stage)}
                    className={`flex items-center justify-between gap-3 min-h-11 px-1 py-1.5 border-b border-[var(--chrome-line)] last:border-b-0 ${
                      s.active ? 'bg-[var(--accent-blue-soft)] rounded-xl border-b-transparent' : ''
                    }`}
                    data-stage={s.stage}
                    title={`View ${s.stage} leads`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.dashClass}`} aria-hidden />
                      <span className="text-sm font-medium text-[var(--graphite)] truncate">{s.stage}</span>
                    </span>
                    <span className="text-sm font-semibold tabular-nums text-[var(--graphite)]">{s.count}</span>
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 mt-4 pt-4 border-t border-[var(--glass-border)]">
                <div className="text-center px-2">
                  <div className="text-xl font-semibold tabular-nums text-zinc-900">{totalJobs}</div>
                  <div className="text-[0.6875rem] font-medium uppercase tracking-wide text-[var(--steel)] mt-0.5">
                    total jobs
                  </div>
                </div>
                <div className="text-center px-2 border-l border-[var(--glass-border)]">
                  <div className="text-xl font-semibold tabular-nums text-[var(--accent-green)]">
                    ${pipelineValue.toLocaleString()}
                  </div>
                  <div className="text-[0.6875rem] font-medium uppercase tracking-wide text-[var(--steel)] mt-0.5">
                    pipeline value
                  </div>
                </div>
              </div>
            </div>
            <div className="hidden sm:block">
              <StageFunnel stageStats={stageStats} onSelectStage={onSelectStage} embedded />
              <div className="grid grid-cols-2 border-t border-[var(--glass-border)] mt-5 pt-4">
                <div className="pr-4">
                  <div className="text-xl font-semibold tabular-nums text-zinc-900">{totalJobs}</div>
                  <div className="text-[0.6875rem] font-medium uppercase tracking-wide text-zinc-400 mt-0.5">
                    total jobs
                  </div>
                </div>
                <div className="pl-4 border-l border-[var(--glass-border)]">
                  <div className="text-xl font-semibold tabular-nums text-[var(--accent-green)]">
                    ${pipelineValue.toLocaleString()}
                  </div>
                  <div className="text-[0.6875rem] font-medium uppercase tracking-wide text-zinc-400 mt-0.5">
                    pipeline value
                  </div>
                </div>
              </div>
            </div>
          </div>

          <GlimpseCard title="Open Tasks" onOpen={onOpenTasks} className="order-4 sm:order-none">
            {openTasksCount === 0 ? (
              <p className="text-sm text-zinc-400">No open tasks</p>
            ) : (
              <div className="flex items-start gap-5">
                <div className="text-3xl font-semibold tabular-nums text-zinc-900 shrink-0">
                  {openTasksCount}
                </div>
                <div className="space-y-1.5 min-w-0 flex-1 pt-1">
                  {listedTasks.map((t) => (
                    <div key={t.id} className="flex items-center gap-2 min-w-0">
                      {t.dueLabel && (
                        <span
                          className={`text-xs font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 shrink-0 ${
                            t.overdue
                              ? 'bg-[var(--danger-soft)] text-danger'
                              : 'bg-black/[0.04] text-zinc-500'
                          }`}
                        >
                          {t.dueLabel}
                        </span>
                      )}
                      <span className="text-sm text-zinc-700 truncate">{t.title}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </GlimpseCard>
        </div>

        <div className="flex flex-col gap-3 sm:gap-4 max-sm:contents">
          <div
            role="button"
            tabIndex={0}
            onClick={onOpenCanvassing}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              onOpenCanvassing();
            }}
            className="group glass-quiet rounded-[24px] cursor-pointer p-5 order-2 sm:order-none"
          >
            <div className="flex items-center justify-between mb-3">
              <div className="text-base font-semibold tracking-tight text-[var(--graphite)]">Canvassing Today</div>
              <span className="text-zinc-400 group-hover:text-[var(--accent-blue)] transition-colors leading-none text-base">
                →
              </span>
            </div>
            {!canvassStats ? (
              <div className="grid grid-cols-3 gap-3">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-14 bg-black/[0.04] rounded-xl animate-pulse" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-3 text-center">
                <div>
                  <div className="text-[2.34375rem] font-extrabold tabular-nums tracking-tight leading-none text-zinc-900">
                    {canvassStats.door}
                  </div>
                  <div className="text-[0.75rem] font-medium uppercase tracking-[0.08em] text-[var(--steel)] mt-1.5">
                    Doors
                  </div>
                </div>
                <div>
                  <div className="text-[2.34375rem] font-extrabold tabular-nums tracking-tight leading-none text-zinc-900">
                    {canvassStats.conversation}
                  </div>
                  <div className="text-[0.75rem] font-medium uppercase tracking-[0.08em] text-[var(--steel)] mt-1.5">
                    Convos
                  </div>
                </div>
                <div>
                  <div className="text-[2.34375rem] font-extrabold tabular-nums tracking-tight leading-none text-[var(--accent-green)]">
                    {canvassStats.signed}
                  </div>
                  <div className="text-[0.75rem] font-medium uppercase tracking-[0.08em] text-[var(--steel)] mt-1.5">
                    Signed
                  </div>
                </div>
              </div>
            )}
          </div>

          <GlimpseCard title="Today's Schedule" onOpen={onOpenCalendar} quiet className="order-3 sm:order-none">
            {todaysEvents.length === 0 ? (
              <p className="text-sm text-zinc-400">Nothing on the calendar today</p>
            ) : (
              <div className="space-y-2.5">
                {todaysEvents.map((ev) => (
                  <div key={ev.id} className="flex items-center gap-3">
                    <div className="text-xs font-semibold tabular-nums text-zinc-600 bg-black/[0.04] border border-black/[0.06] rounded-full px-2.5 py-1 shrink-0 min-w-[4.25rem] text-center">
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
        </div>
      </div>
    </div>


  );
}
