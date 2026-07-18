/**
 * Browser-side Google Calendar via Google Identity Services (GIS).
 * Needs only NEXT_PUBLIC_GOOGLE_CLIENT_ID — no client secret.
 */

import {
  upsertCalendarEvent,
  type LeadCalendarPayload,
  type SyncLeadResult,
} from '@/lib/google-calendar';

export const GCAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const TOKEN_KEY = 'summit_gcal_browser_token';
const TOKEN_EXP_KEY = 'summit_gcal_browser_token_exp';
const EMAIL_KEY = 'summit_gcal_browser_email';

export type BrowserGcalSession = {
  accessToken: string;
  expiresAt: number;
  email?: string;
};

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (resp: {
              access_token?: string;
              expires_in?: number;
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

export function readBrowserGcalSession(): BrowserGcalSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const accessToken = sessionStorage.getItem(TOKEN_KEY);
    const expRaw = sessionStorage.getItem(TOKEN_EXP_KEY);
    if (!accessToken || !expRaw) return null;
    const expiresAt = Number(expRaw);
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now() + 30_000) {
      clearBrowserGcalSession();
      return null;
    }
    return {
      accessToken,
      expiresAt,
      email: sessionStorage.getItem(EMAIL_KEY) || undefined,
    };
  } catch {
    return null;
  }
}

export function writeBrowserGcalSession(session: BrowserGcalSession) {
  sessionStorage.setItem(TOKEN_KEY, session.accessToken);
  sessionStorage.setItem(TOKEN_EXP_KEY, String(session.expiresAt));
  if (session.email) sessionStorage.setItem(EMAIL_KEY, session.email);
  else sessionStorage.removeItem(EMAIL_KEY);
}

export function clearBrowserGcalSession() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_EXP_KEY);
    sessionStorage.removeItem(EMAIL_KEY);
  } catch {
    /* ignore */
  }
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
 * Opens Google account picker / consent and stores an access token in sessionStorage.
 */
export function connectGoogleCalendarBrowser(): Promise<BrowserGcalSession> {
  const clientId = getPublicGoogleClientId();
  if (!clientId) {
    return Promise.reject(
      new Error(
        'Missing NEXT_PUBLIC_GOOGLE_CLIENT_ID. Add it to .env.local and restart.'
      )
    );
  }

  return loadGoogleIdentityScript().then(
    () =>
      new Promise<BrowserGcalSession>((resolve, reject) => {
        const oauth2 = window.google?.accounts?.oauth2;
        if (!oauth2) {
          reject(new Error('Google Identity Services not available'));
          return;
        }

        const client = oauth2.initTokenClient({
          client_id: clientId,
          scope: GCAL_SCOPE,
          callback: (resp) => {
            void (async () => {
              if (resp.error || !resp.access_token) {
                reject(
                  new Error(
                    resp.error_description ||
                      resp.error ||
                      'Google sign-in was cancelled'
                  )
                );
                return;
              }
              const expiresIn = resp.expires_in ?? 3600;
              const email = await fetchTokenEmail(resp.access_token);
              const session: BrowserGcalSession = {
                accessToken: resp.access_token,
                expiresAt: Date.now() + expiresIn * 1000,
                email,
              };
              writeBrowserGcalSession(session);
              resolve(session);
            })();
          },
          error_callback: (err) => {
            reject(new Error(err.message || err.type || 'Google auth error'));
          },
        });

        // Empty prompt reuses prior grant when possible; first time shows consent
        client.requestAccessToken({});
      })
  );
}

export function disconnectGoogleCalendarBrowser() {
  const session = readBrowserGcalSession();
  if (session?.accessToken && window.google?.accounts?.oauth2?.revoke) {
    try {
      window.google.accounts.oauth2.revoke(session.accessToken);
    } catch {
      /* ignore */
    }
  }
  clearBrowserGcalSession();
}

export type GoogleCalendarListItem = {
  id: string;
  summary: string;
  htmlLink?: string;
  location?: string;
  description?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
};

/** Upcoming events from the user's primary calendar (GIS access token). */
export async function listUpcomingGoogleEvents(
  accessToken: string,
  opts?: { maxResults?: number; timeMin?: string; timeMax?: string }
): Promise<GoogleCalendarListItem[]> {
  const qs = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(opts?.maxResults ?? 25),
    timeMin: opts?.timeMin || new Date().toISOString(),
  });
  if (opts?.timeMax) qs.set('timeMax', opts.timeMax);

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${qs.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(
      res.status === 401
        ? 'Session expired — reconnect Google Calendar'
        : `Failed to load events: ${err.slice(0, 160)}`
    );
  }
  const data = (await res.json()) as { items?: GoogleCalendarListItem[] };
  return data.items || [];
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
