/**
 * Browser-side Google Calendar + Tasks via Google Identity Services (GIS).
 * Needs only NEXT_PUBLIC_GOOGLE_CLIENT_ID — no client secret.
 *
 * Tokens persist in localStorage on this device (survive tab/browser restart).
 * Access tokens still expire (~1h); we silent-refresh when possible.
 * Safe for single-tenant local CRM — not a multi-user vault.
 */

import {
  upsertCalendarEvent,
  upsertManualCalendarEvent,
  deleteGoogleCalendarEvent,
  type LeadCalendarPayload,
  type ManualCalendarPayload,
  type SyncLeadResult,
} from '@/lib/google-calendar';
import { GOOGLE_TASKS_SCOPE } from '@/lib/google-tasks';
import {
  normalizeCssHex,
  resolveCalendarListEntryColor,
} from '@/lib/summit-calendar';

/**
 * Calendar events + calendarList (colors / multi-cal) + Tasks.
 * calendarList.readonly needed for per-calendar backgroundColor.
 */
export const GCAL_SCOPE = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  GOOGLE_TASKS_SCOPE,
].join(' ');

const TOKEN_KEY = 'summit_gcal_browser_token';
const TOKEN_EXP_KEY = 'summit_gcal_browser_token_exp';
const EMAIL_KEY = 'summit_gcal_browser_email';
const SCOPES_KEY = 'summit_gcal_browser_scopes';

export type BrowserGcalSession = {
  accessToken: string;
  expiresAt: number;
  email?: string;
  /** Space-joined scopes granted for this token (best-effort). */
  scopes?: string;
};

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            include_granted_scopes?: boolean;
            callback: (resp: {
              access_token?: string;
              expires_in?: number;
              scope?: string;
              error?: string;
              error_description?: string;
            }) => void;
            error_callback?: (err: { type?: string; message?: string }) => void;
          }) => {
            requestAccessToken: (opts?: { prompt?: string }) => void;
          };
          revoke: (token: string, done?: () => void) => void;
        };
      };
    };
  }
}

export function getPublicGoogleClientId(): string {
  return (
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ||
    process.env.NEXT_PUBLIC_GCAL_CLIENT_ID ||
    ''
  ).trim();
}

export function isBrowserGcalConfigured(): boolean {
  return Boolean(getPublicGoogleClientId());
}

function storageGet(key: string): string | null {
  try {
    const fromLocal = localStorage.getItem(key);
    if (fromLocal != null) return fromLocal;
    // Migrate prior sessionStorage tokens (lost on tab close)
    const fromSession = sessionStorage.getItem(key);
    if (fromSession != null) {
      localStorage.setItem(key, fromSession);
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* ignore */
      }
      return fromSession;
    }
    return null;
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string) {
  localStorage.setItem(key, value);
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function storageRemove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Raw session including expired tokens (for silent refresh). */
function readRawBrowserGcalSession(): BrowserGcalSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const accessToken = storageGet(TOKEN_KEY);
    const expRaw = storageGet(TOKEN_EXP_KEY);
    if (!accessToken || !expRaw) return null;
    const expiresAt = Number(expRaw);
    if (!Number.isFinite(expiresAt)) return null;
    return {
      accessToken,
      expiresAt,
      email: storageGet(EMAIL_KEY) || undefined,
      scopes: storageGet(SCOPES_KEY) || undefined,
    };
  } catch {
    return null;
  }
}

export function readBrowserGcalSession(): BrowserGcalSession | null {
  const session = readRawBrowserGcalSession();
  if (!session) return null;
  if (session.expiresAt < Date.now() + 30_000) return null;
  return session;
}

/**
 * True when a browser GIS token exists (fresh or expired).
 * Profile settings + Calendar tab must share this as the connected-state source of truth.
 */
export function hasBrowserGcalToken(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return Boolean(storageGet(TOKEN_KEY));
  } catch {
    return false;
  }
}

/** Email from last successful connect (survives expired access token). */
export function readBrowserGcalEmail(): string | null {
  try {
    return storageGet(EMAIL_KEY);
  } catch {
    return null;
  }
}

