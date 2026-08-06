/**
 * Summit calendar events (local-first).
 * Manual / lead-linked events live here. Lead Insurance adjustmentDate is
 * claim metadata only — not synced or rendered on the calendar.
 */

export const SUMMIT_CALENDAR_EVENTS_KEY = 'summitCalendarEvents';

/** Google Calendar event colorIds 1–11 (event colors, not calendarList). */
export const GOOGLE_EVENT_COLOR_IDS = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  '11',
] as const;

export type GoogleEventColorId = (typeof GOOGLE_EVENT_COLOR_IDS)[number];

export type GoogleEventColorSwatch = {
  id: GoogleEventColorId;
  name: string;
  /** Month / all-day chip fill — Google *modern* UI */
  bg: string;
  /** Readable text on bg */
  text: string;
  /** Week timed block fill — Google *modern* UI */
  solid: string;
  /** Text on solid */
  solidText: string;
  /** API `colors.get` classic background (reference only) */
  classic: string;
};

/**
 * Google Calendar event colors (colorId 1–11).
 * Hex values match Google Calendar *modern* UI (default theme).
 * Classic = API `GET /colors` event palette (legacy / classic theme).
 *
 * Events with no `colorId` inherit calendarList.backgroundColor
 * (see `eventChipColorStyle` / `eventBlockColorStyle`).
 */
export const GOOGLE_EVENT_COLORS: GoogleEventColorSwatch[] = [
  {
    id: '1',
    name: 'Lavender',
    classic: '#a4bdfc',
    bg: '#7986cb',
    text: '#ffffff',
    solid: '#7986cb',
    solidText: '#ffffff',
  },
  {
    id: '2',
    name: 'Sage',
    classic: '#7ae7bf',
    bg: '#33b679',
    text: '#ffffff',
    solid: '#33b679',
    solidText: '#ffffff',
  },
  {
    id: '3',
    name: 'Grape',
    classic: '#dbadff',
    bg: '#8e24aa',
    text: '#ffffff',
    solid: '#8e24aa',
    solidText: '#ffffff',
  },
  {
    id: '4',
    name: 'Flamingo',
    classic: '#ff887c',
    bg: '#e67c73',
    text: '#ffffff',
    solid: '#e67c73',
    solidText: '#ffffff',
  },
  {
    id: '5',
    name: 'Banana',
    classic: '#fbd75b',
    bg: '#f6bf26',
    text: '#3d3200',
    solid: '#f6bf26',
    solidText: '#3d3200',
  },
  {
    id: '6',
    name: 'Tangerine',
    classic: '#ffb878',
    bg: '#f4511e',
    text: '#ffffff',
    solid: '#f4511e',
    solidText: '#ffffff',
  },
  {
    id: '7',
    name: 'Peacock',
    classic: '#46d6db',
    bg: '#039be5',
    text: '#ffffff',
    solid: '#039be5',
    solidText: '#ffffff',
  },
  {
    id: '8',
    name: 'Graphite',
    classic: '#e1e1e1',
    bg: '#616161',
    text: '#ffffff',
    solid: '#616161',
    solidText: '#ffffff',
  },
  {
    id: '9',
    name: 'Blueberry',
    classic: '#5484ed',
    bg: '#3f51b5',
    text: '#ffffff',
    solid: '#3f51b5',
    solidText: '#ffffff',
  },
  {
    id: '10',
    name: 'Basil',
    classic: '#51b749',
    bg: '#0b8043',
    text: '#ffffff',
    solid: '#0b8043',
    solidText: '#ffffff',
  },
  {
    id: '11',
    name: 'Tomato',
    classic: '#dc2127',
    bg: '#d50000',
    text: '#ffffff',
    solid: '#d50000',
    solidText: '#ffffff',
  },
];

/**
 * Last-resort paint when an event has no colorId and no calendarList color.
 * Cobalt modern (#4285f4) — Google primary default in the modern theme.
 * Prefer live calendarList resolution (Eucalyptus/Mango/etc.) whenever available.
 */
export const GOOGLE_CALENDAR_DEFAULT_COLOR = {
  name: 'Cobalt',
  bg: '#4285f4',
  text: '#ffffff',
  solid: '#4285f4',
  solidText: '#ffffff',
} as const;

export type GoogleCalendarListColorSwatch = {
  name: string;
  /** API `colors.get` / calendarList.backgroundColor for presets (classic theme) */
  classic: string;
  /** Google Calendar web *modern* theme (default UI) — paint this for presets */
  modern: string;
};

/**
 * Google calendarList colorId 1–24.
 * API + colors.get return classic hex; Calendar web (modern theme) paints modern.
 * Names match Google Calendar UI (Eucalyptus, Mango, Cobalt, …).
 */
