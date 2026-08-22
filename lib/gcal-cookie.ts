/**
 * Legacy httpOnly cookie helpers. New connections live in user_google_oauth.
 * Disconnect still clears leftover cookies from older builds.
 */
import { cookies } from 'next/headers';
import {
  GCAL_COOKIE,
  type GcalTokenBundle,
  ensureFreshTokens,
} from '@/lib/google-calendar';

export async function readGcalTokens(): Promise<GcalTokenBundle | null> {
  const jar = await cookies();
  const raw = jar.get(GCAL_COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as GcalTokenBundle;
    if (!parsed?.access_token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeGcalTokens(tokens: GcalTokenBundle) {
  const jar = await cookies();
  jar.set(GCAL_COOKIE, encodeURIComponent(JSON.stringify(tokens)), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 180, // 180 days
  });
}

export async function clearGcalTokens() {
  const jar = await cookies();
  jar.delete(GCAL_COOKIE);
}

/** Read + refresh tokens if needed; persist when refreshed. */
export async function getValidGcalTokens(): Promise<GcalTokenBundle | null> {
  const tokens = await readGcalTokens();
  if (!tokens) return null;
  try {
    const fresh = await ensureFreshTokens(tokens);
    if (
      fresh.access_token !== tokens.access_token ||
      fresh.expiry_date !== tokens.expiry_date
    ) {
      await writeGcalTokens(fresh);
    }
    return fresh;
  } catch {
    return tokens;
  }
}