export function writeBrowserGcalSession(session: BrowserGcalSession) {
  storageSet(TOKEN_KEY, session.accessToken);
  storageSet(TOKEN_EXP_KEY, String(session.expiresAt));
  if (session.email) storageSet(EMAIL_KEY, session.email);
  else storageRemove(EMAIL_KEY);
  if (session.scopes) storageSet(SCOPES_KEY, session.scopes);
  else storageRemove(SCOPES_KEY);
}

export function clearBrowserGcalSession() {
  storageRemove(TOKEN_KEY);
  storageRemove(TOKEN_EXP_KEY);
  storageRemove(EMAIL_KEY);
  storageRemove(SCOPES_KEY);
}

/** Normalize space-delimited OAuth scopes for comparisons. */
export function normalizeOAuthScopes(scope?: string | null): string[] {
  if (!scope?.trim()) return [];
  return scope
    .trim()
    .split(/[\s,+]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when a scope list includes Google Tasks. */
export function scopesIncludeTasks(scope?: string | null): boolean {
  const scopes = normalizeOAuthScopes(scope);
  return (
    scopes.includes(GOOGLE_TASKS_SCOPE) ||
    scopes.some((sc) => sc.endsWith('/auth/tasks'))
  );
}

const CALENDAR_LIST_SCOPE =
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly';

/** True when scope list includes calendarList.readonly (per-calendar colors). */
export function scopesIncludeCalendarList(scope?: string | null): boolean {
  const scopes = normalizeOAuthScopes(scope);
  return (
    scopes.includes(CALENDAR_LIST_SCOPE) ||
    scopes.some((sc) => sc.includes('calendar.calendarlist'))
  );
}

/** True when stored session was granted with Tasks scope. Legacy (no scopes) = false. */
export function browserSessionHasTasksScope(
  session?: BrowserGcalSession | null
): boolean {
  const s = session ?? readBrowserGcalSession() ?? readRawBrowserGcalSession();
  if (!s) return false;
  if (!s.scopes) return false; // legacy token — must reconnect for Tasks
  return scopesIncludeTasks(s.scopes);
}

/** True when session can read calendarList (colors / multi-cal). */
export function browserSessionHasCalendarListScope(
  session?: BrowserGcalSession | null
): boolean {
  const s = session ?? readBrowserGcalSession() ?? readRawBrowserGcalSession();
  if (!s) return false;
  if (!s.scopes) return false;
  return scopesIncludeCalendarList(s.scopes);
}

/**
 * Resolve actual granted scopes from Google tokeninfo (authoritative).
 * GIS callback often omits `scope` — never invent Tasks from that omission.
 */
export async function fetchAccessTokenScopes(
  accessToken: string
): Promise<string[]> {
  try {
    const res = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { scope?: string };
    return normalizeOAuthScopes(data.scope);
  } catch {
    return [];
  }
}

/** Cloud Console steps when Tasks API is the blocker (show to Joe). */
export const GOOGLE_TASKS_API_CONSOLE_STEPS = [
  'Open Google Cloud Console → select the same project as your OAuth client',
  'APIs & Services → Library → search “Google Tasks API” → Enable',
  'Also confirm Google Calendar API is Enabled',
  'APIs & Services → OAuth consent screen → Edit app → Scopes → Add https://www.googleapis.com/auth/tasks → Save',
  'Credentials → your Web client → Authorized JavaScript origins includes http://localhost:3000 (and your prod origin)',
  'In Summit: Disconnect Google, then Connect / Reconnect for Tasks',
  'On Google’s consent screen, leave Tasks checked (granular consent can uncheck it)',
  'Wait ~1 minute after enabling the API if you just turned it on',
].join('\n');

/** Human-readable Google auth / API errors with Cloud Console guidance. */
export function formatGoogleConnectError(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'Google connection failed';
  const m = raw.toLowerCase();

  if (m.includes('missing next_public_google_client_id')) {
    return raw;
  }
  if (
    m.includes('origin_mismatch') ||
    m.includes('idpiframe_initialization_failed') ||
    m.includes('invalid_client')
  ) {
    return 'OAuth client misconfigured — in Google Cloud Console → Credentials → your Web client, add http://localhost:3000 under Authorized JavaScript origins, then reconnect.';
  }
  if (m.includes('access_denied') || m.includes('popup_closed')) {
    return 'Google sign-in was cancelled — connect again and allow Calendar + Tasks.';
  }
  if (
    m.includes('tasks api') ||
    (m.includes('enable google tasks') && m.includes('library'))
  ) {
    return 'Enable Google Tasks API in Cloud Console → APIs & Services → Library, wait ~1 minute, then tap Reconnect for Tasks.';
  }
  if (
    m.includes('access_not_configured') ||
    m.includes('has not been used') ||
    m.includes('is disabled') ||
    m.includes('api not enabled')
  ) {
    return 'Enable Google Calendar API and Google Tasks API in Cloud Console → APIs & Services → Library, wait a minute, then reconnect.';
  }
  if (
    m.includes('tasks permission') ||
    m.includes('tasks access') ||
    m.includes('insufficient') ||
    m.includes('access_token_scope')
  ) {
    return 'Google Tasks permission missing — tap Reconnect for Tasks (allow Tasks on the Google consent screen). Also enable Google Tasks API in Cloud Console if needed.';
  }
  if (m.includes('expired') || m.includes('401')) {
    return 'Google session expired — reconnect Calendar + Tasks.';
  }
  return raw;
}

/**
 * Live probe: confirm the access token can call Google Tasks.
 * Distinguishes missing scope vs Tasks API not enabled in Cloud Console.
 */
export async function probeGoogleTasksAccess(
  accessToken: string
): Promise<{ ok: true } | { ok: false; error: string; kind: 'scope' | 'api' | 'auth' | 'other' }> {
  // Prefer tokeninfo for scope before hitting Tasks API
  const scopes = await fetchAccessTokenScopes(accessToken);
  const hasTasksScope =
    scopes.length === 0
      ? null // unknown — fall through to API
      : scopesIncludeTasks(scopes.join(' '));

  if (hasTasksScope === false) {
    return {
      ok: false,
      error:
        'Token is missing https://www.googleapis.com/auth/tasks — Reconnect for Tasks and leave Tasks checked on the consent screen.',
      kind: 'scope',
    };
  }

  try {
    const { listGoogleTaskLists } = await import('@/lib/google-tasks');
    await listGoogleTaskLists(accessToken);
    return { ok: true };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const msg = formatGoogleConnectError(e);
    const lower = `${msg} ${raw}`.toLowerCase();
    let kind: 'scope' | 'api' | 'auth' | 'other' = 'other';
    if (
      lower.includes('tasks api') ||
      lower.includes('enable google tasks') ||
      lower.includes('access_not_configured') ||
      lower.includes('accessnotconfigured') ||
      lower.includes('has not been used') ||
      lower.includes('service_disabled') ||
      lower.includes('api not enabled')
    ) {
      kind = 'api';
    } else if (
      lower.includes('permission') ||
      lower.includes('scope') ||
      lower.includes('insufficient') ||
      lower.includes('access_token_scope')
    ) {
      kind = 'scope';
    } else if (lower.includes('expired') || lower.includes('401')) {
      kind = 'auth';
    }
    const error =
      kind === 'api'
        ? `${msg}\n\n${GOOGLE_TASKS_API_CONSOLE_STEPS}`
        : msg;
    return { ok: false, error, kind };
  }
}

/** Revoke current GIS token (best-effort) and clear local session storage. */
export function revokeBrowserGcalToken(): Promise<void> {
  const session =
    readBrowserGcalSession() || readRawBrowserGcalSession();
  const token = session?.accessToken;
  clearBrowserGcalSession();
  if (!token) return Promise.resolve();
  return loadGoogleIdentityScript()
    .then(
      () =>
        new Promise<void>((resolve) => {
          try {
            const revoke = window.google?.accounts?.oauth2?.revoke;
            if (!revoke) {
              resolve();
              return;
            }
            revoke(token, () => resolve());
            // GIS revoke callback can hang; don't block reconnect forever
            setTimeout(() => resolve(), 1500);
          } catch {
            resolve();
          }
        })
    )
    .catch(() => undefined);
}

let gsiLoadPromise: Promise<void> | null = null;

export function loadGoogleIdentityScript(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Not in browser'));
  }
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gsiLoadPromise) return gsiLoadPromise;

  gsiLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-summit-gsi="1"]'
    );
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () =>
        reject(new Error('Failed to load Google Identity Services'))
      );
      // already loaded
      if (window.google?.accounts?.oauth2) resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.dataset.summitGsi = '1';
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error('Failed to load Google Identity Services'));
    document.head.appendChild(script);
  });

  return gsiLoadPromise;
}

