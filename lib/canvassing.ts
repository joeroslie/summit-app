/** Shared types + constants for the Canvassing / door-knocking tracker. */

export type Disposition =
  | 'not_contacted'
  | 'not_home'
  | 'follow_up'
  | 'not_interested'
  | 'signed';

export type DispositionStyle = {
  id: Disposition;
  label: string;
  /** Pill badge classes (matches PIPELINE_STAGE_STYLES pattern in app/page.tsx) */
  badge: string;
  /** Small colored dot */
  dot: string;
  /** Leaflet marker fill color */
  marker: string;
  markerStroke: string;
};

export const DISPOSITIONS: DispositionStyle[] = [
  {
    id: 'not_contacted',
    label: 'Not contacted',
    badge: 'bg-zinc-100 text-zinc-600 border-zinc-200',
    dot: 'bg-zinc-400',
    marker: '#a1a1aa',
    markerStroke: '#3f3f46',
  },
  {
    id: 'not_home',
    label: 'Not home',
    badge: 'bg-amber-50 text-amber-800 border-amber-100',
    dot: 'bg-amber-400',
    marker: '#fbbf24',
    markerStroke: '#92400e',
  },
  {
    id: 'follow_up',
    label: 'Follow up',
    badge: 'bg-sky-50 text-sky-800 border-sky-100',
    dot: 'bg-sky-500',
    marker: '#38bdf8',
    markerStroke: '#075985',
  },
  {
    id: 'not_interested',
    label: 'Not interested',
    badge: 'bg-red-50 text-red-700 border-red-100',
    dot: 'bg-red-400',
    marker: '#f87171',
    markerStroke: '#991b1b',
  },
  {
    id: 'signed',
    label: 'Signed',
    badge: 'bg-emerald-50 text-emerald-800 border-emerald-100',
    dot: 'bg-emerald-500',
    marker: '#34d399',
    markerStroke: '#065f46',
  },
];

export function dispositionStyle(id: string): DispositionStyle {
  return DISPOSITIONS.find((d) => d.id === id) || DISPOSITIONS[0];
}

/** Result shape returned by GET /api/property-lookup (free county-assessor lookup). */
export type PropertyLookupData = {
  available: boolean;
  source?: 'maricopa' | 'pima';
  ownerName?: string | null;
  yearBuilt?: string | null;
  assessedValue?: number | null;
  siteAddress?: string | null;
  parcelId?: string | null;
  /** ISO timestamp of when this lookup was fetched, set client-side */
  fetchedAt?: string;
};

export type CanvassPin = {
  id: number;
  created_at: string;
  updated_at: string;
  lat: number;
  lng: number;
  address: string | null;
  owner_name: string | null;
  property_data: PropertyLookupData | Record<string, never>;
  disposition: Disposition;
  status_changed_at: string;
  notes: string | null;
  lead_id: string | null;
};

/** Result handed back to CanvassingTool after the host app creates a Lead from a pin. */
export type CreatedLeadInfo = {
  leadNumericId: number;
  supabaseLeadId: string | null;
  jobNumber: string;
};

/**
 * Manual one-tap daily counters (tap a dashboard card, or its +/− control).
 * Logged as timestamped events — not a single mutable number — so historical
 * days are preserved and totals survive a refresh. Daily totals on screen
 * combine these with activity already derivable from pin timestamps.
 */
export type TallyType = 'door' | 'conversation' | 'signed';

export type TallyEntry = {
  id: number;
  created_at: string;
  type: TallyType;
};

export const TALLY_LABELS: Record<TallyType, string> = {
  door: 'Doors knocked',
  conversation: 'Conversations',
  signed: 'Signed',
};

/**
 * Local calendar day key (YYYY-MM-DD). Canvassing is a field-rep "today"
 * tracker — day boundaries must follow the device's local clock, not UTC
 * (a rep working an evening block shouldn't see doors roll into "tomorrow"
 * hours before midnight).
 */
export function localDateKey(input: string | number | Date = new Date()): string {
  const d = input instanceof Date ? input : new Date(input);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * True when a Supabase/PostgREST error means the table hasn't been created
 * yet (setup SQL not run) — used to fall back to local storage instead of
 * repeatedly failing writes against a table that doesn't exist.
 */
export function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: string; message?: string };
  if (e.code === 'PGRST205' || e.code === '42P01') return true;
  return /schema cache|does not exist/i.test(e.message || '');
}
