/**
 * Browser Supabase helpers.
 * Env: NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient as createBrowserSupabase } from '@/lib/supabase/client';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const anonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  '';

let client: SupabaseClient | null = null;

export function isSupabaseConfigured(): boolean {
  return Boolean(
    url &&
      !url.includes('YOUR_') &&
      anonKey &&
      !anonKey.startsWith('YOUR_')
  );
}

/** Singleton browser client. Returns null if env is missing / placeholder. */
export function getSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  if (!client) {
    client = createBrowserSupabase();
  }
  return client;
}

export { createClient } from '@/lib/supabase/client';
