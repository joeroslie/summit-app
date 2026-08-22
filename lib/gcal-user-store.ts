import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { decryptSecret, encryptSecret } from '@/lib/gcal-crypto';
import {
  ensureFreshTokens,
  type GcalTokenBundle,
} from '@/lib/google-calendar';

const TABLE = 'user_google_oauth';

type OauthRow = {
  user_id: string;
  company_id: string | null;
  encrypted_refresh_token: string;
  encrypted_access_token: string | null;
  access_token_expires_at: string | null;
  google_email: string | null;
  google_name: string | null;
  scopes: string | null;
};

export type SignedInSummitUser = {
  user: User;
  companyId: string | null;
};

export async function requireSignedInSummitUser(): Promise<
  SignedInSummitUser | { error: 'unauthenticated' }
> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return { error: 'unauthenticated' };

  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .maybeSingle();
  const companyId =
    membership && typeof membership.company_id === 'string'
      ? membership.company_id
      : null;
  return { user, companyId };
}

function rowToBundle(row: OauthRow): GcalTokenBundle | null {
  try {
    const refresh = decryptSecret(row.encrypted_refresh_token);
    if (!refresh) return null;
    let access = '';
    if (row.encrypted_access_token) {
      try {
        access = decryptSecret(row.encrypted_access_token);
      } catch {
        access = '';
      }
    }
    const expiry = row.access_token_expires_at
      ? Date.parse(row.access_token_expires_at)
      : undefined;
    return {
      access_token: access,
      refresh_token: refresh,
      expiry_date: Number.isFinite(expiry) ? expiry : undefined,
      email: row.google_email || undefined,
      name: row.google_name || undefined,
      scopes: row.scopes || undefined,
    };
  } catch {
    return null;
  }
}

export async function readUserGcalTokens(
  userId: string
): Promise<GcalTokenBundle | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from(TABLE)
    .select(
      'user_id, company_id, encrypted_refresh_token, encrypted_access_token, access_token_expires_at, google_email, google_name, scopes'
    )
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return null;
  return rowToBundle(data as OauthRow);
}

export async function writeUserGcalTokens(
  auth: SignedInSummitUser,
  tokens: GcalTokenBundle
): Promise<void> {
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token');
  }
  const supabase = await createClient();
  const now = new Date().toISOString();
  const expiresAt =
    tokens.expiry_date != null
      ? new Date(tokens.expiry_date).toISOString()
      : null;
  const payload = {
    user_id: auth.user.id,
    company_id: auth.companyId,
    encrypted_refresh_token: encryptSecret(tokens.refresh_token),
    encrypted_access_token: tokens.access_token
      ? encryptSecret(tokens.access_token)
      : null,
    access_token_expires_at: expiresAt,
    google_email: tokens.email ?? null,
    google_name: tokens.name ?? null,
    scopes: tokens.scopes ?? null,
    updated_at: now,
  };
  const { error } = await supabase.from(TABLE).upsert(payload, {
    onConflict: 'user_id',
  });
  if (error) {
    throw new Error(`Failed to store Google connection: ${error.message}`);
  }
}

export async function deleteUserGcalTokens(userId: string): Promise<void> {
  const supabase = await createClient();
  await supabase.from(TABLE).delete().eq('user_id', userId);
}

export async function mergeUserGcalTokens(
  auth: SignedInSummitUser,
  next: GcalTokenBundle
): Promise<void> {
  const existing = await readUserGcalTokens(auth.user.id);
  await writeUserGcalTokens(auth, {
    access_token: next.access_token || existing?.access_token || '',
    refresh_token: next.refresh_token || existing?.refresh_token,
    expiry_date: next.expiry_date ?? existing?.expiry_date,
    email: next.email ?? existing?.email,
    name: next.name ?? existing?.name,
    scopes: next.scopes ?? existing?.scopes,
  });
}

/** Read + refresh on the server so access tokens do not expire every ~1h. */
export async function getValidUserGcalTokens(
  auth: SignedInSummitUser
): Promise<GcalTokenBundle | null> {
  const tokens = await readUserGcalTokens(auth.user.id);
  if (!tokens?.refresh_token) return tokens;
  try {
    const fresh = await ensureFreshTokens(tokens);
    if (
      fresh.access_token !== tokens.access_token ||
      fresh.expiry_date !== tokens.expiry_date
    ) {
      await writeUserGcalTokens(auth, fresh);
    }
    return fresh;
  } catch {
    return tokens.refresh_token
      ? { ...tokens, access_token: tokens.access_token || '' }
      : null;
  }
}
