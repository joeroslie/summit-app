/**
 * Google Calendar helpers for Summit CRM.
 * OAuth tokens live in an httpOnly cookie; event create/update hits Google Calendar API.
 */

export const GCAL_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
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
  followUpDate?: string;
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

export function buildAuthUrl(origin: string, state: string) {
  const { clientId } = getGoogleClientConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getOAuthRedirectUri(origin),
    response_type: 'code',
    scope: GCAL_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
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
  };
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiry_date: data.expires_in
      ? Date.now() + data.expires_in * 1000
      : undefined,
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
 * Pick an event date for a lead:
 * 1) followUpDate  2) lead.date  3) today + stage offset (active pipeline)
 */
export function resolveLeadEventDate(
  lead: LeadCalendarPayload,
  today = new Date()
): string {
  const fromFollow = toIsoDate(lead.followUpDate);
  if (fromFollow) return fromFollow;
  const fromLead = toIsoDate(lead.date);
  if (fromLead) return fromLead;

  const stageOffset: Record<string, number> = {
    Lead: 1,
    Prospect: 2,
    Approved: 5,
    Completed: 7,
    Invoiced: 10,
    Closed: 0,
  };
  const days = stageOffset[lead.category] ?? 1;
  const d = new Date(today);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  // skip Sunday
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return toIsoDate(d.toISOString()) || d.toISOString().slice(0, 10);
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
  // All-day end is exclusive next day
  const end = new Date(`${startDate}T12:00:00`);
  end.setDate(end.getDate() + 1);
  const endDate = end.toISOString().slice(0, 10);

  const noteLines = (lead.notes || [])
    .slice(-3)
    .map((n) => `• ${n.text}`)
    .join('\n');

  const description = [
    `Summit job · Stage: ${lead.category}`,
    lead.jobNumber ? `Job #: ${lead.jobNumber}` : '',
    lead.clientPhone ? `Phone: ${lead.clientPhone}` : '',
    lead.clientEmail ? `Email: ${lead.clientEmail}` : '',
    noteLines ? `\nNotes:\n${noteLines}` : '',
    `\nSynced from Summit CRM (lead id ${lead.id})`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    summary: `[${lead.category}] ${name}${lead.jobNumber ? ` · #${lead.jobNumber}` : ''}`,
    description,
    location: leadLocation(lead) || undefined,
    start: { date: startDate },
    end: { date: endDate },
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
      },
    },
  };
}

export async function upsertCalendarEvent(
  accessToken: string,
  lead: LeadCalendarPayload
): Promise<{ eventId: string; htmlLink?: string; startDate: string }> {
  const body = buildCalendarEventBody(lead);
  const startDate = body.start.date;

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
