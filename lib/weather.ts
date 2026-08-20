/**
 * Shared types + helpers for the Weather / Storm Tracker tool.
 *
 * Data source: NOAA's public Local Storm Reports (LSR) service — free,
 * no API key, near-real-time point reports of hail/wind/tornado/etc.
 * See app/api/storm-reports/route.ts for the proxy.
 *
 * Optional live weather overlay (RainViewer reflectivity) lives in
 * lib/radar.ts and renders under the pins on StormMap. Damage zones on
 * live/day views are NWS storm-based warning polygons (the same outlines
 * HailTrace Recon draws). Longer lookbacks still fall back to clustered LSRs.
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

export type StormWarningPolygon = {
  type: 'Feature';
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: unknown;
  };
  properties: Record<string, never>;
};

/** NWS storm-based warning (SVR / TOR / extreme wind) for the damage-zone overlay. */
export type StormWarning = {
  id: string;
  category: StormEventCategory;
  wfo: string | null;
  issuedAt: string;
  expiresAt: string | null;
  windTagMph: number | null;
  hailTagInches: number | null;
  centroid: { lat: number; lng: number };
  polygon: StormWarningPolygon;
};

export type StormReportsResponse = {
  reports: StormReport[];
  warnings: StormWarning[];
  fetchedAt: string;
  window: StormWindow;
  /** Set when the request was for a calendar day or range (`YYYY-MM-DD`). */
  day: string | null;
  /** Inclusive end of a calendar range. Null when `day` is a single day or unset. */
  dayEnd: string | null;
  count: number;
  source: 'noaa-lsr' | 'iem-lsr';
  /**
   * Newest hail/wind/tornado in the requested radius. Present when the
   * client sent `latest=1`. Looks past the requested window (up to 2 years)
   * so Home can always name the last nearby storm.
   */
  latest?: StormReport | null;
};

export type StormWindow = '24h' | '48h' | '72h' | '3m' | '6m' | '9m' | '1y' | '2y' | 'day';

export type StormWindowMeta = {
  id: StormWindow;
  label: string;
  /** Hours to look back from now. */
  hours: number;
  /**
   * NOAA LSR MapServer layer id for the live 24/48/72h feeds.
   * Null for historical windows, which come from IEM's LSR archive.
   */
  layerId: number | null;
};

/**
 * Live NOAA layers (24/48/72h) plus IEM historical lookbacks. 3/6/9 months,
 * 1 year, and 2 years are for canvassing past storm damage — NOAA's public
 * LSR MapServer only keeps the last 72 hours.
 */
export const STORM_WINDOWS: StormWindowMeta[] = [
  { id: '24h', label: '24h', hours: 24, layerId: 0 },
  { id: '48h', label: '48h', hours: 48, layerId: 1 },
  { id: '72h', label: '72h', hours: 72, layerId: 2 },
  { id: '3m', label: '3 months', hours: 24 * 90, layerId: null },
  { id: '6m', label: '6 months', hours: 24 * 180, layerId: null },
  { id: '9m', label: '9 months', hours: 24 * 270, layerId: null },
  { id: '1y', label: '1 year', hours: 24 * 365, layerId: null },
  { id: '2y', label: '2 years', hours: 24 * 730, layerId: null },
];

/**
 * Home's "last nearby storm" lookback after the live 24h window is empty.
 * 3 months covers a typical monsoon gap; 2 years is the archive ceiling.
 */
export const STORM_LATEST_FALLBACK_WINDOWS: StormWindow[] = ['3m', '2y'];

export function newestStormReport(reports: StormReport[]): StormReport | undefined {
  if (reports.length === 0) return undefined;
  return reports.reduce((newest, r) => (r.validTime > newest.validTime ? r : newest));
}

