import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getPublicGoogleClientId,
  loadGoogleIdentityScript,
} from '@/lib/gcal-browser';

async function hashedNonce(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const bin = String.fromCharCode(...new Uint8Array(digest));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Google One Tap / FedCM ID token → Supabase session.
 * Falls back to redirect OAuth when the prompt is blocked (common on localhost).
 */
export async function signInWithGoogleIdToken(
  supabase: SupabaseClient
): Promise<
  | { ok: true }
  | { ok: false; fallbackToRedirect: boolean; message: string }
> {
  const clientId = getPublicGoogleClientId();
  if (!clientId) {
    return {
      ok: false,
      fallbackToRedirect: true,
      message: 'Google is not configured.',
    };
  }

  try {
    await loadGoogleIdentityScript();
  } catch {
    return {
      ok: false,
      fallbackToRedirect: true,
      message: 'Google sign-in failed to load.',
    };
  }

  const gis = window.google?.accounts?.id;
  if (!gis) {
    return {
      ok: false,
      fallbackToRedirect: true,
      message: 'Google sign-in unavailable.',
    };
  }

  const rawNonce = crypto.randomUUID();
  const nonce = await hashedNonce(rawNonce);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (
      result:
        | { ok: true }
        | { ok: false; fallbackToRedirect: boolean; message: string }
    ) => {
      if (settled) return;
      settled = true;
      try {
        gis.cancel();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    gis.initialize({
      client_id: clientId,
      nonce,
      callback: (resp) => {
        void (async () => {
          if (!resp.credential) {
            finish({
              ok: false,
              fallbackToRedirect: true,
              message: 'Google sign-in was cancelled.',
            });
            return;
          }
          const { error } = await supabase.auth.signInWithIdToken({
            provider: 'google',
            token: resp.credential,
            nonce: rawNonce,
          });
          if (error) {
            const msg = error.message || '';
            finish({
              ok: false,
              fallbackToRedirect: /provider is not enabled|unsupported provider/i.test(
                msg
              ),
              message: msg,
            });
            return;
          }
          finish({ ok: true });
        })();
      },
    });

    gis.prompt((notification) => {
      if (
        notification.isNotDisplayed() ||
        notification.isSkippedMoment() ||
        notification.isDismissedMoment()
      ) {
        finish({
          ok: false,
          fallbackToRedirect: true,
          message: 'Google prompt closed.',
        });
      }
    });
  });
}
