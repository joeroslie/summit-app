/** Shared 6-stage pipeline used on Home, kanban, and lead profile. */

export type PipelineStage =
  | 'Lead'
  | 'Prospect'
  | 'Approved'
  | 'Completed'
  | 'Invoiced'
  | 'Closed';

export const PIPELINE_STAGES: PipelineStage[] = [
  'Lead',
  'Prospect',
  'Approved',
  'Completed',
  'Invoiced',
  'Closed',
];

/**
 * Home + Leads: matte chrome cards; small colored stage dots for character.
 * Lead amber · Prospect orange · Approved emerald · Completed blue · Invoiced amber · Closed emerald
 */
export const PIPELINE_STAGE_STYLES: Record<
  PipelineStage,
  {
    card: string;
    count: string;
    label: string;
    column: string;
    header: string;
    pill: string;
    badge: string;
    /** Colored dot next to stage label */
    dash: string;
    ring: string;
    cardAccent: string;
  }
> = {
  Lead: {
    card: 'bg-white border-zinc-200 hover:border-zinc-300 hover:shadow-sm transition-all',
    count: 'text-zinc-900',
    label: 'text-zinc-500',
    column: 'bg-zinc-100 border-zinc-200',
    header: 'text-zinc-900',
    pill: 'bg-white border-zinc-200 text-zinc-600',
    badge: 'bg-[var(--stage-lead-soft)] text-stage-lead border-transparent',
    dash: 'bg-stage-lead',
    ring: 'ring-stage-lead/50',
    cardAccent: '',
  },
  Prospect: {
    card: 'bg-white border-zinc-200 hover:border-zinc-300 hover:shadow-sm transition-all',
    count: 'text-zinc-900',
    label: 'text-zinc-500',
    column: 'bg-zinc-100 border-zinc-200',
    header: 'text-zinc-900',
    pill: 'bg-white border-zinc-200 text-zinc-600',
    badge: 'bg-[var(--stage-prospect-soft)] text-stage-prospect border-transparent',
    dash: 'bg-stage-prospect',
    ring: 'ring-stage-prospect/50',
    cardAccent: '',
  },
  Approved: {
    card: 'bg-white border-zinc-200 hover:border-zinc-300 hover:shadow-sm transition-all',
    count: 'text-zinc-900',
    label: 'text-zinc-500',
    column: 'bg-zinc-100/80 border-zinc-200',
    header: 'text-zinc-900',
    pill: 'bg-white border-zinc-200 text-zinc-600',
    badge: 'bg-[var(--stage-approved-soft)] text-stage-approved border-transparent',
    dash: 'bg-stage-approved',
    ring: 'ring-stage-approved/50',
    cardAccent: '',
  },
  Completed: {
    card: 'bg-white border-zinc-200 hover:border-zinc-300 hover:shadow-sm transition-all',
    count: 'text-zinc-900',
    label: 'text-zinc-500',
    column: 'bg-zinc-100/70 border-zinc-200',
    header: 'text-zinc-900',
    pill: 'bg-white border-zinc-200 text-zinc-600',
    badge: 'bg-[var(--stage-completed-soft)] text-stage-completed border-transparent',
    dash: 'bg-stage-completed',
    ring: 'ring-stage-completed/50',
    cardAccent: '',
  },
  Invoiced: {
    card: 'bg-white border-zinc-200 hover:border-zinc-300 hover:shadow-sm transition-all',
    count: 'text-zinc-900',
    label: 'text-zinc-500',
    column: 'bg-zinc-100 border-zinc-200',
    header: 'text-zinc-900',
    pill: 'bg-white border-zinc-200 text-zinc-600',
    badge: 'bg-[var(--stage-invoiced-soft)] text-stage-invoiced border-transparent',
    dash: 'bg-stage-invoiced',
    ring: 'ring-stage-invoiced/50',
    cardAccent: '',
  },
  Closed: {
    card: 'bg-white border-zinc-200 hover:border-zinc-300 hover:shadow-sm transition-all',
    count: 'text-zinc-900',
    label: 'text-zinc-500',
    column: 'bg-zinc-100/80 border-zinc-300',
    header: 'text-zinc-900',
    pill: 'bg-white border-zinc-200 text-zinc-600',
    badge: 'bg-stage-closed text-white border-transparent',
    dash: 'bg-stage-closed',
    ring: 'ring-stage-closed/40',
    cardAccent: '',
  },
};

/** Map current + legacy kanban labels onto the 6-stage pipeline. */
export function normalizePipelineStage(raw: unknown): PipelineStage {
  if (typeof raw !== 'string') return 'Lead';
  if ((PIPELINE_STAGES as string[]).includes(raw)) return raw as PipelineStage;
  const legacy: Record<string, PipelineStage> = {
    'New Lead': 'Lead',
    'Follow Up': 'Prospect',
    Quoted: 'Approved',
    Closed: 'Closed',
  };
  return legacy[raw] ?? 'Lead';
}
