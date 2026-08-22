import { NextResponse } from 'next/server';
import { clearGcalTokens } from '@/lib/gcal-cookie';
import { revokeGoogleToken } from '@/lib/google-calendar';
import {
  deleteUserGcalTokens,
  readUserGcalTokens,
  requireSignedInSummitUser,
} from '@/lib/gcal-user-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const auth = await requireSignedInSummitUser();
  if ('error' in auth) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }

  const existing = await readUserGcalTokens(auth.user.id);
  await deleteUserGcalTokens(auth.user.id);
  await clearGcalTokens().catch(() => undefined);

  const toRevoke = existing?.refresh_token || existing?.access_token;
  if (toRevoke) await revokeGoogleToken(toRevoke);

  return NextResponse.json({ ok: true });
}