export const DEFAULT_NEAR_RADIUS_MILES = 75;
export const MIN_NEAR_RADIUS_MILES = 10;
export const MAX_NEAR_RADIUS_MILES = 250;
export const NEAR_RADIUS_OPTIONS_MILES = [10, 25, 50, 75, 100, 150, 250] as const;
export const WEATHER_NEAR_RADIUS_STORAGE_KEY = 'summitWeatherNearRadius';
export const STORM_DAY_LOOKBACK_YEARS = 2;
/** Inclusive cap for Weather calendar ranges (first tap + second tap). */
export const STORM_DAY_RANGE_MAX_DAYS = 31;

export function clampNearRadiusMiles(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_NEAR_RADIUS_MILES;
  return Math.min(MAX_NEAR_RADIUS_MILES, Math.max(MIN_NEAR_RADIUS_MILES, Math.round(n)));
}

export function readStoredNearRadiusMiles(): number {
  if (typeof window === 'undefined') return DEFAULT_NEAR_RADIUS_MILES;
  try {
    const raw = window.localStorage.getItem(WEATHER_NEAR_RADIUS_STORAGE_KEY);
    if (raw == null || raw === '') return DEFAULT_NEAR_RADIUS_MILES;
    return clampNearRadiusMiles(Number(raw));
  } catch {
    return DEFAULT_NEAR_RADIUS_MILES;
  }
}

export function writeStoredNearRadiusMiles(miles: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      WEATHER_NEAR_RADIUS_STORAGE_KEY,
      String(clampNearRadiusMiles(miles))
    );
  } catch {
    /* ignore quota / private mode */
  }
}

const STORM_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isStormWindow(v: string | null | undefined): v is StormWindow {
  return v === 'day' || STORM_WINDOWS.some((w) => w.id === v);
}

export function stormWindowMeta(w: StormWindow): StormWindowMeta {
  return STORM_WINDOWS.find((x) => x.id === w) ?? STORM_WINDOWS[0];
}

export function isLiveStormWindow(w: StormWindow): boolean {
  if (w === 'day') return false;
  return stormWindowMeta(w).layerId != null;
}

export function layerIdForWindow(w: StormWindow): number {
  return stormWindowMeta(w).layerId ?? 0;
}

export function localDateInputValue(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function stormDayMinValue(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - STORM_DAY_LOOKBACK_YEARS);
  return localDateInputValue(d);
}

/** Validates `YYYY-MM-DD` within today and the 2-year lookback (browser local). */
export function parseStormDay(raw: string | null | undefined): string | null {
  const value = parseStormDayFormat(raw);
  if (!value) return null;
  if (value > localDateInputValue() || value < stormDayMinValue()) return null;
  return value;
}

