import { NextResponse } from 'next/server';
import { getGoogleClientConfig } from '@/lib/google-calendar';
import { getValidGcalTokens } from '@/lib/gcal-cookie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const { configured } = getGoogleClientConfig();
  if (!configured) {
    return NextResponse.json({
      configured: false,
      connected: false,
      email: null,
      name: null,
    });
  }

  const tokens = await getValidGcalTokens();
  return NextResponse.json({
    configured: true,
    connected: Boolean(tokens?.access_token),
    email: tokens?.email ?? null,
    name: tokens?.name ?? null,
  });
}
