import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isAllowedPdfUrl(raw: string) {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return (
    parsed.hostname.endsWith('.supabase.co') &&
    parsed.pathname.includes('/storage/v1/object/')
  );
}

/** Same-origin bytes for the in-app PDF viewer when Storage CORS blocks fetch. */
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get('url') || '';
  if (!isAllowedPdfUrl(url)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const upstream = await fetch(url);
  if (!upstream.ok) {
    return NextResponse.json(
      { error: 'upstream' },
      { status: upstream.status }
    );
  }
  return new NextResponse(upstream.body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, max-age=60',
    },
  });
}
