import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UA = 'SummitRoofCRM/1.0 (address-autocomplete; local-dev)';

export type AddressSuggestion = {
  label: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  lat?: number;
  lng?: number;
};

type NominatimHit = {
  lat: string;
  lon: string;
  display_name?: string;
  address?: {
    house_number?: string;
    road?: string;
    residential?: string;
    city?: string;
    town?: string;
    village?: string;
    hamlet?: string;
    municipality?: string;
    county?: string;
    state?: string;
    postcode?: string;
  };
};

function usStateAbbr(state: string): string {
  const map: Record<string, string> = {
    arizona: 'AZ',
    california: 'CA',
    texas: 'TX',
    nevada: 'NV',
    'new mexico': 'NM',
    utah: 'UT',
    colorado: 'CO',
    florida: 'FL',
    washington: 'WA',
    oregon: 'OR',
  };
  const s = state.trim();
  if (s.length === 2) return s.toUpperCase();
  return map[s.toLowerCase()] || s;
}

function hitToSuggestion(h: NominatimHit): AddressSuggestion | null {
  const a = h.address || {};
  const street = [a.house_number, a.road || a.residential]
    .filter(Boolean)
    .join(' ')
    .trim();
  const city =
    a.city || a.town || a.village || a.hamlet || a.municipality || '';
  const state = a.state ? usStateAbbr(a.state) : '';
  const zip = (a.postcode || '').split('-')[0] || '';
  if (!street && !city && !h.display_name) return null;
  const label =
    h.display_name ||
    [street, city, state, zip].filter(Boolean).join(', ');
  const lat = parseFloat(h.lat);
  const lng = parseFloat(h.lon);
  return {
    label,
    street: street || label.split(',')[0]?.trim() || '',
    city,
    state,
    zip,
    lat: Number.isFinite(lat) ? lat : undefined,
    lng: Number.isFinite(lng) ? lng : undefined,
  };
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  if (q.length < 3) {
    return NextResponse.json({ suggestions: [] as AddressSuggestion[] });
  }

  try {
    const params = new URLSearchParams({
      format: 'json',
      addressdetails: '1',
      limit: '6',
      countrycodes: 'us',
      q,
    });

    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?${params.toString()}`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': UA,
        },
        next: { revalidate: 0 },
      }
    );

    if (!res.ok) {
      return NextResponse.json(
        { suggestions: [], error: 'Upstream error' },
        { status: 502 }
      );
    }

    const data = (await res.json()) as NominatimHit[];
    const suggestions = data
      .map(hitToSuggestion)
      .filter((s): s is AddressSuggestion => !!s && !!s.street);

    // Dedupe by label
    const seen = new Set<string>();
    const unique = suggestions.filter((s) => {
      const k = s.label.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    return NextResponse.json({ suggestions: unique.slice(0, 6) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Suggest failed';
    return NextResponse.json({ error: message, suggestions: [] }, { status: 502 });
  }
}
