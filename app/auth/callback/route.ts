import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

function fail(request: NextRequest, reason: string) {
  const url = request.nextUrl.clone();
  url.pathname = '/';
  url.search = '';
  url.searchParams.set('auth_error', reason);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const oauthError = searchParams.get('error');
  let next = searchParams.get('next') ?? '/';
  if (!next.startsWith('/') || next.startsWith('//')) next = '/';

  if (oauthError) {
    if (oauthError === 'access_denied') return fail(request, 'denied');
    return fail(request, 'callback');
  }

  if (!code) return fail(request, 'callback');

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anonKey) return fail(request, 'callback');

  const redirectUrl = `${origin}${next}`;
  const redirect = NextResponse.redirect(redirectUrl);

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value, options }) =>
          redirect.cookies.set(name, value, options)
        );
        Object.entries(headers).forEach(([key, value]) =>
          redirect.headers.set(key, value)
        );
      },
    },
  });

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    console.error('auth callback exchange', error.message);
    return fail(request, 'callback');
  }

  return redirect;
}