async function fetchTokenEmail(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { email?: string };
    return data.email;
  } catch {
    return undefined;
  }
}

/**
 * Opens Google account picker / consent and stores an access token in localStorage.
 * Pass forceConsent when adding new scopes (e.g. Tasks) so Google re-prompts.
 * forceConsent revokes the prior token first so Calendar-only grants don't block Tasks.
 * If the user cancels, the previous Calendar session is restored.
 * Pass silent to reuse prior grant without UI (fails if consent missing/expired).
 *
 * Scopes are verified via tokeninfo — we never invent Tasks from a missing GIS `scope`.
 */
export async function connectGoogleCalendarBrowser(opts?: {
  forceConsent?: boolean;
  silent?: boolean;
}): Promise<BrowserGcalSession> {
  const clientId = getPublicGoogleClientId();
  if (!clientId) {
    return Promise.reject(
      new Error(
        'Missing NEXT_PUBLIC_GOOGLE_CLIENT_ID. Add it to .env.local and restart.'
      )
    );
  }

  // Snapshot so a cancelled Tasks reconnect does not wipe Calendar.
  const previous =
    !opts?.silent
      ? readBrowserGcalSession() || readRawBrowserGcalSession()
      : readRawBrowserGcalSession();

  // Reconnect for Tasks: revoke + clear localStorage so Google cannot silently
  // reuse a Calendar-only token when we request Calendar + Tasks together.
  if (opts?.forceConsent && !opts?.silent) {
    await revokeBrowserGcalToken();
    clearBrowserGcalSession();
  }

  try {
    await loadGoogleIdentityScript();

    const session = await new Promise<BrowserGcalSession>((resolve, reject) => {
      const oauth2 = window.google?.accounts?.oauth2;
      if (!oauth2) {
        reject(new Error('Google Identity Services not available'));
        return;
      }

      const client = oauth2.initTokenClient({
        client_id: clientId,
        scope: GCAL_SCOPE,
        include_granted_scopes: true,
        callback: (resp) => {
          void (async () => {
            if (resp.error || !resp.access_token) {
              reject(
                new Error(
                  formatGoogleConnectError(
                    resp.error_description ||
                      resp.error ||
                      'Google sign-in was cancelled'
                  )
                )
              );
              return;
            }
            const expiresIn = resp.expires_in ?? 3600;
            const email = await fetchTokenEmail(resp.access_token);

            // Authoritative scopes from tokeninfo (GIS often omits resp.scope).
            let scopeList = normalizeOAuthScopes(resp.scope);
            if (scopeList.length === 0 || opts?.forceConsent) {
              const fromInfo = await fetchAccessTokenScopes(resp.access_token);
              if (fromInfo.length) scopeList = fromInfo;
            }
            if (scopeList.length === 0 && opts?.silent) {
              scopeList = normalizeOAuthScopes(
                previous?.scopes || readRawBrowserGcalSession()?.scopes
              );
            }
            // Interactive: never invent Calendar+Tasks if Google didn't return them.
            const granted =
              scopeList.length > 0 ? scopeList.join(' ') : undefined;

            const next: BrowserGcalSession = {
              accessToken: resp.access_token,
              expiresAt: Date.now() + expiresIn * 1000,
              email,
              scopes: granted,
            };
            writeBrowserGcalSession(next);
            resolve(next);
          })();
        },
        error_callback: (err) => {
          reject(
            new Error(
              formatGoogleConnectError(
                err.message || err.type || 'Google auth error'
              )
            )
          );
        },
      });

      if (opts?.silent) {
        client.requestAccessToken({ prompt: '' });
      } else if (opts?.forceConsent) {
        // Force account + consent so Tasks appears again after Calendar-only grant
        client.requestAccessToken({ prompt: 'consent select_account' });
      } else {
        client.requestAccessToken({});
      }
    });

    return session;
  } catch (err) {
    if (previous && opts?.forceConsent && !opts?.silent) {
      writeBrowserGcalSession(previous);
    }
    throw err;
  }
}

