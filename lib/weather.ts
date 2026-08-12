/**
 * Shared types + helpers for the Weather / Storm Tracker tool.
 *
 * MVP data source: NOAA's public Local Storm Reports (LSR) service — free,
 * no API key, near-real-time point reports of hail/wind/tornado/etc, updated
 * every ~30 minutes. See app/api/storm-reports/route.ts for the proxy that
 * fetches + normalizes this into the `StormReport` shape below.
 *
 * Phase 2 (not built here — see note at bottom): full radar-derived MESH hail
 * "swath" polygons (the colored-band maps Hail Recon/HailTrace are known for)
 * require ingesting NOAA MRMS GRIB2 grids server-side, which is a much bigger
 * backend lift than a point-report proxy. This file's `StormReport` shape and
 * the map's marker layer are intentionally kept swap-in-ready for that later:
 * a swath layer would render on the same Leaflet map alongside these points.
 */

export type StormEventCategory = 'hail' | 'wind' | 'tornado';

export const STORM_CATEGORIES: StormEventCategory[] = ['hail', 'wind', 'tornado'];

export type StormReport = {
  /** Unique within a single API response (not stable across requests). */
  id: string;
  category: StormEventCategory;
  /** Raw NOAA event description, e.g. "Hail", "Tstm Wnd Gst". */
  descript: string;
  /** e.g. "4 SW Saugerties" */
  locDesc: string | null;
  /** Two-letter state code */
  state: string | null;
  /** Issuing NWS Weather Forecast Office name */
  wfo: string | null;
  /** ISO timestamp (UTC) of the report */
  validTime: string;
  /** Raw magnitude value, e.g. "1.75" (hail inches) or "60" (wind mph) */
  magnitude: string | null;
  units: string | null;
  /** Narrative field — often the most useful part for judging real damage */
  remarks: string | null;
  lat: number;
  lng: number;
};

export type StormReportsResponse = {
  reports: StormReport[];
  fetchedAt: string;
  window: StormWindow;
  count: number;
  source: 'noaa-lsr';
};

export type StormWindow = '24h' | '48h' | '72h';

/** Mirrors NOAA's own layer structure on the LSR MapServer (verified via /query metadata). */
export const STORM_WINDOWS: { id: StormWindow; label: string; layerId: number }[] = [
  { id: '24h', label: 'Last 24h', layerId: 0 },
  { id: '48h', label: 'Last 48h', layerId: 1 },
  { id: '72h', label: 'Last 72h', layerId: 2 },
];

export function layerIdForWindow(w: StormWindow): number {
  return STORM_WINDOWS.find((x) => x.id === w)?.layerId ?? 0;
}

export type EventStyle = {
  id: StormEventCategory;
  label: string;
  /** Single-letter marker badge */
  shortLabel: string;
  badge: string;
  dot: string;
  /** Leaflet marker fill color */
  marker: string;
  markerStroke: string;
};

export const EVENT_STYLES: Record<StormEventCategory, EventStyle> = {
  hail: {
    id: 'hail',
    label: 'Hail',
    shortLabel: 'H',
    badge: 'bg-[var(--accent-blue-soft)] text-[var(--accent-blue-ink)] border-transparent',
    dot: 'bg-[var(--accent-blue)]',
    marker: '#6ba6ff',
    markerStroke: '#111111',
  },
  wind: {
    id: 'wind',
    label: 'Wind',
    shortLabel: 'W',
    badge: 'bg-[var(--stage-prospect-soft)] text-[var(--foreground)] border-transparent',
    dot: 'bg-stage-prospect',
    marker: '#ffb07a',
    markerStroke: '#111111',
  },
  tornado: {
    id: 'tornado',
    label: 'Tornado',
    shortLabel: 'T',
    badge: 'bg-[var(--danger-soft)] text-danger border-transparent',
    dot: 'bg-danger',
    marker: '#ff7a7a',
    markerStroke: '#111111',
  },
};

export function eventStyle(category: StormEventCategory): EventStyle {
  return EVENT_STYLES[category];
}

const HAIL_RE = /hail/i;
const TORNADO_RE = /tornado|funnel\s*cloud|waterspout/i;
const WIND_RE = /wind|wnd|gust|gst/i;

/**
 * Classify a raw NOAA `descript` field into the three event types Joe cares
 * about for canvassing. Returns null for everything else (rain, flooding,
 * fog, lightning, etc) so the API route can drop that noise.
 */
export function classifyStormEvent(
  descript: string | null | undefined
): StormEventCategory | null {
  const d = (descript || '').trim();
  if (!d) return null;
  if (HAIL_RE.test(d)) return 'hail';
  if (TORNADO_RE.test(d)) return 'tornado';
  if (WIND_RE.test(d)) return 'wind';
  return null;
}

export function parseMagnitudeNumber(magnitude: string | null | undefined): number | null {
  if (!magnitude) return null;
  const n = parseFloat(magnitude);
  return Number.isFinite(n) ? n : null;
}

/** Human label, e.g. `1.75" hail` / `60 MPH wind`. Null when NOAA left it blank. */
export function formatMagnitude(report: Pick<StormReport, 'category' | 'magnitude' | 'units'>): string | null {
  const m = (report.magnitude || '').trim();
  if (!m) return null;
  const u = (report.units || '').trim();
  if (report.category === 'hail') return `${m}" hail`;
  if (report.category === 'wind') return u ? `${m} ${u} wind` : `${m} mph wind`;
  return u ? `${m} ${u}` : m;
}

/**
 * Marker radius (px) scaled by severity within each category, twinning the
 * "bigger circle = bigger hail" visual language of hail-swath map tools.
 */
export function markerRadiusFor(
  category: StormEventCategory,
  magnitude: string | null | undefined
): number {
  const n = parseMagnitudeNumber(magnitude);
  if (category === 'hail') {
    if (n == null) return 9;
    return Math.max(8, Math.min(18, 6 + n * 4)); // 1" -> 10px, 2.75"+ -> 18px
  }
  if (category === 'wind') {
    if (n == null) return 9;
    return Math.max(8, Math.min(18, 4 + n / 8)); // 40mph -> 9px, 100mph+ -> 16.5px
  }
  return 14; // tornado — always prominent, magnitude field rarely populated
}

export function haversineMiles(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

export function relativeTimeFrom(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diffMs = Date.now() - t;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

export const US_STATES: { code: string; name: string }[] = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
];

/** Google Maps deep link — plain URL, no SDK/key, just for "get me there" navigation. */
export function directionsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}
