import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UA = 'SummitRoofCRM/1.0 (canvassing-reverse-geocode; local-dev)';

type NominatimReverse = {
  display_name?: string;
  address?: {
    house_number?: string;
    road?: string;
    city?: string;
    town?: string;
    village?: string;
    hamlet?: string;
    state?: string;
    postcode?: string;
  };
};

/**
 * Reverse geocode a dropped/located pin into a human address (best-effort — used to
 * pre-fill the canvassing pin's address field, which stays editable either way).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const lat = parseFloat(searchParams.get('lat') || '');
  const lng = parseFloat(searchParams.get('lng') || '');

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: 'Missing lat/lng' }, { status: 400 });
  }

  try {
    const params = new URLSearchParams({
      format: 'json',
      lat: String(lat),
      lon: String(lng),
      zoom: '18',
      addressdetails: '1',
    });
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?${params.toString()}`,
      {
        headers: { Accept: 'application/json', 'User-Agent': UA },
        next: { revalidate: 0 },
      }
    );
    if (!res.ok) {
      return NextResponse.json({ address: null }, { status: 200 });
    }
    const data = (await res.json()) as NominatimReverse;
    const a = data.address || {};
    const city = a.city || a.town || a.village || a.hamlet || '';
    const street = [a.house_number, a.road].filter(Boolean).join(' ').trim();
    const label =
      [street, city, a.state, a.postcode].filter(Boolean).join(', ') ||
      data.display_name ||
      null;
    return NextResponse.json({
      address: label,
      street: street || null,
      city: city || null,
      state: a.state || null,
      zip: a.postcode || null,
    });
  } catch {
    return NextResponse.json({ address: null }, { status: 200 });
  }
}