/**
 * Return a usable access token: reuse if fresh, else silent GIS refresh.
 * On silent refresh failure, keeps the stored token so UI still shows Connected
 * (Profile + Calendar share hasBrowserGcalToken). User can Reconnect.
 */
export async function ensureBrowserGcalSession(): Promise<BrowserGcalSession | null> {
  const fresh = readBrowserGcalSession();
  if (fresh) return fresh;

  const raw = readRawBrowserGcalSession();
  // Only attempt silent refresh if we previously connected on this device
  if (!raw && !hasBrowserGcalToken() && !storageGet(EMAIL_KEY) && !storageGet(SCOPES_KEY)) {
    return null;
  }

  try {
    return await connectGoogleCalendarBrowser({ silent: true });
  } catch {
    // Do not clearBrowserGcalSession — that made Profile say "not connected"
    // while Calendar still showed pulled Google events.
    // Return null so callers don't hit APIs with a dead token; UI uses
    // hasBrowserGcalToken() for Connected state.
    return null;
  }
}

export function disconnectGoogleCalendarBrowser() {
  const session =
    readBrowserGcalSession() || readRawBrowserGcalSession();
  if (session?.accessToken && window.google?.accounts?.oauth2?.revoke) {
    try {
      window.google.accounts.oauth2.revoke(session.accessToken);
    } catch {
      /* ignore */
    }
  }
  clearBrowserGcalSession();
}

