import { NextResponse } from 'next/server';
import { getGoogleClientConfig } from '@/lib/google-calendar';
import { isTokenEncryptionConfigured } from '@/lib/gcal-crypto';
import {
  getValidUserGcalTokens,
  requireSignedInSummitUser,
} from '@/lib/gcal-user-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const { configured, serverOAuth } = getGoogleClientConfig();
  const encryption = isTokenEncryptionConfigured();
  const auth = await requireSignedInSummitUser();
  if ('error' in auth) {
    return NextResponse.json(
      {
        configured,
        serverOAuth,
        encryption,
        signedIn: false,
        connected: false,
        email: null,
        name: null,
        scopes: null,
        accessToken: null,
        expiresAt: null,
      },
      { status: 401 }
    );
  }

  const tokens =
    configured && serverOAuth && encryption
      ? await getValidUserGcalTokens(auth)
      : null;
  const connected = Boolean(tokens?.refresh_token);
  const accessOk = Boolean(tokens?.access_token);

  return NextResponse.json({
    configured,
    serverOAuth,
    encryption,
    signedIn: true,
    connected,
    email: tokens?.email ?? null,
    name: tokens?.name ?? null,
    scopes: tokens?.scopes ?? null,
    accessToken: accessOk ? tokens!.access_token : null,
    expiresAt: tokens?.expiry_date ?? null,
  });
}
