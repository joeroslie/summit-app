import { NextRequest, NextResponse } from 'next/server';
import {
  exchangeCodeForTokens,
  fetchGoogleUserEmail,
} from '@/lib/google-calendar';
import { writeGcalTokens } from '@/lib/gcal-cookie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
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
  if (!state || !expected || state !== expected) return fail('invalid_state');

  try {
    const tokens = await exchangeCodeForTokens(code, origin);
    const profile = await fetchGoogleUserEmail(tokens.access_token);
    await writeGcalTokens({
      ...tokens,
      email: profile.email,
      name: profile.name,
    });

    const url = new URL('/', origin);
    url.searchParams.set('gcal', 'connected');
    url.searchParams.set('tab', 'settings');
    const res = NextResponse.redirect(url);
    res.cookies.delete('summit_gcal_oauth_state');
    return res;
  } catch (e) {
    const message = e instanceof Error ? e.message : 'exchange_failed';
    return fail(message.slice(0, 120));
  }
}
