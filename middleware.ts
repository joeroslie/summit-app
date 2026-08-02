/**
 * Supabase auth middleware — temporarily disabled (white-screen fix).
 *
 * When re-enabling, use createServerClient from @supabase/ssr with cookie
 * getAll/setAll — not createMiddlewareClient (removed / auth-helpers only).
 *
 * Browser:  lib/supabase/client.ts
 * Server:   lib/supabase/server.ts
 */

import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(_req: NextRequest) {
  // Pass-through only — no Supabase session work while disabled
  return NextResponse.next();
}

export const config = {
  // Matcher empty → middleware does not run on any route
  matcher: [],
};
