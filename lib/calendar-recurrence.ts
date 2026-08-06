/**
 * Google Calendar–style recurrence helpers (RRULE build / parse / expand).
 * Covers basic presets + custom interval/ends — not every Google edge case.
 */

export const RRULE_WEEKDAYS = [
  'SU',
  'MO',
  'TU',
  'WE',
  'TH',
  'FR',
  'SA',
] as const;

export type RruleWeekday = (typeof RRULE_WEEKDAYS)[number];

export type RecurrenceEnds =
  | { kind: 'never' }
  | { kind: 'on'; untilDate: string }
  | { kind: 'after'; count: number };

export type RecurrenceFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

/** Structured recurrence for the create/edit UI. */
export type RecurrenceDraft = {
  /** none = Does not repeat */
  preset:
    | 'none'
    | 'daily'
    | 'weekly'
    | 'weekdays'
    | 'monthly'
    | 'yearly'
    | 'custom';
  freq: RecurrenceFreq;
  interval: number;
  /** BYDAY for weekly / weekdays / custom weekly */
  byDay: RruleWeekday[];
  ends: RecurrenceEnds;
};

export const DEFAULT_RECURRENCE_DRAFT: RecurrenceDraft = {
  preset: 'none',
  freq: 'DAILY',
  interval: 1,
  byDay: [],
  ends: { kind: 'never' },
};

const WEEKDAY_LABELS: Record<RruleWeekday, string> = {
  SU: 'Sunday',
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
};

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** JS getDay() 0=Sun … 6=Sat → RRULE weekday. */
export function jsDayToRruleWeekday(jsDay: number): RruleWeekday {
  return RRULE_WEEKDAYS[((jsDay % 7) + 7) % 7]!;
}

export function isoDateToJsDay(iso: string): number {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? 0 : d.getDay();
}

export function stripRrulePrefix(raw?: string | null): string | undefined {
  if (raw == null) return undefined;
  let s = String(raw).trim();
  if (!s) return undefined;
  if (/^RRULE:/i.test(s)) s = s.replace(/^RRULE:/i, '').trim();
  return s || undefined;
}

export function withRrulePrefix(rrule?: string | null): string | undefined {
  const body = stripRrulePrefix(rrule);
  if (!body) return undefined;
  return `RRULE:${body}`;
}

