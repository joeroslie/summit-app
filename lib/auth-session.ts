import type { SupabaseClient, User } from '@supabase/supabase-js';

export function authCallbackUrl(): string {
  return `${window.location.origin}/auth/callback`;
}

const AUTH_CHECK_MS = 8000;

export async function loadAuthMembership(
  supabase: SupabaseClient,
  user: User
): Promise<{ companyId: string | null; unreachable: boolean }> {
  try {
    const { data, error } = await supabase
      .from('company_members')
      .select('company_id')
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) return { companyId: null, unreachable: true };
    const companyId =
      data && typeof data.company_id === 'string' ? data.company_id : null;
    return { companyId, unreachable: false };
  } catch {
    return { companyId: null, unreachable: true };
  }
}

/** Resolves null on timeout so the login screen still appears in the field. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number = AUTH_CHECK_MS
): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
}
