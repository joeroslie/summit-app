/**
 * Google Calendar ↔ Summit merge / delete-on-pull.
 *
 * Pull is authoritative for Google-linked locals in the loaded time window:
 * if a local event has googleEventId (or source === 'google') and overlaps the
 * pull range but is missing from the pull results (or cancelled), it is removed.
 * Summit-only events (no google link) are never deleted by a pull.
 */

import {
  googleEventToSummitEvent,
  parseGoogleEventSummitMeta,
  type GoogleEventForMerge,
  type SummitCalendarEvent,
} from '@/lib/summit-calendar';

export type CalendarPullWindow = {
  /** Inclusive YYYY-MM-DD (month grid start) */
  startDate: string;
  /** Exclusive YYYY-MM-DD (day after grid end) */
  endDateExclusive: string;
  /** ISO datetime for Google API timeMin */
  timeMin: string;
  /** ISO datetime for Google API timeMax */
  timeMax: string;
};

export type MergeGooglePullResult = {
  events: SummitCalendarEvent[];
  imported: number;
  updated: number;
  /** Google-linked locals removed because missing/cancelled from pull (in window) */
  removed: number;
  /** googleEventIds removed this merge (for purging parallel UI stores) */
  removedGoogleIds: string[];
  /** False when pull was incomplete — delete-on-pull was skipped */
  pullAuthoritative: boolean;
};

/** Local YYYY-MM-DD from a Date (no UTC shift). */
export function toLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfWeekSunday(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - x.getDay());
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

/**
 * 6-week month grid window (same as Calendar UI + loadGoogleEvents).
 * Google list uses [timeMin, timeMax); local delete uses [startDate, endDateExclusive).
 */
export function pullWindowForMonthCursor(cursor: Date): CalendarPullWindow {
  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  monthStart.setHours(0, 0, 0, 0);
  const gridStart = startOfWeekSunday(monthStart);
  const gridEnd = addDays(gridStart, 42);
  gridStart.setHours(0, 0, 0, 0);
  gridEnd.setHours(0, 0, 0, 0);
  return {
    startDate: toLocalIsoDate(gridStart),
    endDateExclusive: toLocalIsoDate(gridEnd),
    timeMin: gridStart.toISOString(),
    timeMax: gridEnd.toISOString(),
  };
}