function parseIsoDateParts(iso: string): {
  y: number;
  m: number;
  d: number;
} | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function formatIso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function addDaysIsoLocal(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return formatIso(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function untilToRruleDate(iso: string): string {
  // All-day UNTIL as YYYYMMDD (Google accepts; floating)
  return iso.replace(/-/g, '');
}

function parseUntilDate(raw: string): string | undefined {
  // YYYYMMDD or YYYYMMDDTHHMMSSZ
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function parseRruleParts(
  rrule?: string | null
): Record<string, string> | null {
  const body = stripRrulePrefix(rrule);
  if (!body) return null;
  const parts: Record<string, string> = {};
  for (const seg of body.split(';')) {
    const i = seg.indexOf('=');
    if (i <= 0) continue;
    const k = seg.slice(0, i).trim().toUpperCase();
    const v = seg.slice(i + 1).trim();
    if (k && v) parts[k] = v;
  }
  return parts.FREQ ? parts : null;
}

export function recurrenceDraftFromRrule(
  rrule: string | undefined | null,
  startDate: string
): RecurrenceDraft {
  const parts = parseRruleParts(rrule);
  if (!parts) return { ...DEFAULT_RECURRENCE_DRAFT };

  const freq = (parts.FREQ || 'DAILY').toUpperCase() as RecurrenceFreq;
  const interval = Math.max(1, Number(parts.INTERVAL) || 1);
  const byDay = (parts.BYDAY || '')
    .split(',')
    .map((d) => d.trim().toUpperCase().replace(/^[+-]?\d+/, ''))
    .filter((d): d is RruleWeekday =>
      (RRULE_WEEKDAYS as readonly string[]).includes(d)
    );

  let ends: RecurrenceEnds = { kind: 'never' };
  if (parts.COUNT && /^\d+$/.test(parts.COUNT)) {
    ends = { kind: 'after', count: Math.max(1, Number(parts.COUNT)) };
  } else if (parts.UNTIL) {
    const untilDate = parseUntilDate(parts.UNTIL);
    if (untilDate) ends = { kind: 'on', untilDate };
  }

  const startWd = jsDayToRruleWeekday(isoDateToJsDay(startDate));
  const weekdays = ['MO', 'TU', 'WE', 'TH', 'FR'] as RruleWeekday[];
  const byDaySorted = [...byDay].sort(
    (a, b) => RRULE_WEEKDAYS.indexOf(a) - RRULE_WEEKDAYS.indexOf(b)
  );
  const weekdaysSorted = [...weekdays].sort(
    (a, b) => RRULE_WEEKDAYS.indexOf(a) - RRULE_WEEKDAYS.indexOf(b)
  );

  let preset: RecurrenceDraft['preset'] = 'custom';
  if (interval === 1 && ends.kind === 'never') {
    if (freq === 'DAILY' && byDay.length === 0) preset = 'daily';
    else if (
      freq === 'WEEKLY' &&
      byDaySorted.length === 5 &&
      byDaySorted.every((d, i) => d === weekdaysSorted[i])
    ) {
      preset = 'weekdays';
    } else if (
      freq === 'WEEKLY' &&
      byDay.length === 1 &&
      byDay[0] === startWd
    ) {
      preset = 'weekly';
    } else if (freq === 'MONTHLY' && byDay.length === 0) {
      preset = 'monthly';
    } else if (freq === 'YEARLY' && byDay.length === 0) {
      preset = 'yearly';
    }
  } else if (
    interval === 1 &&
    freq === 'WEEKLY' &&
    byDaySorted.length === 5 &&
    byDaySorted.every((d, i) => d === weekdaysSorted[i]) &&
    ends.kind === 'never'
  ) {
    preset = 'weekdays';
  }

  return {
    preset,
    freq:
      freq === 'WEEKLY' ||
      freq === 'MONTHLY' ||
      freq === 'YEARLY' ||
      freq === 'DAILY'
        ? freq
        : 'DAILY',
    interval,
    byDay:
      byDay.length > 0
        ? byDay
        : freq === 'WEEKLY'
          ? [startWd]
          : [],
    ends,
  };
}

export function buildRruleFromDraft(
  draft: RecurrenceDraft,
  startDate: string
): string | undefined {
  if (!draft || draft.preset === 'none') return undefined;

  const startWd = jsDayToRruleWeekday(isoDateToJsDay(startDate));
  let freq: RecurrenceFreq = draft.freq;
  let interval = Math.max(1, Math.min(365, Number(draft.interval) || 1));
  let byDay: RruleWeekday[] = [];

  if (draft.preset === 'daily') {
    freq = 'DAILY';
    interval = 1;
    byDay = [];
  } else if (draft.preset === 'weekly') {
    freq = 'WEEKLY';
    interval = 1;
    byDay = [startWd];
  } else if (draft.preset === 'weekdays') {
    freq = 'WEEKLY';
    interval = 1;
    byDay = ['MO', 'TU', 'WE', 'TH', 'FR'];
  } else if (draft.preset === 'monthly') {
    freq = 'MONTHLY';
    interval = 1;
    byDay = [];
  } else if (draft.preset === 'yearly') {
    freq = 'YEARLY';
    interval = 1;
    byDay = [];
  } else {
    // custom
    freq = draft.freq;
    interval = Math.max(1, Math.min(365, Number(draft.interval) || 1));
    if (freq === 'WEEKLY') {
      byDay =
        draft.byDay.length > 0
          ? [...new Set(draft.byDay)]
          : [startWd];
    } else {
      byDay = [];
    }
  }

  const parts = [`FREQ=${freq}`];
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (byDay.length > 0) {
    const ordered = [...byDay].sort(
      (a, b) => RRULE_WEEKDAYS.indexOf(a) - RRULE_WEEKDAYS.indexOf(b)
    );
    parts.push(`BYDAY=${ordered.join(',')}`);
  }

  const ends =
    draft.preset === 'custom' || draft.ends.kind !== 'never'
      ? draft.ends
      : ({ kind: 'never' } as RecurrenceEnds);

  // Presets always never-end; custom may set ends
  if (draft.preset === 'custom') {
    if (ends.kind === 'after' && ends.count > 0) {
      parts.push(`COUNT=${Math.max(1, Math.min(999, Math.floor(ends.count)))}`);
    } else if (
      ends.kind === 'on' &&
      /^\d{4}-\d{2}-\d{2}$/.test(ends.untilDate)
    ) {
      parts.push(`UNTIL=${untilToRruleDate(ends.untilDate)}`);
    }
  }

  return parts.join(';');
}

/** Google-style short label for the recurrence dropdown. */
export function recurrenceLabel(
  draft: RecurrenceDraft,
  startDate: string
): string {
  if (draft.preset === 'none') return 'Does not repeat';
  const parts = parseIsoDateParts(startDate);
  const wd = WEEKDAY_LABELS[jsDayToRruleWeekday(isoDateToJsDay(startDate))];
  if (draft.preset === 'daily') return 'Daily';
  if (draft.preset === 'weekly') return `Weekly on ${wd}`;
  if (draft.preset === 'weekdays') return 'Every weekday (Monday to Friday)';
  if (draft.preset === 'monthly') {
    const day = parts?.d ?? 1;
    return `Monthly on day ${day}`;
  }
  if (draft.preset === 'yearly') {
    if (parts) {
      return `Annually on ${MONTH_NAMES[parts.m - 1]} ${parts.d}`;
    }
    return 'Annually';
  }
  // custom
  const interval = Math.max(1, draft.interval || 1);
  const unit =
    draft.freq === 'DAILY'
      ? interval === 1
        ? 'day'
        : 'days'
      : draft.freq === 'WEEKLY'
        ? interval === 1
          ? 'week'
          : 'weeks'
        : draft.freq === 'MONTHLY'
          ? interval === 1
            ? 'month'
            : 'months'
          : interval === 1
            ? 'year'
            : 'years';
  let label =
    interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}`;
  if (draft.freq === 'WEEKLY' && draft.byDay.length > 0) {
    const days = [...draft.byDay]
      .sort((a, b) => RRULE_WEEKDAYS.indexOf(a) - RRULE_WEEKDAYS.indexOf(b))
      .map((d) => WEEKDAY_LABELS[d].slice(0, 3))
      .join(', ');
    label += ` on ${days}`;
  }
  if (draft.ends.kind === 'after') {
    label += `, ${draft.ends.count} times`;
  } else if (draft.ends.kind === 'on') {
    label += `, until ${draft.ends.untilDate}`;
  }
  return label;
}

export type RecurrencePresetOption = {
  value: RecurrenceDraft['preset'];
  label: string;
};

/** Dropdown options twinning Google’s basic set (labels depend on start date). */
export function recurrencePresetOptions(
  startDate: string
): RecurrencePresetOption[] {
  const base = recurrenceDraftFromRrule(undefined, startDate);
  const daily = { ...base, preset: 'daily' as const };
  const weekly = { ...base, preset: 'weekly' as const };
  const weekdays = { ...base, preset: 'weekdays' as const };
  const monthly = { ...base, preset: 'monthly' as const };
  const yearly = { ...base, preset: 'yearly' as const };
  return [
    { value: 'none', label: 'Does not repeat' },
    { value: 'daily', label: recurrenceLabel(daily, startDate) },
    { value: 'weekly', label: recurrenceLabel(weekly, startDate) },
    { value: 'monthly', label: recurrenceLabel(monthly, startDate) },
    { value: 'yearly', label: recurrenceLabel(yearly, startDate) },
    { value: 'weekdays', label: recurrenceLabel(weekdays, startDate) },
    { value: 'custom', label: 'Custom…' },
  ];
}

/**
 * Expand a master event with rrule into occurrence dates (YYYY-MM-DD)
 * overlapping [rangeStart, rangeEndInclusive]. Cap for safety.
 */
export function expandRruleOccurrenceDates(
  startDate: string,
  rrule: string,
  rangeStart: string,
  rangeEndInclusive: string,
  maxOccurrences = 366
): string[] {
  const parts = parseRruleParts(rrule);
  if (!parts || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return [startDate];

  const freq = (parts.FREQ || 'DAILY').toUpperCase();
  const interval = Math.max(1, Number(parts.INTERVAL) || 1);
  const byDay = (parts.BYDAY || '')
    .split(',')
    .map((d) => d.trim().toUpperCase().replace(/^[+-]?\d+/, ''))
    .filter((d): d is RruleWeekday =>
      (RRULE_WEEKDAYS as readonly string[]).includes(d)
    );
  const count = parts.COUNT ? Math.max(1, Number(parts.COUNT)) : undefined;
  const until = parts.UNTIL ? parseUntilDate(parts.UNTIL) : undefined;

  const out: string[] = [];
  let n = 0;
  let guard = 0;
  const hardMax = Math.min(maxOccurrences, count || maxOccurrences);
  const inRange = (iso: string) =>
    iso >= rangeStart && iso <= rangeEndInclusive;

  if (freq === 'DAILY') {
    let cur = startDate;
    while (guard++ < 2000 && n < hardMax) {
      if (until && cur > until) break;
      if (count != null && n >= count) break;
      if (cur > rangeEndInclusive) break;
      if (inRange(cur)) out.push(cur);
      n += 1;
      cur = addDaysIsoLocal(cur, interval);
    }
  } else if (freq === 'WEEKLY') {
    const days =
      byDay.length > 0
        ? byDay
        : [jsDayToRruleWeekday(isoDateToJsDay(startDate))];
    const start = new Date(`${startDate}T12:00:00`);
    const weekStart = new Date(start);
    weekStart.setDate(start.getDate() - start.getDay()); // Sunday
    let weekIndex = 0;
    while (guard++ < 2000 && n < hardMax) {
      const base = new Date(weekStart);
      base.setDate(weekStart.getDate() + weekIndex * 7 * interval);
      const baseIso = formatIso(
        base.getFullYear(),
        base.getMonth() + 1,
        base.getDate()
      );
      // Week Sunday past range end → no further hits
      if (baseIso > rangeEndInclusive) break;
      for (const wd of [...days].sort(
        (a, b) => RRULE_WEEKDAYS.indexOf(a) - RRULE_WEEKDAYS.indexOf(b)
      )) {
        const day = addDaysIsoLocal(baseIso, RRULE_WEEKDAYS.indexOf(wd));
        if (day < startDate) continue;
        if (until && day > until) return out;
        if (count != null && n >= count) return out;
        n += 1;
        if (inRange(day)) out.push(day);
      }
      weekIndex += 1;
    }
  } else if (freq === 'MONTHLY') {
    const startParts = parseIsoDateParts(startDate);
    if (!startParts) return inRange(startDate) ? [startDate] : [];
    let y = startParts.y;
    let m = startParts.m;
    const dom = startParts.d;
    while (guard++ < 500 && n < hardMax) {
      const last = new Date(y, m, 0).getDate();
      const iso = formatIso(y, m, Math.min(dom, last));
      if (iso >= startDate) {
        if (until && iso > until) break;
        if (count != null && n >= count) break;
        if (iso > rangeEndInclusive) break;
        if (inRange(iso)) out.push(iso);
        n += 1;
      }
      m += interval;
      while (m > 12) {
        m -= 12;
        y += 1;
      }
    }
  } else if (freq === 'YEARLY') {
    const startParts = parseIsoDateParts(startDate);
    if (!startParts) return inRange(startDate) ? [startDate] : [];
    let y = startParts.y;
    while (guard++ < 200 && n < hardMax) {
      const iso = formatIso(y, startParts.m, startParts.d);
      if (iso >= startDate) {
        if (until && iso > until) break;
        if (count != null && n >= count) break;
        if (iso > rangeEndInclusive) break;
        if (inRange(iso)) out.push(iso);
        n += 1;
      }
      y += interval;
    }
  } else if (inRange(startDate)) {
    out.push(startDate);
  }

  return out;
}

/**
 * For display: expand local masters with rrule into virtual instances in range.
 * Skips masters that already have Google-expanded instances in the list.
 * Events without rrule pass through unchanged.
 */
export function expandEventsForDisplayRange(
  events: Array<{
    id: string;
    startDate: string;
    endDate: string;
    startTime?: string;
    endTime?: string;
    allDay: boolean;
    rrule?: string;
    googleEventId?: string;
    recurringEventId?: string;
    [key: string]: unknown;
  }>,
  rangeStart: string,
  rangeEndInclusive: string
): Array<(typeof events)[number] & { _occurrenceDate?: string }> {
  const list = Array.isArray(events) ? events : [];
  const googleIds = new Set(
    list.map((e) => (e.googleEventId || '').trim()).filter(Boolean)
  );
  const recurringMastersPresent = new Set(
    list
      .map((e) => (e.recurringEventId || '').trim())
      .filter(Boolean)
  );

  const out: Array<(typeof events)[number] & { _occurrenceDate?: string }> =
    [];

  for (const ev of list) {
    const rrule = stripRrulePrefix(ev.rrule as string | undefined);
    const gid = (ev.googleEventId || '').trim();
    const isMasterShell =
      Boolean(rrule) &&
      !ev.recurringEventId &&
      // Google already expanded this series into instances
      (Boolean(gid && recurringMastersPresent.has(gid)) ||
        Array.from(googleIds).some((id) => id.startsWith(`${gid}_`)));

    if (isMasterShell) {
      // Drop master — instances already in list
      continue;
    }

    if (!rrule || ev.recurringEventId) {
      out.push(ev);
      continue;
    }

    // Local (or unsynced) master — expand into view range
    const dates = expandRruleOccurrenceDates(
      ev.startDate,
      rrule,
      rangeStart,
      rangeEndInclusive
    );
    if (dates.length === 0) continue;

    const spanDays = (() => {
      if (!ev.endDate || ev.endDate <= ev.startDate) return 0;
      const a = new Date(`${ev.startDate}T12:00:00`);
      const b = new Date(`${ev.endDate}T12:00:00`);
      return Math.max(
        0,
        Math.round((b.getTime() - a.getTime()) / 86400000)
      );
    })();

    for (const date of dates) {
      const endDate =
        spanDays > 0 ? addDaysIsoLocal(date, spanDays) : date;
      out.push({
        ...ev,
        id: `${ev.id}__occ_${date}`,
        startDate: date,
        endDate,
        _occurrenceDate: date,
      });
    }
  }

  return out;
}
