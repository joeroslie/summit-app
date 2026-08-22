/**
 * Google Calendar helpers for Summit CRM.
 * OAuth: server code flow stores an encrypted refresh token on the signed-in
 * Summit user (`user_google_oauth`). GIS popup is local-only fallback.
 */

export const GCAL_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/tasks',
  'openid',
  'email',
  'profile',
].join(' ');

export const GCAL_COOKIE = 'summit_gcal';

export type GcalTokenBundle = {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number; // ms epoch
  email?: string;
  name?: string;
  scopes?: string;
};

export type LeadCalendarPayload = {
  id: number;
  clientFirstName: string;
  clientLastName: string;
  clientAddress?: string;
  clientCity?: string;
  clientState?: string;
  clientZip?: string;
  clientPhone?: string;
  clientEmail?: string;
  jobNumber?: string;
  category: string;
  date?: string;
  /** Insurance adjuster appointment (YYYY-MM-DD) */
  adjustmentDate?: string;
  /** Optional local time HH:MM */
  adjustmentTime?: string;
  notes?: { text: string; date: string }[];
  calendarEventId?: string;
};

export type SyncLeadResult = {
  leadId: number;
  eventId?: string;
  htmlLink?: string;
  startDate?: string;
  error?: string;
};

export function getGoogleClientConfig() {
  const clientId =
    process.env.GOOGLE_CLIENT_ID ||
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ||
    '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  // Client ID alone enables browser GIS connect; secret enables server OAuth code flow
  return {
    clientId,
    clientSecret,
    configured: Boolean(clientId),
    serverOAuth: Boolean(clientId && clientSecret),
  };
}

export function getOAuthRedirectUri(origin: string) {
  return `${origin.replace(/\/$/, '')}/api/google/calendar/callback`;
}

/**
 * Origin used for Google OAuth redirect_uri (exact match in Cloud Console).
 * Prefer NEXT_PUBLIC_APP_URL in production so preview hosts don't silently
 * mint a URI that isn't registered.
 */
export function resolveOAuthOrigin(req: {
  nextUrl: { origin: string };
  headers: Headers;
}): string {
  const host =
    req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ||
    req.headers.get('host')?.split(',')[0]?.trim() ||
    '';
  const isLocal =
    host.startsWith('localhost') ||
    host.startsWith('127.0.0.1') ||
    /^192\.168\./.test(host) ||
    /^10\./.test(host);

  if (!isLocal) {
    const explicit = (
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.APP_URL ||
      ''
    )
      .trim()
      .replace(/\/$/, '');
    if (explicit) return explicit;
  }

  const proto =
    req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || '';
  if (host) {
    const scheme =
      proto ||
      (isLocal ? 'http' : 'https');
    return `${scheme}://${host}`;
  }
  return req.nextUrl.origin.replace(/\/$/, '');
}

export function buildAuthUrl(
  origin: string,
  state: string,
  opts?: { forceConsent?: boolean }
) {
  const { clientId } = getGoogleClientConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getOAuthRedirectUri(origin),
    response_type: 'code',
    scope: GCAL_SCOPES,
    access_type: 'offline',
    prompt: opts?.forceConsent === false ? 'select_account' : 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForTokens(
  code: string,
  origin: string
): Promise<GcalTokenBundle> {
  const { clientId, clientSecret } = getGoogleClientConfig();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: getOAuthRedirectUri(origin),
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiry_date: data.expires_in
      ? Date.now() + data.expires_in * 1000
      : undefined,
    scopes: data.scope,
  };
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<GcalTokenBundle> {
  const { clientId, clientSecret } = getGoogleClientConfig();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${err}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    expires_in?: number;
  };
  return {
    access_token: data.access_token,
    refresh_token: refreshToken,
    expiry_date: data.expires_in
      ? Date.now() + data.expires_in * 1000
      : undefined,
  };
}