export const GOOGLE_CALENDAR_LIST_COLORS: Record<
  string,
  GoogleCalendarListColorSwatch
> = {
  '1': { name: 'Cocoa', classic: '#ac725e', modern: '#795548' },
  '2': { name: 'Flamingo', classic: '#d06b64', modern: '#e67c73' },
  '3': { name: 'Tomato', classic: '#f83a22', modern: '#d50000' },
  '4': { name: 'Tangerine', classic: '#fa573c', modern: '#f4511e' },
  '5': { name: 'Pumpkin', classic: '#ff7537', modern: '#ef6c00' },
  '6': { name: 'Mango', classic: '#ffad46', modern: '#f09300' },
  '7': { name: 'Eucalyptus', classic: '#42d692', modern: '#009688' },
  '8': { name: 'Basil', classic: '#16a765', modern: '#0b8043' },
  '9': { name: 'Pistachio', classic: '#7bd148', modern: '#7cb342' },
  '10': { name: 'Avocado', classic: '#b3dc6c', modern: '#c0ca33' },
  '11': { name: 'Citron', classic: '#fbe983', modern: '#e4c441' },
  '12': { name: 'Banana', classic: '#fad165', modern: '#f6bf26' },
  '13': { name: 'Sage', classic: '#92e1c0', modern: '#33b679' },
  '14': { name: 'Peacock', classic: '#9fe1e7', modern: '#039be5' },
  '15': { name: 'Cobalt', classic: '#9fc6e7', modern: '#4285f4' },
  '16': { name: 'Blueberry', classic: '#4986e7', modern: '#3f51b5' },
  '17': { name: 'Lavender', classic: '#9a9cff', modern: '#7986cb' },
  '18': { name: 'Wisteria', classic: '#b99aff', modern: '#b39ddb' },
  '19': { name: 'Graphite', classic: '#c2c2c2', modern: '#616161' },
  '20': { name: 'Birch', classic: '#cabdbf', modern: '#a79b8e' },
  '21': { name: 'Radicchio', classic: '#cca6ac', modern: '#ad1457' },
  '22': { name: 'Cherry Blossom', classic: '#f691b2', modern: '#d81b60' },
  '23': { name: 'Grape', classic: '#cd74e6', modern: '#8e24aa' },
  '24': { name: 'Amethyst', classic: '#a47ae2', modern: '#9e69af' },
};

/** Optional calendar-list color (from calendarList → modern paint hex). */
export type CalendarListColor = {
  bg: string;
  text?: string;
};

/** Normalize #RGB / #RRGGBB (with or without #) → #rrggbb, or undefined. */
export function normalizeCssHex(raw?: string | null): string | undefined {
  if (raw == null) return undefined;
  let s = String(raw).trim();
  if (!s) return undefined;
  if (s.startsWith('#')) s = s.slice(1);
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    s = s
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return undefined;
  return `#${s.toLowerCase()}`;
}

/** Resolve calendarList colorId → Google Calendar *modern* paint hex. */
export function googleCalendarListColorFromId(
  colorId?: string | null
): CalendarListColor | undefined {
  if (colorId == null) return undefined;
  const id = String(colorId).trim();
  const sw = GOOGLE_CALENDAR_LIST_COLORS[id];
  if (!sw) return undefined;
  return { bg: sw.modern, text: contrastTextOnBg(sw.modern) };
}

/** Classic API hex → modern paint (when colorId missing but classic bg present). */
function modernFromClassicCalendarHex(
  classicHex: string
): CalendarListColor | undefined {
  const bg = normalizeCssHex(classicHex);
  if (!bg) return undefined;
  for (const sw of Object.values(GOOGLE_CALENDAR_LIST_COLORS)) {
    if (normalizeCssHex(sw.classic) === bg) {
      return { bg: sw.modern, text: contrastTextOnBg(sw.modern) };
    }
  }
  return undefined;
}

/**
 * Normalize any stored/API calendar hex to Google Calendar *modern* paint.
 * Classic presets remap; custom / already-modern hex pass through.
 */
export function toGoogleCalendarModernPaintHex(
  raw?: string | null
): string | undefined {
  const bg = normalizeCssHex(raw);
  if (!bg) return undefined;
  return modernFromClassicCalendarHex(bg)?.bg || bg;
}

/**
 * Resolve a calendarList entry to the hex Google Calendar *web* paints today.
 *
 * - Preset colorId (or classic API backgroundColor) → modern theme hex
 *   (Eucalyptus #009688, Mango #f09300, Cobalt #4285f4, …)
 * - Custom backgroundColor (not a classic preset) → API hex as-is
 * - Never invent a color when nothing resolves — callers fall back last.
 */