export type GoogleCalendarListEntry = {
  id: string;
  summary?: string;
  description?: string;
  primary?: boolean;
  selected?: boolean;
  accessRole?: string;
  /** Calendar color id "1"–"24" */
  colorId?: string;
  /** Hex from Google (preferred for paint) */
  backgroundColor?: string;
  foregroundColor?: string;
};

export type GoogleCalendarListItem = {
  id: string;
  summary: string;
  htmlLink?: string;
  location?: string;
  description?: string;
  /** Google event colorId "1"–"11" */
  colorId?: string;
  /** Calendar this event was listed from */
  calendarId?: string;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  calendarBackground?: string;
  calendarForeground?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  status?: string;
  recurringEventId?: string;
  updated?: string;
  extendedProperties?: {
    private?: Record<string, string>;
  };
};

function gcalAuthHeaders(accessToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  };
}

function throwGcalListError(status: number, err: string): never {
  if (status === 401) {
    throw new Error('Session expired — reconnect Google Calendar');
  }
  if (
    status === 403 &&
    /accessNotConfigured|has not been used|disabled/i.test(err)
  ) {
    throw new Error(
      'Enable Google Calendar API in Cloud Console → APIs & Services → Library, then reconnect.'
    );
  }
  throw new Error(`Failed to load events: ${err.slice(0, 160)}`);
}

/** User's calendar list (colors + which calendars are selected). */
export async function listGoogleCalendarList(
  accessToken: string
): Promise<GoogleCalendarListEntry[]> {
  const res = await fetch(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250',
    { headers: gcalAuthHeaders(accessToken) }
  );
  if (!res.ok) {
    const err = await res.text();
    if (res.status === 401) {
      throw new Error('Session expired — reconnect Google Calendar');
    }
    if (res.status === 403) {
      // Missing calendarlist.readonly — caller may fall back to primary
      throw new Error(`calendarList_forbidden:${err.slice(0, 120)}`);
    }
    throw new Error(`Failed to load calendars: ${err.slice(0, 160)}`);
  }
  const data = (await res.json()) as { items?: GoogleCalendarListEntry[] };
  return data.items || [];
}