/** Calendar-date only — used by the API so server TZ does not reject a valid local day. */
export function parseStormDayFormat(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = STORM_DAY_RE.exec(raw.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
    return null;
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function ymdFromUtcParts(y: number, mo: number, d: number): string {
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function stormDayUtcMidnightMs(day: string, tzOffsetMinutes: number): number {
  const [y, mo, d] = day.split('-').map(Number);
  return Date.UTC(y, mo - 1, d) + tzOffsetMinutes * 60_000;
}

/**
 * Local-calendar midnight of `day` → midnight after `dayEnd` (inclusive),
 * as UTC ISO strings for IEM `sts`/`ets`.
 * `tzOffsetMinutes` is `Date#getTimezoneOffset()` (minutes to add to local to get UTC).
 * Omit `dayEnd` (or pass the same day) for a single local calendar day.
 */
export function stormDayUtcBounds(
  day: string,
  tzOffsetMinutes = 0,
  dayEnd?: string | null
): { sts: string; ets: string } {
  const end = dayEnd && dayEnd > day ? dayEnd : day;
  const startMs = stormDayUtcMidnightMs(day, tzOffsetMinutes);
  const endMidnightMs = stormDayUtcMidnightMs(end, tzOffsetMinutes);
  return {
    sts: new Date(startMs).toISOString(),
    ets: new Date(endMidnightMs + 24 * 60 * 60 * 1000).toISOString(),
  };
}

/** Client local `YYYY-MM-DD` for an instant, using `Date#getTimezoneOffset()` minutes. */
export function localDateAtTzOffset(tzOffsetMinutes: number, at = Date.now()): string {
  const shifted = new Date(at - tzOffsetMinutes * 60_000);
  return ymdFromUtcParts(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate()
  );
}

export function isStormDayTodayAtOffset(
  day: string,
  tzOffsetMinutes: number,
  at = Date.now()
): boolean {
  return day === localDateAtTzOffset(tzOffsetMinutes, at);
}

export function addStormDays(day: string, deltaDays: number): string {
  const [y, mo, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + deltaDays));
  return ymdFromUtcParts(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function stormDayInclusiveCount(a: string, b: string): number {
  const lo = a <= b ? a : b;
  const hi = a <= b ? b : a;
  const [y1, m1, d1] = lo.split('-').map(Number);
  const [y2, m2, d2] = hi.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000) + 1;
}

export function normalizeStormDayRange(
  start: string,
  end?: string | null
): { start: string; end: string } | null {
  const a = parseStormDayFormat(start);
  if (!a) return null;
  const b = parseStormDayFormat(end) || a;
  const lo = a <= b ? a : b;
  const hi = a <= b ? b : a;
  if (stormDayInclusiveCount(lo, hi) <= STORM_DAY_RANGE_MAX_DAYS) {
    return { start: lo, end: hi };
  }
  return { start: lo, end: addStormDays(lo, STORM_DAY_RANGE_MAX_DAYS - 1) };
}

/** Sunday-first month cells for the Weather date control. */
export function stormMonthCells(year: number, monthIndex: number): Array<string | null> {
  const firstWeekday = new Date(year, monthIndex, 1).getDay();
  const lastDate = new Date(year, monthIndex + 1, 0).getDate();
  const cells: Array<string | null> = [];
  for (let i = 0; i < firstWeekday; i += 1) cells.push(null);
  for (let d = 1; d <= lastDate; d += 1) {
    cells.push(localDateInputValue(new Date(year, monthIndex, d)));
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function formatStormDayLabel(day: string): string {
  const parsed = parseStormDayFormat(day) || parseStormDay(day);
  if (!parsed) return day;
  const [y, mo, d] = parsed.split('-').map(Number);
  const dt = new Date(y, mo - 1, d);
  return dt.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Closed Weather date-control label.
 * One day: `formatStormDayLabel`, or "Today" when that day is today.
 * Range: "Aug 12–14" (year if it spans years or isn't this year).
 */
export function formatStormDateControlLabel(start: string, end?: string | null): string {
  const a = parseStormDayFormat(start);
  const b = parseStormDayFormat(end || start) || a;
  if (!a) return start;
  if (a === b) {
    if (a === localDateInputValue()) return 'Today';
    return formatStormDayLabel(a);
  }
  return formatStormDayRangeLabel(a, b!);
}

/** Range copy for empty lists: "Aug 12–14". Single day uses `formatStormDayLabel`. */
export function formatStormDayRangeLabel(start: string, end: string): string {
  const a = parseStormDayFormat(start);
  const b = parseStormDayFormat(end);
  if (!a || !b) return start;
  const lo = a <= b ? a : b;
  const hi = a <= b ? b : a;
  if (lo === hi) return formatStormDayLabel(lo);

  const thisYear = new Date().getFullYear();
  const [ly, lm, ld] = lo.split('-').map(Number);
  const [hy, hm, hd] = hi.split('-').map(Number);
  const startDt = new Date(ly, lm - 1, ld);
  const endDt = new Date(hy, hm - 1, hd);
  const spansYears = ly !== hy;
  const notThisYear = ly !== thisYear || hy !== thisYear;

  if (spansYears) {
    return `${startDt.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })}–${endDt.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })}`;
  }

  const startMd = startDt.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  const endMd =
    lm === hm
      ? String(hd)
      : endDt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return notThisYear ? `${startMd}–${endMd}, ${ly}` : `${startMd}–${endMd}`;
}

export type GeoBBox = { west: number; east: number; south: number; north: number };

/** Axis-aligned box around a point. Slightly larger than the circle of `radiusMiles`. */
export function bboxAroundPoint(lat: number, lng: number, radiusMiles: number): GeoBBox {
  const latDelta = radiusMiles / 69;
  const cos = Math.cos((lat * Math.PI) / 180);
  const lngDelta = radiusMiles / (69 * Math.max(0.2, Math.abs(cos)));
  return {
    south: lat - latDelta,
    north: lat + latDelta,
    west: lng - lngDelta,
    east: lng + lngDelta,
  };
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
    badge: 'bg-zinc-100 text-zinc-700 border-zinc-200',
    dot: 'bg-zinc-400',
    marker: '#a1a1aa',
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
const TORNADO_RE = /tornado|funnel\s*cloud|waterspout|landspout/i;
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

/**
 * Map an NWS VTEC warning to hail / wind / tornado. Dual-threat SVRs
 * (today's Valley cells: 60 mph + 0.75" hail) follow the wind tag when
 * it meets severe criteria — that's the Recon wind outline Joe compared.
 */
export function classifyStormWarning(opts: {
  phenomena: string | null | undefined;
  windTagMph: number | null;
  hailTagInches: number | null;
}): StormEventCategory | null {
  const ph = (opts.phenomena || '').toUpperCase();
  if (ph === 'TO') return 'tornado';
  if (ph === 'EW') return 'wind';
  if (ph !== 'SV') return null;
  const hail = opts.hailTagInches;
  const wind = opts.windTagMph;
  if (hail != null && hail >= 1 && (wind == null || wind < 58)) return 'hail';
  if (wind != null) return 'wind';
  if (hail != null && hail > 0) return 'hail';
  return 'wind';
}

export function formatWarningMagnitude(warning: {
  category: StormEventCategory;
  windTagMph: number | null;
  hailTagInches: number | null;
}): string | null {
  if (warning.category === 'tornado') return 'Tornado warning';
  if (warning.category === 'wind' && warning.windTagMph != null) {
    return `${Math.round(warning.windTagMph)} mph wind`;
  }
  if (warning.category === 'hail' && warning.hailTagInches != null) {
    return `${warning.hailTagInches}" hail`;
  }
  return 'Severe thunderstorm warning';
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

export const MILES_TO_METERS = 1609.344;

export function bearingDegrees(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const dLng = toRad(to.lng - from.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function destinationPoint(
  from: { lat: number; lng: number },
  miles: number,
  bearingDeg: number
): { lat: number; lng: number } {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const brng = toRad(bearingDeg);
  const lat1 = toRad(from.lat);
  const lng1 = toRad(from.lng);
  const d = miles / R;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { lat: toDeg(lat2), lng: toDeg(lng2) };
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
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.round(days / 365);
  return `${years}y ago`;
}

/** House-level lookback used when a canvassing pin is dropped. */
export const CANVASS_STORM_RADIUS_MILES = 15;
export const CANVASS_STORM_WINDOW: StormWindow = '2y';
export const CANVASS_STORM_LIVE_WINDOW: StormWindow = '72h';
export const CANVASS_WIND_MIN_MPH = 45;
export const PIN_STORM_LOOKUP_VERSION = 2;
const CANVASS_STORM_MAX_DAYS = 12;
const TWO_YEARS_MS = STORM_DAY_LOOKBACK_YEARS * 365.25 * 24 * 60 * 60 * 1000;
const WIND_DAMAGE_RE = /dmg|damage/i;

export type PinStormHit = {
  date: string;
  category: StormEventCategory;
  magnitudeLabel: string | null;
  miles: number;
  locDesc: string | null;
  validTime: string;
};

/** Nearby-storm summary stored on a canvassing pin for date-of-loss. */
export type PinStormLookup = {
  version: number;
  fetchedAt: string;
  window: StormWindow;
  radiusMiles: number;
  suggestedDate: string | null;
  chosenDate: string | null;
  best: PinStormHit | null;
  alternates: PinStormHit[];
  reportCount: number;
  error?: string;
};

export function isPinStormLookup(v: unknown): v is PinStormLookup {
  if (!v || typeof v !== 'object') return false;
  const row = v as PinStormLookup;
  return (
    typeof row.fetchedAt === 'string' && row.version === PIN_STORM_LOOKUP_VERSION
  );
}

export function formatMilesCompact(miles: number): string {
  if (!Number.isFinite(miles)) return '';
  const n = miles < 10 ? miles.toFixed(1) : String(Math.round(miles));
  return `${n} mi`;
}

/** LSR valid time → local calendar day (device TZ). Arizona evening storms stay on that evening. */
export function localDayFromIso(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function windSpeedMph(
  report: Pick<StormReport, 'magnitude' | 'units'>
): number | null {
  const n = parseMagnitudeNumber(report.magnitude);
  if (n == null) return null;
  const u = (report.units || '').toLowerCase();
  if (u.startsWith('kt') || u.includes('knot')) return n * 1.15078;
  return n;
}

export function isWindDamageReport(report: Pick<StormReport, 'descript'>): boolean {
  return WIND_DAMAGE_RE.test(report.descript || '');
}

function isWithinTwoYears(iso: string, now = Date.now()): boolean {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  if (t > now + 24 * 60 * 60 * 1000) return false;
  return t >= now - TWO_YEARS_MS;
}

/**
 * Date-of-loss qualifiers: measured hail, wind 45+ mph, thunderstorm wind
 * damage (no mph on those LSRs), or tornado. Weaker gusts are dropped.
 */
export function qualifiesForCanvassDateOfLoss(report: StormReport): boolean {
  if (!isWithinTwoYears(report.validTime)) return false;
  if (report.category === 'tornado') return true;
  if (report.category === 'hail') {
    const n = parseMagnitudeNumber(report.magnitude);
    return n != null && n > 0;
  }
  if (report.category === 'wind') {
    const mph = windSpeedMph(report);
    if (mph != null) return mph >= CANVASS_WIND_MIN_MPH;
    return isWindDamageReport(report);
  }
  return false;
}

function canvassMagnitudeLabel(report: StormReport): string | null {
  if (report.category === 'hail') return formatMagnitude(report);
  if (report.category === 'tornado') {
    return formatMagnitude(report) || 'Tornado';
  }
  const mph = windSpeedMph(report);
  if (mph != null) return `${Math.round(mph)} mph wind`;
  if (isWindDamageReport(report)) return 'Wind damage';
  return formatMagnitude(report);
}

function closerThenStronger(
  a: StormReport,
  b: StormReport,
  origin: { lat: number; lng: number }
): number {
  const d = haversineMiles(origin, a) - haversineMiles(origin, b);
  if (Math.abs(d) > 0.05) return d;
  const magA =
    a.category === 'wind' ? windSpeedMph(a) ?? 0 : parseMagnitudeNumber(a.magnitude) ?? 0;
  const magB =
    b.category === 'wind' ? windSpeedMph(b) ?? 0 : parseMagnitudeNumber(b.magnitude) ?? 0;
  return magB - magA;
}

function hitForDay(
  reports: StormReport[],
  origin: { lat: number; lng: number }
): PinStormHit | null {
  if (reports.length === 0) return null;
  const hail = reports
    .filter((r) => r.category === 'hail')
    .sort((a, b) => closerThenStronger(a, b, origin))[0];
  const wind = reports
    .filter((r) => r.category === 'wind')
    .sort((a, b) => closerThenStronger(a, b, origin))[0];
  const tornado = reports
    .filter((r) => r.category === 'tornado')
    .sort((a, b) => closerThenStronger(a, b, origin))[0];

  const candidates = [hail, wind, tornado].filter((r): r is StormReport => r != null);
  const primary = [...candidates].sort((a, b) => closerThenStronger(a, b, origin))[0];
  if (!primary) return null;
  const date = localDayFromIso(primary.validTime);
  if (!date) return null;

  const labels = [hail, wind, tornado]
    .filter((r): r is StormReport => r != null)
    .map((r) => canvassMagnitudeLabel(r))
    .filter((s): s is string => !!s);

  return {
    date,
    category: primary.category,
    magnitudeLabel: labels.join(' · ') || canvassMagnitudeLabel(primary),
    miles: haversineMiles(origin, primary),
    locDesc: primary.locDesc,
    validTime: primary.validTime,
  };
}

export function mergeStormReports(groups: StormReport[][]): StormReport[] {
  const seen = new Set<string>();
  const out: StormReport[] = [];
  for (const group of groups) {
    for (const report of group) {
      const key = [
        report.validTime,
        report.lat.toFixed(4),
        report.lng.toFixed(4),
        report.category,
        report.magnitude || '',
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(report);
    }
  }
  return out;
}

/**
 * Date of loss for a pin: qualifying reports within 2 years, newest day first.
 * Hail no longer outranks nearby 45+ mph wind or wind-damage LSRs.
 */
export function summarizeStormsForPin(
  reports: StormReport[],
  origin: { lat: number; lng: number },
  opts?: {
    window?: StormWindow;
    radiusMiles?: number;
    chosenDate?: string | null;
    fetchedAt?: string;
    error?: string;
  }
): PinStormLookup {
  const radius = opts?.radiusMiles ?? CANVASS_STORM_RADIUS_MILES;
  const qualifying = reports.filter((r) => {
    if (!qualifiesForCanvassDateOfLoss(r)) return false;
    return haversineMiles(origin, r) <= radius;
  });

  const byDay = new Map<string, StormReport[]>();
  for (const report of qualifying) {
    const date = localDayFromIso(report.validTime);
    if (!date) continue;
    const list = byDay.get(date);
    if (list) list.push(report);
    else byDay.set(date, [report]);
  }

  const hits = [...byDay.entries()]
    .map(([, dayReports]) => hitForDay(dayReports, origin))
    .filter((h): h is PinStormHit => h != null)
    .sort((a, b) => new Date(b.validTime).getTime() - new Date(a.validTime).getTime())
    .slice(0, CANVASS_STORM_MAX_DAYS);

  const best = hits[0] ?? null;
  const suggestedDate = best?.date ?? null;
  const allDates = new Set(hits.map((h) => h.date));
  const keptChosen =
    opts?.chosenDate && allDates.has(opts.chosenDate) ? opts.chosenDate : null;

  return {
    version: PIN_STORM_LOOKUP_VERSION,
    fetchedAt: opts?.fetchedAt || new Date().toISOString(),
    window: opts?.window ?? CANVASS_STORM_WINDOW,
    radiusMiles: radius,
    suggestedDate,
    chosenDate: keptChosen || suggestedDate,
    best,
    alternates: hits.slice(1),
    reportCount: qualifying.length,
    ...(opts?.error ? { error: opts.error } : {}),
  };
}

export function emptyPinStormLookup(error?: string): PinStormLookup {
  return {
    version: PIN_STORM_LOOKUP_VERSION,
    fetchedAt: new Date().toISOString(),
    window: CANVASS_STORM_WINDOW,
    radiusMiles: CANVASS_STORM_RADIUS_MILES,
    suggestedDate: null,
    chosenDate: null,
    best: null,
    alternates: [],
    reportCount: 0,
    ...(error ? { error } : {}),
  };
}

export function pinDateOfLoss(storm: unknown): string | null {
  if (!isPinStormLookup(storm)) return null;
  return storm.chosenDate || storm.suggestedDate || null;
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
