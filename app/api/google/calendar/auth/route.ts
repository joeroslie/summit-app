import { NextRequest, NextResponse } from 'next/server';
import {
  buildAuthUrl,
  getGoogleClientConfig,
  resolveOAuthOrigin,
} from '@/lib/google-calendar';
import { isTokenEncryptionConfigured } from '@/lib/gcal-crypto';
import { requireSignedInSummitUser } from '@/lib/gcal-user-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { configured, serverOAuth } = getGoogleClientConfig();
  if (!configured || !serverOAuth) {
    return NextResponse.json(
      {
        error:
          'Google Calendar is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_TOKEN_ENCRYPTION_KEY.',
      },
      { status: 503 }
    );
  }
  if (!isTokenEncryptionConfigured()) {
    return NextResponse.json(
      {
        error:
          'Missing GOOGLE_TOKEN_ENCRYPTION_KEY (64 hex chars). Generate with openssl rand -hex 32.',
      },
      { status: 503 }
    );
  }

  const auth = await requireSignedInSummitUser();
  if ('error' in auth) {
    const url = new URL('/', resolveOAuthOrigin(req));
    url.searchParams.set('gcal', 'error');
    url.searchParams.set('reason', 'sign_in_required');
    return NextResponse.redirect(url);
  }

  const origin = resolveOAuthOrigin(req);
  const tabRaw = req.nextUrl.searchParams.get('tab') || 'calendar';
  const tab =
    tabRaw === 'settings' || tabRaw === 'tasks' || tabRaw === 'calendar'
      ? tabRaw
      : 'calendar';
  const forceConsent = req.nextUrl.searchParams.get('force') === '1';
  const nonce = crypto.randomUUID();
  const statePayload = JSON.stringify({
    nonce,
    userId: auth.user.id,
    tab,
  });
  const state = Buffer.from(statePayload, 'utf8').toString('base64url');
  const res = NextResponse.redirect(
    buildAuthUrl(origin, state, { forceConsent })
  );
  res.cookies.set('summit_gcal_oauth_state', nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });
  return res;
}