/** Events from one calendar id (primary or email). Paginates fully. */
export async function listGoogleEventsForCalendar(
  accessToken: string,
  calendarId: string,
  opts?: {
    maxResults?: number;
    timeMin?: string;
    timeMax?: string;
    /** Include cancelled so delete-on-pull can purge instances */
    showDeleted?: boolean;
  }
): Promise<GoogleCalendarListItem[]> {
  const pageSize = Math.min(250, Math.max(25, opts?.maxResults ?? 100));
  const out: GoogleCalendarListItem[] = [];
  let pageToken: string | undefined;

  do {
    const qs = new URLSearchParams({
      singleEvents: 'true',
      // orderBy startTime is incompatible with showDeleted; use updated when deleting
      maxResults: String(pageSize),
      timeMin: opts?.timeMin || new Date().toISOString(),
    });
    if (opts?.timeMax) qs.set('timeMax', opts.timeMax);
    if (opts?.showDeleted) {
      qs.set('showDeleted', 'true');
    } else {
      qs.set('orderBy', 'startTime');
    }
    if (pageToken) qs.set('pageToken', pageToken);

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${qs.toString()}`,
      { headers: gcalAuthHeaders(accessToken) }
    );
    if (!res.ok) {
      const err = await res.text();
      throwGcalListError(res.status, err);
    }
    const data = (await res.json()) as {
      items?: GoogleCalendarListItem[];
      nextPageToken?: string;
    };
    for (const item of data.items || []) {
      out.push({ ...item, calendarId });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return out;
}

export type GoogleEventsPullResult = {
  events: GoogleCalendarListItem[];
  /** calendarList id → hex colors */
  colorMap: Record<string, { bg: string; fg: string }>;
  /** Cancelled event / instance ids from showDeleted pull */
  cancelledIds: string[];
  /** How many calendarList entries were loaded (0 = list failed / fallback) */
  calendarsLoaded: number;
  /** How many calendars were actually fetched for events */
  calendarsFetched: number;
};

function colorMapFromCalendarList(
  calendars: GoogleCalendarListEntry[]
): Record<string, { bg: string; fg: string }> {
  const map: Record<string, { bg: string; fg: string }> = {};
  for (const c of Array.isArray(calendars) ? calendars : []) {
    if (!c?.id) continue;
    const resolved = resolveCalendarListEntryColor(c);
    if (!resolved?.bg) continue;
    const entry = {
      bg: resolved.bg,
      fg: resolved.text || '#ffffff',
    };
    map[c.id] = entry;
    if (c.primary) map.primary = entry;
  }
  return map;
}

function resolveCalColors(
  cal: GoogleCalendarListEntry,
  colorMap: Record<string, { bg: string; fg: string }>
): { bg: string; fg: string } | undefined {
  const fromMap = colorMap[cal.id];
  if (fromMap?.bg) return fromMap;
  if (cal.primary && colorMap.primary?.bg) return colorMap.primary;
  const resolved = resolveCalendarListEntryColor(cal);
  if (resolved?.bg) {
    return { bg: resolved.bg, fg: resolved.text || '#ffffff' };
  }
  const bg = normalizeCssHex(cal.backgroundColor);
  if (bg) {
    return {
      bg,
      fg: normalizeCssHex(cal.foregroundColor) || '#ffffff',
    };
  }
  // No invented Cobalt — caller paints Cobalt only when nothing resolves
  return undefined;
}

/**
 * Pull events from selected calendars, tagged with calendarId + list colors.
 * Falls back to primary-only when calendarList scope is missing.
 * Uses showDeleted so cancelled instances are returned for delete-on-pull.
 */
export async function listUpcomingGoogleEvents(
  accessToken: string,
  opts?: { maxResults?: number; timeMin?: string; timeMax?: string }
): Promise<GoogleEventsPullResult> {
  const perCal = Math.max(50, opts?.maxResults ?? 250);
  let calendars: GoogleCalendarListEntry[] = [];
  try {
    calendars = await listGoogleCalendarList(accessToken);
    if (!Array.isArray(calendars)) calendars = [];
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (!/calendarList_forbidden|403/i.test(msg)) throw e;
    calendars = [];
  }

  const colorMap = colorMapFromCalendarList(calendars);
  const cancelledIds = new Set<string>();

  const selected = calendars.filter((c) => c.selected !== false && c.id);
  const toFetch: GoogleCalendarListEntry[] =
    selected.length > 0
      ? selected
      : calendars.length > 0
        ? calendars.filter((c) => c.id)
        : [
            {
              id: 'primary',
              primary: true,
              selected: true,
              // Do not hardcode Cobalt as a real calendar color — leave unset
              colorId: '15',
            } satisfies GoogleCalendarListEntry,
          ];

  const settled = await Promise.allSettled(
    toFetch.map((cal) =>
      listGoogleEventsForCalendar(accessToken, cal.id, {
        maxResults: perCal,
        timeMin: opts?.timeMin,
        timeMax: opts?.timeMax,
        showDeleted: true,
      })
    )
  );

  const out: GoogleCalendarListItem[] = [];
  let calendarsFetched = 0;
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]!;
    const cal = toFetch[i]!;
    if (result.status !== 'fulfilled') continue;
    if (!Array.isArray(result.value)) continue;
    calendarsFetched += 1;
    const resolved = resolveCalColors(cal, colorMap);
    for (const item of result.value) {
      if (!item || typeof item !== 'object') continue;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!id) continue;
      const status = (item.status || '').toLowerCase();
      if (status === 'cancelled') {
        cancelledIds.add(id);
        const master =
          typeof item.recurringEventId === 'string'
            ? item.recurringEventId.trim()
            : '';
        if (master) cancelledIds.add(master);
        continue;
      }
      const start = item.start;
      if (
        !start ||
        typeof start !== 'object' ||
        (!start.date && !start.dateTime)
      ) {
        continue;
      }
      out.push({
        ...item,
        id,
        calendarId: cal.id,
        calendarBackground: resolved?.bg,
        calendarForeground: resolved?.fg,
        status: item.status,
        recurringEventId: item.recurringEventId,
      });
    }
  }

  // If every multi-cal fetch failed, last-resort primary
  if (out.length === 0 && cancelledIds.size === 0 && toFetch[0]?.id !== 'primary') {
    try {
      const primary = await listGoogleEventsForCalendar(accessToken, 'primary', {
        ...opts,
        showDeleted: true,
      });
      const primaryColors = colorMap.primary;
      calendarsFetched = Math.max(calendarsFetched, 1);
      for (const item of Array.isArray(primary) ? primary : []) {
        if (!item || typeof item !== 'object') continue;
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        if (!id) continue;
        if ((item.status || '').toLowerCase() === 'cancelled') {
          cancelledIds.add(id);
          continue;
        }
        if (
          !item.start ||
          typeof item.start !== 'object' ||
          (!item.start.date && !item.start.dateTime)
        ) {
          continue;
        }
        out.push({
          ...item,
          calendarId: 'primary',
          calendarBackground: primaryColors?.bg,
          calendarForeground: primaryColors?.fg,
        });
      }
    } catch {
      /* keep empty */
    }
  }

  return {
    events: Array.isArray(out) ? out : [],
    colorMap: colorMap && typeof colorMap === 'object' ? colorMap : {},
    cancelledIds: Array.from(cancelledIds),
    calendarsLoaded: calendars.length,
    calendarsFetched,
  };
}

/** Create/update Calendar events for leads using the browser access token. */
export async function syncLeadsWithBrowserToken(
  accessToken: string,
  leads: LeadCalendarPayload[],
  opts?: { skipClosed?: boolean }
): Promise<{ results: SyncLeadResult[]; synced: number }> {
  const skipClosed = opts?.skipClosed !== false;
  const results: SyncLeadResult[] = [];

  for (const lead of leads) {
    if (skipClosed && lead.category === 'Closed') {
      results.push({ leadId: lead.id, error: 'skipped_closed' });
      continue;
    }
    if (!lead.adjustmentDate?.trim()) {
      results.push({ leadId: lead.id, error: 'skipped_no_adjustment' });
      continue;
    }
    try {
      const out = await upsertCalendarEvent(accessToken, lead);
      results.push({
        leadId: lead.id,
        eventId: out.eventId,
        htmlLink: out.htmlLink,
        startDate: out.startDate,
      });
    } catch (e) {
      results.push({
        leadId: lead.id,
        error: e instanceof Error ? e.message : 'sync_failed',
      });
    }
  }

  return {
    results,
    synced: results.filter((r) => r.eventId).length,
  };
}

/** Create/update a manual Summit calendar event on Google. */
export async function syncManualEventWithBrowserToken(
  accessToken: string,
  event: ManualCalendarPayload
): Promise<{ eventId: string; htmlLink?: string; calendarId: string }> {
  return upsertManualCalendarEvent(accessToken, event);
}

/** Delete a Google Calendar event by id (browser token). */
export async function deleteGoogleEventWithBrowserToken(
  accessToken: string,
  googleEventId: string,
  calendarId?: string | null
): Promise<void> {
  return deleteGoogleCalendarEvent(accessToken, googleEventId, calendarId);
}
