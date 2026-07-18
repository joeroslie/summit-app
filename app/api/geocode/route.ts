import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type NominatimHit = {
  lat: string;
  lon: string;
  class?: string;
  type?: string;
  importance?: number;
  display_name?: string;
  address?: {
    house_number?: string;
    road?: string;
    city?: string;
    town?: string;
    village?: string;
    state?: string;
    postcode?: string;
  };
};

type PhotonFeature = {
  geometry?: { coordinates?: number[] };
  properties?: {
    osm_key?: string;
    osm_value?: string;
    type?: string;
    name?: string;
    housenumber?: string;
    street?: string;
    city?: string;
    state?: string;
    postcode?: string;
    country?: string;
  };
};

const UA = 'SummitRoofCRM/1.0 (roof-measurement-geocode; local-dev)';

function pickBestNominatim(hits: NominatimHit[]): NominatimHit | null {
  if (!hits.length) return null;
  const rank = (h: NominatimHit) => {
    let score = h.importance ?? 0;
    if (h.class === 'building' || h.type === 'house' || h.type === 'residential')
      score += 3;
    if (h.class === 'place' && h.type === 'house') score += 3;
    if (h.type === 'yes' && h.class === 'building') score += 2;
    if (h.address?.house_number) score += 2.5;
    if (h.class === 'highway' || h.class === 'railway') score -= 2;
    if (h.class === 'boundary' || h.type === 'administrative') score -= 1.5;
    // City/town centroids are bad for house placement
    if (
      h.class === 'place' &&
      (h.type === 'city' || h.type === 'town' || h.type === 'village')
    ) {
      score -= 3;
    }
    return score;
  };
  return [...hits].sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

function pickBestPhoton(features: PhotonFeature[]): PhotonFeature | null {
  if (!features.length) return null;
  const rank = (f: PhotonFeature) => {
    const p = f.properties || {};
    let score = 0;
    if (p.osm_key === 'building' || p.type === 'house') score += 4;
    if (p.housenumber) score += 3;
    if (p.osm_value === 'house' || p.osm_value === 'residential') score += 2;
    if (p.osm_key === 'highway') score -= 2;
    if (p.type === 'city' || p.type === 'town') score -= 3;
    return score;
  };
  return [...features].sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

async function nominatimSearch(
  params: URLSearchParams
): Promise<{ lat: number; lng: number; displayName?: string } | null> {
  params.set('format', 'json');
  if (!params.has('limit')) params.set('limit', '8');
  params.set('addressdetails', '1');
  params.set('countrycodes', 'us');

  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?${params.toString()}`,
    {
      headers: {
        Accept: 'application/json',
        'User-Agent': UA,
      },
      // Nominatim usage policy: identify app; no heavy caching of live lookups here
      next: { revalidate: 0 },
    }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as NominatimHit[];
  const hit = pickBestNominatim(data);
  if (!hit) return null;
  const lat = parseFloat(hit.lat);
  const lng = parseFloat(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, displayName: hit.display_name };
}

async function photonSearch(
  q: string
): Promise<{ lat: number; lng: number; displayName?: string } | null> {
  const res = await fetch(
    `https://photon.komoot.io/api/?limit=8&lang=en&q=${encodeURIComponent(q)}`,
    {
      headers: { Accept: 'application/json', 'User-Agent': UA },
      next: { revalidate: 0 },
    }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { features?: PhotonFeature[] };
  const preferred = pickBestPhoton(data.features || []);
  const coords = preferred?.geometry?.coordinates;
  if (!coords || coords.length < 2) return null;
  const lng = coords[0];
  const lat = coords[1];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const p = preferred?.properties;
  const displayName = [p?.housenumber, p?.street, p?.city, p?.state, p?.postcode]
    .filter(Boolean)
    .join(', ');
  return { lat, lng, displayName: displayName || p?.name };
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const street = (searchParams.get('street') || '').trim();
  const city = (searchParams.get('city') || '').trim();
  const state = (searchParams.get('state') || '').trim();
  const zip = (searchParams.get('zip') || searchParams.get('postalcode') || '').trim();
  const q = (searchParams.get('q') || '').trim();

  if (!street && !city && !zip && !q) {
    return NextResponse.json({ error: 'Missing address' }, { status: 400 });
  }

  try {
    // 1) Structured Nominatim (best house placement when street is known)
    if (street) {
      const structured = new URLSearchParams();
      structured.set('street', street);
      if (city) structured.set('city', city);
      if (state) structured.set('state', state);
      if (zip) structured.set('postalcode', zip);

      const hit = await nominatimSearch(structured);
      if (hit) {
        return NextResponse.json({
          lat: hit.lat,
          lng: hit.lng,
          displayName: hit.displayName,
          source: 'nominatim-structured',
        });
      }
    }

    // 2) Free-form Nominatim variants
    const freeform = [
      q,
      [street, city, state, zip].filter(Boolean).join(', '),
      [street, city, state, zip, 'USA'].filter(Boolean).join(', '),
      zip && street ? `${street} ${zip}` : '',
      city && state && street ? `${street}, ${city}, ${state}` : '',
    ]
      .map((s) => s.trim())
      .filter(Boolean);

    const seen = new Set<string>();
    for (const query of freeform) {
      if (seen.has(query)) continue;
      seen.add(query);
      const params = new URLSearchParams({ q: query });
      const hit = await nominatimSearch(params);
      if (hit) {
        return NextResponse.json({
          lat: hit.lat,
          lng: hit.lng,
          displayName: hit.displayName,
          source: 'nominatim-freeform',
        });
      }
    }

    // 3) Photon fallback
    for (const query of freeform) {
      const hit = await photonSearch(query);
      if (hit) {
        return NextResponse.json({
          lat: hit.lat,
          lng: hit.lng,
          displayName: hit.displayName,
          source: 'photon',
        });
      }
    }

    return NextResponse.json({ error: 'No results' }, { status: 404 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Geocode failed';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