export function resolveCalendarListEntryColor(entry: {
  backgroundColor?: string | null;
  foregroundColor?: string | null;
  colorId?: string | null;
}): CalendarListColor | undefined {
  const apiBg = normalizeCssHex(entry.backgroundColor);
  const apiFg = normalizeCssHex(entry.foregroundColor);
  const id =
    entry.colorId != null ? String(entry.colorId).trim() : '';
  const sw = id ? GOOGLE_CALENDAR_LIST_COLORS[id] : undefined;

  if (sw) {
    const classic = normalizeCssHex(sw.classic);
    // Preset: API returns classic (or omits bg) → paint modern to match Calendar web
    if (!apiBg || apiBg === classic || apiBg === normalizeCssHex(sw.modern)) {
      return { bg: sw.modern, text: apiFg || contrastTextOnBg(sw.modern) };
    }
    // Custom hex with a nearest colorId — trust API backgroundColor
    return { bg: apiBg, text: apiFg || contrastTextOnBg(apiBg) };
  }

  if (apiBg) {
    const fromClassic = modernFromClassicCalendarHex(apiBg);
    if (fromClassic) return fromClassic;
    return { bg: apiBg, text: apiFg || contrastTextOnBg(apiBg) };
  }

  return googleCalendarListColorFromId(entry.colorId);
}

/** Pick readable text for a calendar background hex. */
export function contrastTextOnBg(bg: string): string {
  const normalized = normalizeCssHex(bg);
  const hex = (normalized || bg).trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return '#ffffff';
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  // Relative luminance (sRGB approx)
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.65 ? '#1f1f1f' : '#ffffff';
}

export function normalizeGoogleEventColorId(
  raw?: string | null
): GoogleEventColorId | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if ((GOOGLE_EVENT_COLOR_IDS as readonly string[]).includes(s)) {
    return s as GoogleEventColorId;
  }
  return undefined;
}

export function googleEventColorSwatch(
  colorId?: string | null
): GoogleEventColorSwatch | undefined {
  const id = normalizeGoogleEventColorId(colorId);
  if (!id) return undefined;
  return GOOGLE_EVENT_COLORS.find((c) => c.id === id);
}

function resolveCalendarFallback(
  calendarColor?: CalendarListColor | null
): { backgroundColor: string; color: string } {
  const bg = normalizeCssHex(calendarColor?.bg) || calendarColor?.bg?.trim();
  if (bg) {
    return {
      backgroundColor: bg,
      color:
        normalizeCssHex(calendarColor?.text) ||
        calendarColor?.text?.trim() ||
        contrastTextOnBg(bg),
    };
  }
  return {
    backgroundColor: GOOGLE_CALENDAR_DEFAULT_COLOR.bg,
    color: GOOGLE_CALENDAR_DEFAULT_COLOR.text,
  };
}

/**
 * Month/week chips.
 * Event colorId wins; else calendarList background; else Cobalt fallback.
 */
export function eventChipColorStyle(
  colorId?: string | null,
  calendarColor?: CalendarListColor | null
): { backgroundColor: string; color: string } {
  const sw = googleEventColorSwatch(colorId);
  if (sw) return { backgroundColor: sw.bg, color: sw.text };
  return resolveCalendarFallback(calendarColor);
}

/**
 * Week timed blocks.
 * Event colorId wins; else calendarList background; else Cobalt fallback.
 */
export function eventBlockColorStyle(
  colorId?: string | null,
  calendarColor?: CalendarListColor | null
): { backgroundColor: string; color: string } {
  const sw = googleEventColorSwatch(colorId);
  if (sw) return { backgroundColor: sw.solid, color: sw.solidText };
  return resolveCalendarFallback(calendarColor);
}

export type SummitCalendarEvent = {
  id: string;
  title: string;
  notes?: string;
  /** YYYY-MM-DD */
  startDate: string;
  /** YYYY-MM-DD */
  endDate: string;
  /** HH:MM when timed */
  startTime?: string;
  /** HH:MM when timed */
  endTime?: string;
  allDay: boolean;
  /** Optional linked lead */
  leadId?: number;
  /** Snapshot of lead name at link time */
  leadName?: string;
  googleEventId?: string;
  googleHtmlLink?: string;
  /** Google calendar id (e.g. primary or email) */
  calendarId?: string;
  /** Google Calendar event colorId "1"–"11" */
  colorId?: GoogleEventColorId;
  /** Resolved calendarList.backgroundColor when no event colorId */
  calendarColorBg?: string;
  /** Resolved calendarList.foregroundColor */
  calendarColorFg?: string;
  /**
   * Recurrence rule body (no `RRULE:` prefix), e.g. `FREQ=WEEKLY;BYDAY=MO`.
   * Present on Summit masters and copied onto series instances when known.
   */
  rrule?: string;
  /** Google recurring master id (set on expanded instances from singleEvents pull) */
  recurringEventId?: string;
  updatedAt: string;
  createdAt: string;
  /** Created in Summit vs imported from Google */
  source?: 'summit' | 'google';
};

