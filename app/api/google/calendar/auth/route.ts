import { NextRequest, NextResponse } from 'next/server';
import { buildAuthUrl, getGoogleClientConfig } from '@/lib/google-calendar';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { configured } = getGoogleClientConfig();
  if (!configured) {
    return NextResponse.json(
      {
        error:
          'Google Calendar is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local.',
      },
      { status: 503 }
    );
  }

  const origin = req.nextUrl.origin;
  const state = crypto.randomUUID();
  const res = NextResponse.redirect(buildAuthUrl(origin, state));
  res.cookies.set('summit_gcal_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });
  return res;
}
