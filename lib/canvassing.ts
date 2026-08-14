/** Shared types + constants for the Canvassing / door-knocking tracker. */

import type { PinStormLookup } from '@/lib/weather';

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
    badge: 'bg-zinc-200 text-zinc-800 border-zinc-300',
    dot: 'bg-zinc-500',
    marker: '#71717a',
    markerStroke: '#3f3f46',
  },
  {
    id: 'follow_up',
    label: 'Follow up',
    badge: 'bg-steel-soft text-graphite border-chrome',
    dot: 'bg-steel',
    marker: '#5c6270',
    markerStroke: '#2e3034',
  },
  {
    id: 'not_interested',
    label: 'Not interested',
    badge: 'bg-[var(--danger-soft)] text-danger border-transparent',
    dot: 'bg-danger',
    marker: '#ff7a7a',
    markerStroke: '#111111',
  },
  {
    id: 'signed',
    label: 'Signed',
    badge: 'bg-[var(--accent-green-soft)] text-[var(--accent-green-ink)] border-transparent',
    dot: 'bg-[var(--accent-green)]',
    marker: '#7bc9a6',
    markerStroke: '#111111',
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
  /**
   * Nearby storm-report summary for date of loss. Client-side (re-fetched on
   * select if missing) — not a canvass_pins column.
   */
  storm_data?: PinStormLookup | Record<string, never>;
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