export type GoogleEventForMerge = {
  id: string;
  summary?: string;
  description?: string;
  htmlLink?: string;
  location?: string;
  colorId?: string;
  /** Calendar the event was listed from */
  calendarId?: string;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  /** From calendarList entry at pull time */
  calendarBackground?: string;
  calendarForeground?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  /** confirmed | tentative | cancelled */
  status?: string;
  /** Present on expanded recurring instances */
  recurringEventId?: string;
  /** Master events only (not returned when singleEvents=true) */
  recurrence?: string[];
  extendedProperties?: {
    private?: Record<string, string>;
  };
  updated?: string;
};

/**
 * Never let Google event state become a non-array or include events without
 * id/start — those shapes crash Calendar month/week/day render.
 */
export function normalizeGoogleCalendarEventsList(
  raw: unknown
): GoogleEventForMerge[] {
  if (!Array.isArray(raw)) return [];
  const out: GoogleEventForMerge[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Partial<GoogleEventForMerge>;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    if (!id) continue;
    const start =
      e.start && typeof e.start === 'object'
        ? {
            date:
              typeof e.start.date === 'string' ? e.start.date : undefined,
            dateTime:
              typeof e.start.dateTime === 'string'
                ? e.start.dateTime
                : undefined,
          }
        : undefined;
    if (!start?.date && !start?.dateTime) continue;
    const end =
      e.end && typeof e.end === 'object'
        ? {
            date: typeof e.end.date === 'string' ? e.end.date : undefined,
            dateTime:
              typeof e.end.dateTime === 'string' ? e.end.dateTime : undefined,
          }
        : undefined;
    out.push({
      id,
      summary: typeof e.summary === 'string' ? e.summary : undefined,
      description:
        typeof e.description === 'string' ? e.description : undefined,
      htmlLink: typeof e.htmlLink === 'string' ? e.htmlLink : undefined,
      location: typeof e.location === 'string' ? e.location : undefined,
      colorId: typeof e.colorId === 'string' ? e.colorId : undefined,
      calendarId:
        typeof e.calendarId === 'string' ? e.calendarId : undefined,
      organizer: e.organizer,
      calendarBackground:
        typeof e.calendarBackground === 'string'
          ? e.calendarBackground
          : undefined,
      calendarForeground:
        typeof e.calendarForeground === 'string'
          ? e.calendarForeground
          : undefined,
      start,
      end,
      status: typeof e.status === 'string' ? e.status : undefined,
      recurringEventId:
        typeof e.recurringEventId === 'string'
          ? e.recurringEventId
          : undefined,
      recurrence: Array.isArray(e.recurrence)
        ? e.recurrence.filter((r): r is string => typeof r === 'string')
        : undefined,
      extendedProperties: e.extendedProperties,
      updated: typeof e.updated === 'string' ? e.updated : undefined,
    });
  }
  return out;
}