/** True when local event overlaps the pull date window. */
export function eventOverlapsPullWindow(
  ev: Pick<SummitCalendarEvent, 'startDate' | 'endDate'>,
  window: Pick<CalendarPullWindow, 'startDate' | 'endDateExclusive'>
): boolean {
  const start = (ev.startDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return false;
  const endRaw = (ev.endDate || ev.startDate || '').trim();
  const end = /^\d{4}-\d{2}-\d{2}$/.test(endRaw) ? endRaw : start;
  // Overlap: start < endExclusive && end >= startDate
  return start < window.endDateExclusive && end >= window.startDate;
}

/** Google pull is authoritative for these locals (within window). */
export function isGoogleLinkedCalendarEvent(ev: SummitCalendarEvent): boolean {
  return Boolean(ev.googleEventId) || ev.source === 'google';
}

/**
 * True when a local googleEventId is still represented in the pull.
 * Handles recurring: master id matches any instance `{master}_{timestamp}`.
 */
export function googleIdPresentInPull(
  localGoogleId: string,
  remoteIds: Set<string>,
  remoteRecurringMasters: Set<string>
): boolean {
  const id = (localGoogleId || '').trim();
  if (!id) return false;
  if (remoteIds.has(id)) return true;
  if (remoteRecurringMasters.has(id)) return true;
  // Local stored master; pull has expanded instances
  for (const rid of remoteIds) {
    if (rid.startsWith(`${id}_`)) return true;
  }
  // Local stored instance; extract master prefix before last `_` + digit/timestamp
  const m = id.match(/^(.*)_\d{8}T\d{6}Z$/);
  if (m?.[1] && (remoteIds.has(m[1]) || remoteRecurringMasters.has(m[1]))) {
    return true;
  }
  return false;
}

/**
 * Merge Google Calendar events into local Summit events:
 * - Skip Summit adjustment-synced events (live on leads) — still count as present
 * - Update locals that map by googleEventId or summitEventId
 * - Import Google-only events
 * - Leave Summit-only locals alone (caller should push those)
 * - When pullWindow is set: delete Google-linked locals in-range missing from pull
 * - Always delete locals whose googleEventId is in cancelledIds
 */
export function mergeGoogleCalendarEventsIntoLocal(
  local: SummitCalendarEvent[],
  remote: GoogleEventForMerge[],
  opts?: {
    knownAdjustmentGoogleIds?: Set<string>;
    /** When provided, pull is authoritative for Google-linked events in this range */
    pullWindow?: Pick<CalendarPullWindow, 'startDate' | 'endDateExclusive'>;
    /**
     * Google event ids just pushed from Summit — never delete-on-pull
     * (list APIs can lag a moment after create/PATCH).
     */
    retainGoogleIds?: Set<string>;
    /** Explicit cancelled ids from showDeleted pull */
    cancelledGoogleIds?: Set<string>;
    /**
     * When false, import/update/cancel only — never delete-on-pull for missing ids.
     * Use when the Google list call failed / fetched zero calendars.
     */
    pullAuthoritative?: boolean;
    /**
     * Calendar ids that were successfully listed this pull.
     * Locals on calendars not in this set are never delete-on-pull'd
     * (partial multi-cal failure must not wipe Eucalyptus/Mango events).
     */
    fetchedCalendarIds?: Set<string>;
  }
): MergeGooglePullResult {
  const localSafe = Array.isArray(local) ? local : [];
  const remoteSafe = Array.isArray(remote) ? remote : [];
  const adjIds = opts?.knownAdjustmentGoogleIds || new Set<string>();
  const retainIds = opts?.retainGoogleIds || new Set<string>();
  const cancelledIds = new Set(opts?.cancelledGoogleIds || []);
  const pullWindow = opts?.pullWindow;
  const pullAuthoritative = opts?.pullAuthoritative !== false;
  const fetchedCalIds = opts?.fetchedCalendarIds;

  const byGoogle = new Map<string, SummitCalendarEvent>();
  const byId = new Map<string, SummitCalendarEvent>();
  for (const e of localSafe) {
    byId.set(e.id, e);
    if (e.googleEventId) byGoogle.set(e.googleEventId, e);
  }

  let imported = 0;
  let updated = 0;
  let removed = 0;
  const removedGoogleIds: string[] = [];
  const remoteIds = new Set<string>();
  const remoteRecurringMasters = new Set<string>();
  const nextById = new Map<string, SummitCalendarEvent>();

  // Keep Summit-only (no google link) always
  for (const e of localSafe) {
    if (!isGoogleLinkedCalendarEvent(e)) nextById.set(e.id, e);
  }

  for (const ge of remoteSafe) {
    if (!ge?.id) continue;
    const status = (ge.status || '').toLowerCase();
    if (status === 'cancelled') {
      cancelledIds.add(ge.id);
      if (ge.recurringEventId) cancelledIds.add(ge.recurringEventId);
      continue;
    }
    remoteIds.add(ge.id);
    if (ge.recurringEventId) remoteRecurringMasters.add(ge.recurringEventId);

    const meta = parseGoogleEventSummitMeta(ge);
    // Still present on Google — do not delete-on-pull even if we skip import
    if (meta.summitKind === 'adjustment' || adjIds.has(ge.id)) {
      continue;
    }
    const mapped = googleEventToSummitEvent(ge);
    if (!mapped) continue;

    const masterLocal =
      (ge.recurringEventId
        ? byGoogle.get(ge.recurringEventId)
        : undefined) ||
      (ge.recurringEventId && meta.summitEventId
        ? byId.get(meta.summitEventId)
        : undefined);

    // Recurring instances: never collapse onto the Summit master row
    if (ge.recurringEventId) {
      const existingInstance = byGoogle.get(ge.id);
      const instanceId =
        existingInstance?.id ||
        (meta.summitEventId
          ? `${meta.summitEventId}__${ge.id}`
          : mapped.id);
      const merged: SummitCalendarEvent = {
        ...(existingInstance || mapped),
        id: instanceId,
        title: mapped.title,
        notes: mapped.notes,
        startDate: mapped.startDate,
        endDate: mapped.endDate,
        startTime: mapped.startTime,
        endTime: mapped.endTime,
        allDay: mapped.allDay,
        leadId:
          mapped.leadId ??
          existingInstance?.leadId ??
          masterLocal?.leadId,
        leadName:
          existingInstance?.leadName ||
          masterLocal?.leadName ||
          mapped.leadName,
        googleEventId: ge.id,
        googleHtmlLink: mapped.googleHtmlLink || existingInstance?.googleHtmlLink,
        calendarId: mapped.calendarId || existingInstance?.calendarId,
        colorId: mapped.colorId ?? existingInstance?.colorId ?? masterLocal?.colorId,
        calendarColorBg: mapped.calendarColorBg,
        calendarColorFg: mapped.calendarColorFg,
        rrule:
          mapped.rrule ||
          existingInstance?.rrule ||
          masterLocal?.rrule,
        recurringEventId: ge.recurringEventId,
        updatedAt: mapped.updatedAt,
        createdAt:
          existingInstance?.createdAt ||
          masterLocal?.createdAt ||
          mapped.createdAt,
        source:
          existingInstance?.source ||
          masterLocal?.source ||
          mapped.source,
      };
      nextById.set(instanceId, merged);
      byGoogle.set(ge.id, merged);
      if (existingInstance) updated += 1;
      else imported += 1;
      continue;
    }

    const existing =
      byGoogle.get(ge.id) ||
      (meta.summitEventId ? byId.get(meta.summitEventId) : undefined);

    if (existing) {
      const merged: SummitCalendarEvent = {
        ...existing,
        title: mapped.title,
        notes: mapped.notes,
        startDate: mapped.startDate,
        endDate: mapped.endDate,
        startTime: mapped.startTime,
        endTime: mapped.endTime,
        allDay: mapped.allDay,
        leadId: mapped.leadId ?? existing.leadId,
        leadName: existing.leadName,
        googleEventId: ge.id,
        googleHtmlLink: mapped.googleHtmlLink || existing.googleHtmlLink,
        // Pull calendar id wins — fixes stale "primary" after multi-cal reconnect
        calendarId: mapped.calendarId || existing.calendarId,
        colorId: mapped.colorId,
        // Pull colors win (including undefined) so stale Cobalt cannot stick
        calendarColorBg: mapped.calendarColorBg,
        calendarColorFg: mapped.calendarColorFg,
        rrule: mapped.rrule || existing.rrule,
        recurringEventId: mapped.recurringEventId || existing.recurringEventId,
        updatedAt: mapped.updatedAt,
        source: existing.source || mapped.source,
      };
      nextById.set(existing.id, merged);
      // Master→instance remap: drop stale byGoogle master key collision
      if (existing.googleEventId && existing.googleEventId !== ge.id) {
        byGoogle.delete(existing.googleEventId);
      }
      byGoogle.set(ge.id, merged);
      updated += 1;
    } else {
      nextById.set(mapped.id, mapped);
      byGoogle.set(ge.id, mapped);
      imported += 1;
    }
  }

  // Google-linked locals: keep if still on Google or outside pull window; else delete
  for (const e of localSafe) {
    if (!isGoogleLinkedCalendarEvent(e)) continue;
    if (nextById.has(e.id)) continue;

    const gid = (e.googleEventId || '').trim();

    // Explicit cancel from Google (instance or series) — always purge
    if (
      gid &&
      (cancelledIds.has(gid) ||
        (gid.match(/^(.*)_\d{8}T\d{6}Z$/) &&
          cancelledIds.has(gid.replace(/_\d{8}T\d{6}Z$/, ''))))
    ) {
      removed += 1;
      removedGoogleIds.push(gid);
      continue;
    }

    const stillOnGoogle =
      Boolean(gid) &&
      googleIdPresentInPull(gid, remoteIds, remoteRecurringMasters);
    if (stillOnGoogle) {
      // Master shell + expanded instances already imported → drop master (no dual chip)
      const instancesImported = Array.from(nextById.values()).some(
        (x) =>
          Boolean(x.googleEventId) &&
          Boolean(gid) &&
          x.googleEventId !== gid &&
          (x.googleEventId!.startsWith(`${gid}_`) ||
            x.googleEventId === gid)
      );
      if (instancesImported && gid && !remoteIds.has(gid)) {
        removed += 1;
        removedGoogleIds.push(gid);
        continue;
      }
      // e.g. adjustment skip — preserve local link if any
      nextById.set(e.id, e);
      continue;
    }

    // Just pushed from Summit — Google list can lag; do not delete-on-pull
    if (gid && retainIds.has(gid)) {
      nextById.set(e.id, e);
      continue;
    }

    // Incomplete pull — never wipe; partial multi-cal — never wipe unfetched calendars
    if (!pullAuthoritative) {
      nextById.set(e.id, e);
      continue;
    }
    if (fetchedCalIds && fetchedCalIds.size > 0) {
      const calId = (e.calendarId || '').trim();
      if (calId) {
        const calWasFetched =
          fetchedCalIds.has(calId) ||
          (calId === 'primary' && fetchedCalIds.has('primary'));
        if (!calWasFetched) {
          nextById.set(e.id, e);
          continue;
        }
      }
    }

    const inWindow =
      pullWindow != null && eventOverlapsPullWindow(e, pullWindow);

    if (pullWindow != null && inWindow) {
      // Authoritative pull: gone from Google in this window → remove local
      // (includes source===google orphans with no googleEventId)
      removed += 1;
      if (gid) removedGoogleIds.push(gid);
      continue;
    }

    // No window (legacy) or outside window — keep until that month is pulled
    nextById.set(e.id, e);
  }

  // Dedupe by googleEventId — keep newest updatedAt (kills dual local copies)
  const deduped = new Map<string, SummitCalendarEvent>();
  const noGoogle: SummitCalendarEvent[] = [];
  for (const ev of nextById.values()) {
    const gid = (ev.googleEventId || '').trim();
    if (!gid) {
      noGoogle.push(ev);
      continue;
    }
    const prev = deduped.get(gid);
    if (!prev) {
      deduped.set(gid, ev);
      continue;
    }
    const prevT = Date.parse(prev.updatedAt || '') || 0;
    const nextT = Date.parse(ev.updatedAt || '') || 0;
    removed += 1; // dropped duplicate local row (same Google id)
    deduped.set(gid, nextT >= prevT ? ev : prev);
  }

  const events = [...noGoogle, ...deduped.values()].sort((a, b) => {
    if (a.startDate !== b.startDate) return a.startDate.localeCompare(b.startDate);
    const at = a.allDay ? '00:00' : a.startTime || '00:00';
    const bt = b.allDay ? '00:00' : b.startTime || '00:00';
    if (at !== bt) return at.localeCompare(bt);
    return a.title.localeCompare(b.title);
  });

  return {
    events,
    imported,
    updated,
    removed,
    removedGoogleIds,
    pullAuthoritative,
  };
}

/**
 * Soft-fail wrapper — never throws; returns locals unchanged on error.
 */
export function safeMergeGoogleCalendarEventsIntoLocal(
  local: SummitCalendarEvent[],
  remote: GoogleEventForMerge[],
  opts?: {
    knownAdjustmentGoogleIds?: Set<string>;
    pullWindow?: Pick<CalendarPullWindow, 'startDate' | 'endDateExclusive'>;
    retainGoogleIds?: Set<string>;
    cancelledGoogleIds?: Set<string>;
    pullAuthoritative?: boolean;
    fetchedCalendarIds?: Set<string>;
  }
): MergeGooglePullResult {
  try {
    return mergeGoogleCalendarEventsIntoLocal(local, remote, opts);
  } catch (err) {
    console.error('Google calendar merge failed (soft):', err);
    const localSafe = Array.isArray(local) ? local : [];
    return {
      events: localSafe,
      imported: 0,
      updated: 0,
      removed: 0,
      removedGoogleIds: [],
      pullAuthoritative: false,
    };
  }
}