export async function fetchAccessTokenScopes(
  accessToken: string
): Promise<string[]> {
  try {
    const res = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { scope?: string };
    return (data.scope || '')
      .trim()
      .split(/[\s,+]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function revokeGoogleToken(token: string): Promise<void> {
  try {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
  } catch {
    /* best-effort */
  }
}

export async function fetchGoogleUserEmail(
  accessToken: string
): Promise<{ email?: string; name?: string }> {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return {};
  const data = (await res.json()) as { email?: string; name?: string };
  return { email: data.email, name: data.name };
}

/** Parse loose date strings (MM/DD/YYYY, YYYY-MM-DD, locale) into YYYY-MM-DD. */
export function toIsoDate(raw?: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim();
  // Already ISO date
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // ISO datetime
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Calendar / Google event date — adjustment appointments only.
 * Never uses date of loss, follow-up, or creation date.
 */
export function resolveLeadEventDate(
  lead: LeadCalendarPayload
): string | null {
  return toIsoDate(lead.adjustmentDate);
}

/** Normalize HH:MM (from `<input type="time">`) */
export function normalizeAdjustmentTime(raw?: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function addOneHour(isoDate: string, hhmm: string): { date: string; time: string } {
  const [hh, mm] = hhmm.split(':').map(Number);
  let endH = hh + 1;
  let endDate = isoDate;
  if (endH >= 24) {
    endH -= 24;
    const d = new Date(`${isoDate}T12:00:00`);
    d.setDate(d.getDate() + 1);
    endDate =
      toIsoDate(
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      ) || isoDate;
  }
  return {
    date: endDate,
    time: `${String(endH).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
  };
}

export function leadDisplayName(lead: LeadCalendarPayload): string {
  const name = [lead.clientFirstName, lead.clientLastName]
    .filter(Boolean)
    .join(' ')
    .trim();
  return name || 'Untitled job';
}

export function leadLocation(lead: LeadCalendarPayload): string {
  return [lead.clientAddress, lead.clientCity, lead.clientState, lead.clientZip]
    .filter(Boolean)
    .join(', ');
}

export function buildCalendarEventBody(lead: LeadCalendarPayload) {
  const name = leadDisplayName(lead);
  const startDate = resolveLeadEventDate(lead);
  if (!startDate) {
    throw new Error('skipped_no_adjustment');
  }

  const time = normalizeAdjustmentTime(lead.adjustmentTime);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let start: { date: string } | { dateTime: string; timeZone: string };
  let end: { date: string } | { dateTime: string; timeZone: string };

  if (time) {
    const endAt = addOneHour(startDate, time);
    start = { dateTime: `${startDate}T${time}:00`, timeZone };
    end = { dateTime: `${endAt.date}T${endAt.time}:00`, timeZone };
  } else {
    // All-day end is exclusive next day
    const endDay = new Date(`${startDate}T12:00:00`);
    endDay.setDate(endDay.getDate() + 1);
    const endDate = `${endDay.getFullYear()}-${String(endDay.getMonth() + 1).padStart(2, '0')}-${String(endDay.getDate()).padStart(2, '0')}`;
    start = { date: startDate };
    end = { date: endDate };
  }

  const noteLines = (lead.notes || [])
    .slice(-3)
    .map((n) => `• ${n.text}`)
    .join('\n');

  const description = [
    `Summit adjustment · Stage: ${lead.category}`,
    lead.jobNumber ? `Job #: ${lead.jobNumber}` : '',
    lead.clientPhone ? `Phone: ${lead.clientPhone}` : '',
    lead.clientEmail ? `Email: ${lead.clientEmail}` : '',
    noteLines ? `\nNotes:\n${noteLines}` : '',
    `\nSynced from Summit CRM (lead id ${lead.id})`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    summary: `Adjustment · ${name}${lead.jobNumber ? ` · #${lead.jobNumber}` : ''}`,
    description,
    location: leadLocation(lead) || undefined,
    start,
    end,
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup' as const, minutes: 24 * 60 },
        { method: 'popup' as const, minutes: 60 },
      ],
    },
    extendedProperties: {
      private: {
        summitLeadId: String(lead.id),
        summitSource: 'summit-crm',
        summitKind: 'adjustment',
      },
    },
  };
}

export async function upsertCalendarEvent(
  accessToken: string,
  lead: LeadCalendarPayload
): Promise<{ eventId: string; htmlLink?: string; startDate: string }> {
  const startDate = resolveLeadEventDate(lead);
  if (!startDate) {
    throw new Error('skipped_no_adjustment');
  }
  const body = buildCalendarEventBody(lead);

  if (lead.calendarEventId) {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(lead.calendarEventId)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );
    if (res.ok) {
      const data = (await res.json()) as { id: string; htmlLink?: string };
      return { eventId: data.id, htmlLink: data.htmlLink, startDate };
    }
    // If event was deleted on Google side, fall through to create
    if (res.status !== 404 && res.status !== 410) {
      const err = await res.text();
      throw new Error(`Update failed: ${err}`);
    }
  }

  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Create failed: ${err}`);
  }
  const data = (await res.json()) as { id: string; htmlLink?: string };
  return { eventId: data.id, htmlLink: data.htmlLink, startDate };
}

/** Manual / linked Summit calendar event (not an adjustment appointment). */
export type ManualCalendarPayload = {
  id: string;
  title: string;
  notes?: string;
  startDate: string;
  endDate: string;
  startTime?: string;
  endTime?: string;
  allDay: boolean;
  leadId?: number;
  leadName?: string;
  googleEventId?: string;
  /** Target Google calendar id (primary or email). Defaults to primary. */
  calendarId?: string;
  /** Google Calendar event colorId "1"–"11"; null clears to calendar default */
  colorId?: string | null;
  /**
   * RRULE body or full `RRULE:…` string. When set, pushed as
   * `recurrence: ['RRULE:…']`. Empty/null clears recurrence on update.
   */
  rrule?: string | null;
  /**
   * When editing a series instance, patch the master (recurringEventId)
   * instead of the instance id.
   */
  recurringEventId?: string | null;
};

function resolveManualCalendarId(calendarId?: string | null): string {
  const id = (calendarId || '').trim();
  return id || 'primary';
}

export function buildManualCalendarEventBody(ev: ManualCalendarPayload) {
  const startDate = toIsoDate(ev.startDate);
  if (!startDate) throw new Error('invalid_start_date');
  const endDate = toIsoDate(ev.endDate) || startDate;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const allDay = ev.allDay || !normalizeAdjustmentTime(ev.startTime);

  let start: { date: string } | { dateTime: string; timeZone: string };
  let end: { date: string } | { dateTime: string; timeZone: string };

  if (!allDay) {
    const startT = normalizeAdjustmentTime(ev.startTime)!;
    const endT =
      normalizeAdjustmentTime(ev.endTime) ||
      addOneHour(startDate, startT).time;
    const endD =
      endDate !== startDate
        ? endDate
        : endT < startT
          ? addOneHour(startDate, startT).date
          : endDate;
    start = { dateTime: `${startDate}T${startT}:00`, timeZone };
    end = { dateTime: `${endD}T${endT}:00`, timeZone };
  } else {
    // All-day end is exclusive next day after inclusive endDate
    const endExclusive = new Date(`${endDate}T12:00:00`);
    endExclusive.setDate(endExclusive.getDate() + 1);
    const endEx = `${endExclusive.getFullYear()}-${String(endExclusive.getMonth() + 1).padStart(2, '0')}-${String(endExclusive.getDate()).padStart(2, '0')}`;
    start = { date: startDate };
    end = { date: endEx };
  }

  const leadLine = ev.leadId
    ? `Summit event · Linked lead: ${ev.leadName || `#${ev.leadId}`} [summit-lead:${ev.leadId}]`
    : 'Summit event';
  const description = [
    ev.notes?.trim() || '',
    leadLine,
    `[summit-event:${ev.id}]`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const privateProps: Record<string, string> = {
    summitEventId: ev.id,
    summitSource: 'summit-crm',
    summitKind: 'event',
  };
  if (ev.leadId != null) privateProps.summitLeadId = String(ev.leadId);
  if (ev.leadName) privateProps.summitLeadName = ev.leadName;

  const colorPayload =
    ev.colorId === null
      ? { colorId: null as null }
      : ev.colorId && /^(?:[1-9]|1[01])$/.test(String(ev.colorId).trim())
        ? { colorId: String(ev.colorId).trim() }
        : {};

  let recurrencePayload: { recurrence: string[] } | Record<string, never> = {};
  if (ev.rrule === null || ev.rrule === '') {
    // Explicit clear on update (empty array removes recurrence)
    recurrencePayload = { recurrence: [] };
  } else if (typeof ev.rrule === 'string' && ev.rrule.trim()) {
    const body = ev.rrule.trim().replace(/^RRULE:/i, '');
    if (body) recurrencePayload = { recurrence: [`RRULE:${body}`] };
  }

  return {
    summary: ev.title.trim() || '(No title)',
    description,
    start,
    end,
    ...colorPayload,
    ...recurrencePayload,
    reminders: {
      useDefault: true,
    },
    extendedProperties: {
      private: privateProps,
    },
  };
}

export async function upsertManualCalendarEvent(
  accessToken: string,
  ev: ManualCalendarPayload
): Promise<{ eventId: string; htmlLink?: string; calendarId: string }> {
  const body = buildManualCalendarEventBody(ev);
  const calendarId = resolveManualCalendarId(ev.calendarId);
  const calPath = encodeURIComponent(calendarId);
  // Series edit: patch the master when we only have an instance id
  const patchEventId = (
    (ev.recurringEventId || '').trim() ||
    (ev.googleEventId || '').trim()
  );

  if (patchEventId) {
    // Try the event's calendar first; fall back to primary if moved/legacy
    const tryIds = Array.from(
      new Set([calendarId, 'primary'].filter(Boolean))
    );
    for (const tryId of tryIds) {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(tryId)}/events/${encodeURIComponent(patchEventId)}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }
      );
      if (res.ok) {
        const data = (await res.json()) as { id: string; htmlLink?: string };
        return {
          eventId: data.id,
          htmlLink: data.htmlLink,
          calendarId: tryId,
        };
      }
      if (res.status !== 404 && res.status !== 410) {
        const err = await res.text();
        throw new Error(`Update failed: ${err}`);
      }
    }
  }

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calPath}/events`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Create failed: ${err}`);
  }
  const data = (await res.json()) as { id: string; htmlLink?: string };
  return { eventId: data.id, htmlLink: data.htmlLink, calendarId };
}

export async function deleteGoogleCalendarEvent(
  accessToken: string,
  googleEventId: string,
  calendarId?: string | null,
  /** Extra calendar ids to try (e.g. writable calendarList) when event moved */
  extraCalendarIds?: string[] | null
): Promise<void> {
  const tryIds = Array.from(
    new Set(
      [
        resolveManualCalendarId(calendarId),
        'primary',
        ...(Array.isArray(extraCalendarIds) ? extraCalendarIds : []),
      ]
        .map((id) => (id || '').trim())
        .filter(Boolean)
    )
  );
  let lastErr = '';
  for (const tryId of tryIds) {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(tryId)}/events/${encodeURIComponent(googleEventId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    if (res.ok || res.status === 404 || res.status === 410) return;
    lastErr = await res.text();
  }
  throw new Error(`Delete failed: ${lastErr}`);
}

export async function ensureFreshTokens(
  tokens: GcalTokenBundle
): Promise<GcalTokenBundle> {
  const expiresSoon =
    tokens.expiry_date != null && tokens.expiry_date < Date.now() + 60_000;
  if (!expiresSoon) return tokens;
  if (!tokens.refresh_token) return tokens;
  const refreshed = await refreshAccessToken(tokens.refresh_token);
  return {
    ...tokens,
    access_token: refreshed.access_token,
    expiry_date: refreshed.expiry_date,
    refresh_token: refreshed.refresh_token || tokens.refresh_token,
  };
}
