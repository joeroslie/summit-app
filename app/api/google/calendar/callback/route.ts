import { NextRequest, NextResponse } from 'next/server';
import {
  exchangeCodeForTokens,
  fetchAccessTokenScopes,
  fetchGoogleUserEmail,
  resolveOAuthOrigin,
} from '@/lib/google-calendar';
import { isTokenEncryptionConfigured } from '@/lib/gcal-crypto';
import {
  mergeUserGcalTokens,
  requireSignedInSummitUser,
} from '@/lib/gcal-user-store';
import { clearGcalTokens } from '@/lib/gcal-cookie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const origin = resolveOAuthOrigin(req);
  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const err = req.nextUrl.searchParams.get('error');
  const expected = req.cookies.get('summit_gcal_oauth_state')?.value;

  const fail = (reason: string) => {
    const url = new URL('/', origin);
    url.searchParams.set('gcal', 'error');
    url.searchParams.set('reason', reason);
    const res = NextResponse.redirect(url);
    res.cookies.delete('summit_gcal_oauth_state');
    return res;
  };

  if (err) return fail(err);
  if (!code) return fail('missing_code');
  if (!state || !expected) return fail('invalid_state');

  let tab = 'calendar';
  try {
    const parsed = JSON.parse(
      Buffer.from(state, 'base64url').toString('utf8')
    ) as { nonce?: string; userId?: string; tab?: string };
    if (!parsed.nonce || parsed.nonce !== expected) return fail('invalid_state');
    if (parsed.tab === 'settings' || parsed.tab === 'tasks') tab = parsed.tab;

    const auth = await requireSignedInSummitUser();
    if ('error' in auth) return fail('sign_in_required');
    if (parsed.userId && parsed.userId !== auth.user.id) {
      return fail('wrong_account');
    }
    if (!isTokenEncryptionConfigured()) return fail('missing_encryption_key');

    const tokens = await exchangeCodeForTokens(code, origin);
    if (!tokens.refresh_token) {
      return fail('missing_refresh_token');
    }
    const profile = await fetchGoogleUserEmail(tokens.access_token);
    let scopes = tokens.scopes;
    if (!scopes) {
      const fromInfo = await fetchAccessTokenScopes(tokens.access_token);
      if (fromInfo.length) scopes = fromInfo.join(' ');
    }

    await mergeUserGcalTokens(auth, {
      ...tokens,
      email: profile.email,
      name: profile.name,
      scopes,
    });
    await clearGcalTokens().catch(() => undefined);

    const url = new URL('/', origin);
    url.searchParams.set('gcal', 'connected');
    url.searchParams.set('tab', tab);
    const res = NextResponse.redirect(url);
    res.cookies.delete('summit_gcal_oauth_state');
    return res;
  } catch (e) {
    const message = e instanceof Error ? e.message : 'exchange_failed';
    return fail(message.slice(0, 120));
  }
}