export function newSummitCalendarEventId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `evt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Default end = start + 1 hour (same-day). */
export function defaultEndTime(startTime: string): string {
  const m = startTime.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '10:00';
  let hh = Number(m[1]) + 1;
  const mm = m[2];
  if (hh >= 24) hh = 23;
  return `${String(hh).padStart(2, '0')}:${mm}`;
}

export function eventDayKeys(ev: SummitCalendarEvent): string[] {
  if (!ev.startDate) return [];
  if (ev.allDay || !ev.startTime) {
    // Inclusive range for multi-day all-day
    const end = ev.endDate || ev.startDate;
    const keys: string[] = [];
    let cur = ev.startDate;
    // All-day Google end is exclusive; our store uses inclusive endDate
    let guard = 0;
    while (cur <= end && guard < 60) {
      keys.push(cur);
      cur = addDaysIso(cur, 1);
      guard += 1;
    }
    return keys.length ? keys : [ev.startDate];
  }
  // Timed: include overnight / multi-day spans (end midnight → prior day only)
  const endDate = ev.endDate || ev.startDate;
  const endTime = ev.endTime || defaultEndTime(ev.startTime);
  const endsAtMidnight = endTime === '00:00' || endTime === '0:00';
  const lastDay =
    endsAtMidnight && endDate > ev.startDate
      ? addDaysIso(endDate, -1)
      : endDate;
  if (lastDay <= ev.startDate) return [ev.startDate];
  const keys: string[] = [];
  let cur = ev.startDate;
  let guard = 0;
  while (cur <= lastDay && guard < 60) {
    keys.push(cur);
    cur = addDaysIso(cur, 1);
    guard += 1;
  }
  return keys.length ? keys : [ev.startDate];
}

/**
 * Timed event start/end minutes clipped to a single local day (for week grid).
 * Overnight: start day → until midnight; continuation day → from midnight.
 */
export function timedEventMinutesOnDay(
  ev: Pick<
    SummitCalendarEvent,
    'startDate' | 'endDate' | 'startTime' | 'endTime' | 'allDay'
  >,
  iso: string
): { startMin: number; endMin: number } | null {
  if (ev.allDay || !ev.startTime) return null;
  if (!eventDayKeys(ev as SummitCalendarEvent).includes(iso)) return null;
  const startMin =
    ev.startDate === iso ? minutesFromMidnight(ev.startTime) : 0;
  const endDate = ev.endDate || ev.startDate;
  const endTime = ev.endTime || defaultEndTime(ev.startTime);
  let endMin: number;
  if (endDate > iso) {
    endMin = 24 * 60;
  } else {
    endMin = minutesFromMidnight(endTime);
    if (endTime === '00:00' || endTime === '0:00') endMin = 24 * 60;
  }
  // Keep invalid ranges tiny for collision — never invent a 60‑min block
  if (!(endMin > startMin)) endMin = Math.min(24 * 60, startMin + 1);
  return { startMin, endMin };
}

export function eventOccursOnDay(ev: SummitCalendarEvent, iso: string): boolean {
  return eventDayKeys(ev).includes(iso);
}

export function formatEventTimeLabel(ev: SummitCalendarEvent): string {
  if (ev.allDay || !ev.startTime) return 'All day';
  const [hh, mm] = ev.startTime.split(':').map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return ev.startTime;
  const d = new Date();
  d.setHours(hh, mm, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Minutes from midnight for HH:MM (clamped 0–1439). */
export function minutesFromMidnight(hhmm: string): number {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  const hh = Math.max(0, Math.min(23, Number(m[1])));
  const mm = Math.max(0, Math.min(59, Number(m[2])));
  return hh * 60 + mm;
}

/** Format minutes-from-midnight as HH:MM. */
export function minutesToHhmm(mins: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(mins)));
  const hh = Math.floor(clamped / 60);
  const mm = clamped % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Snap minutes to nearest step (e.g. 30). */
export function snapMinutes(mins: number, step = 30): number {
  const s = Math.max(1, step);
  return Math.round(mins / s) * s;
}

export function formatHourLabel(hour: number): string {
  const d = new Date();
  d.setHours(Math.max(0, Math.min(23, hour)), 0, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric' });
}

/** Week view grid: pixels per hour (Google-ish density). */
export const WEEK_VIEW_HOUR_PX = 52;
export const WEEK_VIEW_HOURS = 24;
export const WEEK_VIEW_SCROLL_HOUR = 6;
/**
 * Minimum painted block height (px) — visual only.
 * Must never inflate collision windows (Google: neighbors that don't
 * overlap in time stay full-width, even if paint is taller).
 */
export const WEEK_VIEW_MIN_EVENT_PX = 22;

/** Minutes spanned by the minimum painted event height (paint hint only). */
export function weekViewMinEventMinutes(): number {
  return Math.ceil((WEEK_VIEW_MIN_EVENT_PX / WEEK_VIEW_HOUR_PX) * 60);
}

/**
 * Clamp timed range for collision. Uses *actual* end — does NOT invent
 * overlaps from visual min-height (Google: touching ends stay stacked).
 * Zero/negative duration → 1 minute (not 60) so short events don't collide.
 */
export function timedCollisionEndMin(startMin: number, endMin: number): number {
  const start = Math.max(0, Math.min(24 * 60, startMin));
  let end = Math.max(0, Math.min(24 * 60, endMin));
  if (!(end > start)) end = Math.min(24 * 60, start + 1);
  return end;
}

/** @deprecated Use timedCollisionEndMin — visual min-height must not invent overlaps. */
export function timedLayoutEndMin(startMin: number, endMin: number): number {
  return timedCollisionEndMin(startMin, endMin);
}

/** Timed block for collision layout (minutes from midnight). */
export type TimedLayoutItem = {
  key: string;
  startMin: number;
  endMin: number;
};

export type TimedLayoutPlacement = {
  key: string;
  /** 0-based column within the overlap cluster */
  column: number;
  /** Total columns in this cluster */
  columnCount: number;
  /** Columns this event spans (expand into free space on the right) */
  colSpan: number;
  /** left as % of day column */
  leftPct: number;
  /** width as % of day column */
  widthPct: number;
  zIndex: number;
};

function intervalsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  // Half-open [start, end): touching endpoints do not collide
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Google Calendar–style side-by-side layout for overlapping timed events.
 * 1) True connected components via pairwise half-open overlap
 * 2) Greedy column assignment (earliest start, longer first)
 * 3) Expand right into unused columns (colSpan)
 *
 * Visual min-height is paint-only — never used for collision.
 * Touching endpoints (A ends when B starts) do NOT overlap.
 */
export function layoutOverlappingTimedEvents(
  items: TimedLayoutItem[]
): Map<string, TimedLayoutPlacement> {
  const out = new Map<string, TimedLayoutPlacement>();
  if (!Array.isArray(items) || items.length === 0) return out;

  const normalized = items
    .filter((it) => it && typeof it.key === 'string')
    .map((it) => ({
      key: it.key,
      startMin: Math.max(0, Math.min(24 * 60, Number(it.startMin) || 0)),
      endMin: timedCollisionEndMin(
        Number(it.startMin) || 0,
        Number(it.endMin) || 0
      ),
    }));
  if (normalized.length === 0) return out;

  const sorted = [...normalized].sort((a, b) => {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    const ad = a.endMin - a.startMin;
    const bd = b.endMin - b.startMin;
    if (ad !== bd) return bd - ad;
    return a.key.localeCompare(b.key);
  });

  // Union-find connected components (only true time overlaps)
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let p = parent.get(k) || k;
    while (p !== (parent.get(p) || p)) p = parent.get(p) || p;
    parent.set(k, p);
    return p;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const it of sorted) parent.set(it.key, it.key);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!;
      if (b.startMin >= a.endMin) break; // sorted by start — no further overlaps with a
      if (intervalsOverlap(a.startMin, a.endMin, b.startMin, b.endMin)) {
        union(a.key, b.key);
      }
    }
  }
  const clusters = new Map<string, typeof normalized>();
  for (const it of sorted) {
    const root = find(it.key);
    const group = clusters.get(root) || [];
    group.push(it);
    clusters.set(root, group);
  }

  for (const group of clusters.values()) {
    const byKey = new Map(group.map((g) => [g.key, g]));
    const groupSorted = [...group].sort((a, b) => {
      if (a.startMin !== b.startMin) return a.startMin - b.startMin;
      const ad = a.endMin - a.startMin;
      const bd = b.endMin - b.startMin;
      if (ad !== bd) return bd - ad;
      return a.key.localeCompare(b.key);
    });
    // columnEnds[c] = exclusive endMin of last event placed in column c
    const columnEnds: number[] = [];
    const assigned: { key: string; column: number }[] = [];
    for (const item of groupSorted) {
      let col = columnEnds.findIndex((end) => end <= item.startMin);
      if (col < 0) {
        col = columnEnds.length;
        columnEnds.push(item.endMin);
      } else {
        columnEnds[col] = item.endMin;
      }
      assigned.push({ key: item.key, column: col });
    }
    const columnCount = Math.max(1, columnEnds.length);

    for (const a of assigned) {
      const item = byKey.get(a.key);
      if (!item) continue;
      let colSpan = 1;
      for (let c = a.column + 1; c < columnCount; c++) {
        const blocked = assigned.some((other) => {
          if (other.key === a.key) return false;
          if (other.column !== c) return false;
          const o = byKey.get(other.key);
          if (!o) return false;
          return intervalsOverlap(
            item.startMin,
            item.endMin,
            o.startMin,
            o.endMin
          );
        });
        if (blocked) break;
        colSpan += 1;
      }
      const leftPct = (a.column / columnCount) * 100;
      const widthPct = (colSpan / columnCount) * 100;
      // Later-starting events sit above earlier ones; higher columns above lower.
      // Adjacent (non-overlapping) still full-width — paint height is clipped by caller.
      const zIndex = 10 + a.column * 2 + Math.floor(item.startMin / 30);
      out.set(a.key, {
        key: a.key,
        column: a.column,
        columnCount,
        colSpan,
        leftPct,
        widthPct,
        zIndex,
      });
    }
  }
  return out;
}

/**
 * Paint height for a timed block. Visual min-height must not invade the next
 * non-overlapping event (Google: neighbors stay full-width, no pile-under).
 * `nextStartMin` = start of the next event that does not time-overlap this one.
 */
export function timedBlockPaintHeightPx(
  startMin: number,
  endMin: number,
  opts?: {
    nextStartMin?: number | null;
    hourPx?: number;
    minPx?: number;
  }
): number {
  const hourPx = opts?.hourPx ?? WEEK_VIEW_HOUR_PX;
  const minPx = opts?.minPx ?? WEEK_VIEW_MIN_EVENT_PX;
  const start = Math.max(0, Math.min(24 * 60, startMin));
  const end = timedCollisionEndMin(start, endMin);
  const naturalPx = Math.max(minPx, ((end - start) / 60) * hourPx);
  const next = opts?.nextStartMin;
  if (next == null || !(next > start)) return naturalPx;
  // Half-open: may paint up to next start, leave 1px gap so titles stay readable
  const maxPx = ((next - start) / 60) * hourPx - 1;
  if (maxPx <= 0) return Math.max(2, Math.min(naturalPx, 4));
  return Math.max(2, Math.min(naturalPx, maxPx));
}

/**
 * Next event start (minutes) that does not time-overlap `item`.
 * Used to clip paint so adjacent events don't pile (TRT under Breakfast).
 */
export function nextNonOverlappingStartMin(
  item: TimedLayoutItem,
  all: TimedLayoutItem[]
): number | undefined {
  const end = timedCollisionEndMin(item.startMin, item.endMin);
  let best: number | undefined;
  for (const other of all) {
    if (!other || other.key === item.key) continue;
    const oStart = Math.max(0, Math.min(24 * 60, Number(other.startMin) || 0));
    const oEnd = timedCollisionEndMin(oStart, Number(other.endMin) || 0);
    if (intervalsOverlap(item.startMin, end, oStart, oEnd)) continue;
    if (oStart < end) continue; // earlier neighbor
    if (best == null || oStart < best) best = oStart;
  }
  return best;
}

export function leadDisplayFromParts(
  first?: string,
  last?: string
): string {
  return [first, last].filter(Boolean).join(' ').trim();
}

export function normalizeStoredCalendarEvents(raw: unknown): SummitCalendarEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: SummitCalendarEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Partial<SummitCalendarEvent>;
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    if (!title) continue;
    const startDate =
      typeof e.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.startDate)
        ? e.startDate
        : null;
    if (!startDate) continue;
    const endDate =
      typeof e.endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.endDate)
        ? e.endDate
        : startDate;
    const allDay = Boolean(e.allDay) || !e.startTime;
    const now = new Date().toISOString();
    const startTime =
      !allDay &&
      typeof e.startTime === 'string' &&
      /^\d{1,2}:\d{2}/.test(e.startTime)
        ? e.startTime.slice(0, 5)
        : undefined;
    const endTime =
      !allDay &&
      typeof e.endTime === 'string' &&
      /^\d{1,2}:\d{2}/.test(e.endTime)
        ? e.endTime.slice(0, 5)
        : startTime
          ? defaultEndTime(startTime)
          : undefined;
    const leadId =
      typeof e.leadId === 'number' && Number.isFinite(e.leadId)
        ? e.leadId
        : typeof e.leadId === 'string' && /^\d+$/.test(e.leadId)
          ? Number(e.leadId)
          : undefined;
    const colorId = normalizeGoogleEventColorId(e.colorId);
    const calendarId =
      typeof e.calendarId === 'string' && e.calendarId.trim()
        ? e.calendarId.trim()
        : undefined;
    const calendarColorBg =
      normalizeCssHex(e.calendarColorBg) || undefined;
    const calendarColorFg =
      normalizeCssHex(e.calendarColorFg) || undefined;
    const rruleRaw =
      typeof e.rrule === 'string' && e.rrule.trim()
        ? e.rrule.trim().replace(/^RRULE:/i, '')
        : undefined;
    const recurringEventId =
      typeof e.recurringEventId === 'string' && e.recurringEventId.trim()
        ? e.recurringEventId.trim()
        : undefined;
    out.push({
      id:
        typeof e.id === 'string' && e.id.trim()
          ? e.id.trim()
          : newSummitCalendarEventId(),
      title,
      notes:
        typeof e.notes === 'string' && e.notes.trim() ? e.notes.trim() : undefined,
      startDate,
      endDate,
      startTime,
      endTime,
      allDay,
      leadId,
      leadName:
        typeof e.leadName === 'string' && e.leadName.trim()
          ? e.leadName.trim()
          : undefined,
      googleEventId:
        typeof e.googleEventId === 'string' && e.googleEventId.trim()
          ? e.googleEventId.trim()
          : undefined,
      googleHtmlLink:
        typeof e.googleHtmlLink === 'string' && e.googleHtmlLink.trim()
          ? e.googleHtmlLink.trim()
          : undefined,
      calendarId,
      colorId,
      calendarColorBg,
      calendarColorFg,
      rrule: rruleRaw || undefined,
      recurringEventId,
      updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : now,
      createdAt: typeof e.createdAt === 'string' ? e.createdAt : now,
      source: e.source === 'google' ? 'google' : 'summit',
    });
  }
  return out;
}

/** Parse Summit private props / description markers from a Google event. */
export function parseGoogleEventSummitMeta(event: GoogleEventForMerge): {
  summitEventId?: string;
  summitLeadId?: number;
  summitKind?: string;
} {
  const priv = event.extendedProperties?.private || {};
  let summitEventId = priv.summitEventId?.trim() || undefined;
  let summitKind = priv.summitKind?.trim() || undefined;
  let summitLeadId: number | undefined;
  if (priv.summitLeadId && /^\d+$/.test(priv.summitLeadId)) {
    summitLeadId = Number(priv.summitLeadId);
  }

  const desc = event.description || '';
  if (!summitLeadId) {
    const m =
      desc.match(/Synced from Summit CRM \(lead id (\d+)\)/i) ||
      desc.match(/Summit lead id[:\s]+(\d+)/i) ||
      desc.match(/\[summit-lead:(\d+)\]/i);
    if (m) summitLeadId = Number(m[1]);
  }
  if (!summitEventId) {
    const m = desc.match(/\[summit-event:([^\]]+)\]/i);
    if (m) summitEventId = m[1].trim();
  }
  if (!summitKind) {
    if (/Summit adjustment/i.test(desc) || /synced from summit crm \(lead id/i.test(desc)) {
      summitKind = 'adjustment';
    } else if (summitEventId || /\[summit-event:/i.test(desc)) {
      summitKind = 'event';
    }
  }

  return { summitEventId, summitLeadId, summitKind };
}

function googleStartParts(event: GoogleEventForMerge): {
  startDate: string;
  endDate: string;
  startTime?: string;
  endTime?: string;
  allDay: boolean;
} | null {
  const startRaw = event.start?.date || event.start?.dateTime;
  if (!startRaw) return null;
  const allDay = Boolean(event.start?.date && !event.start?.dateTime);
  if (allDay) {
    const startDate = event.start!.date!;
    // Google all-day end is exclusive
    const endExclusive = event.end?.date || addDaysIso(startDate, 1);
    const endDate = addDaysIso(endExclusive, -1);
    return {
      startDate,
      endDate: endDate < startDate ? startDate : endDate,
      allDay: true,
    };
  }
  const start = new Date(event.start!.dateTime!);
  if (Number.isNaN(start.getTime())) return null;
  const end = event.end?.dateTime
    ? new Date(event.end.dateTime)
    : new Date(start.getTime() + 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const toDate = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const toTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return {
    startDate: toDate(start),
    endDate: toDate(end),
    startTime: toTime(start),
    endTime: toTime(end),
    allDay: false,
  };
}

export function googleEventToSummitEvent(
  event: GoogleEventForMerge
): SummitCalendarEvent | null {
  const parts = googleStartParts(event);
  if (!parts) return null;
  const meta = parseGoogleEventSummitMeta(event);
  if (meta.summitKind === 'adjustment') return null;

  const title = (event.summary || '').trim() || '(No title)';
  const now = event.updated || new Date().toISOString();
  let notes = (event.description || '').trim() || undefined;
  if (notes) {
    // Strip Summit sync footers from displayed notes
    notes = notes
      .replace(/\n*\[summit-event:[^\]]+\]/gi, '')
      .replace(/\n*\[summit-lead:\d+\]/gi, '')
      .replace(/\n*Synced from Summit CRM[^\n]*/gi, '')
      .replace(/\n*Summit event · Linked lead:[^\n]*/gi, '')
      .trim() || undefined;
  }

  // Prefer real calendarList id; never invent "primary" when unknown (wrong cal → Cobalt)
  const calendarId =
    (event.calendarId || event.organizer?.email || '').trim() || undefined;
  const calendarColorBg =
    normalizeCssHex(event.calendarBackground) || undefined;
  const calendarColorFg =
    normalizeCssHex(event.calendarForeground) ||
    (calendarColorBg ? contrastTextOnBg(calendarColorBg) : undefined);

  const rruleFromRecurrence = Array.isArray(event.recurrence)
    ? event.recurrence
        .map((r) => String(r || '').trim())
        .find((r) => /^RRULE:/i.test(r) || /^FREQ=/i.test(r))
    : undefined;
  const rrule = rruleFromRecurrence
    ? rruleFromRecurrence.replace(/^RRULE:/i, '').trim() || undefined
    : undefined;
  const recurringEventId =
    typeof event.recurringEventId === 'string' && event.recurringEventId.trim()
      ? event.recurringEventId.trim()
      : undefined;

  // Stable id: one local row per Google instance; masters keep summitEventId
  const id =
    recurringEventId && meta.summitEventId
      ? `${meta.summitEventId}__${event.id}`
      : recurringEventId
        ? `gcal_${event.id}`
        : meta.summitEventId || newSummitCalendarEventId();

  return {
    id,
    title,
    notes,
    startDate: parts.startDate,
    endDate: parts.endDate,
    startTime: parts.startTime,
    endTime: parts.endTime,
    allDay: parts.allDay,
    leadId: meta.summitLeadId,
    googleEventId: event.id,
    googleHtmlLink: event.htmlLink,
    calendarId,
    colorId: normalizeGoogleEventColorId(event.colorId),
    calendarColorBg,
    calendarColorFg,
    rrule,
    recurringEventId,
    updatedAt: now,
    createdAt: now,
    source: 'google',
  };
}
