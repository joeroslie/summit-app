import { NextRequest, NextResponse } from 'next/server';
import {
  haversineFeet,
  ringCentroid,
  type LatLngPoint,
} from '@/lib/roof-outline';

/**
 * Free building footprint from OpenStreetMap (Overpass).
 * Seeds the roof tracer — adjust corners on satellite. Not a roof report.
 *
 * GET /api/roof/footprint?lat=33.44&lng=-112.07
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UA = 'SummitRoofCRM/1.0 (roof-footprint; local-dev)';

type OverpassElement = {
  type: string;
  id: number;
  geometry?: Array<{ lat: number; lon: number }>;
  tags?: Record<string, string>;
};

function ringAreaApprox(points: LatLngPoint[]): number {
  if (points.length < 3) return 0;
  // Shoelace in local feet (approx)
  const c = ringCentroid(points)!;
  const ft = points.map((p) => ({
    x: haversineFeet(c, { lat: c.lat, lng: p.lng }) * (p.lng >= c.lng ? 1 : -1),
    y: haversineFeet(c, { lat: p.lat, lng: c.lng }) * (p.lat >= c.lat ? 1 : -1),
  }));
  let sum = 0;
  for (let i = 0; i < ft.length; i++) {
    const j = (i + 1) % ft.length;
    sum += ft[i].x * ft[j].y - ft[j].x * ft[i].y;
  }
  return Math.abs(sum) / 2;
}

export async function GET(req: NextRequest) {
  const lat = Number(req.nextUrl.searchParams.get('lat'));
  const lng = Number(req.nextUrl.searchParams.get('lng'));
  const radiusM = Math.min(
    80,
    Math.max(15, Number(req.nextUrl.searchParams.get('radiusM')) || 40)
  );

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json(
      { error: 'bad_request', message: 'lat and lng are required numbers' },
      { status: 400 }
    );
  }

  const query = `
[out:json][timeout:25];
(
  way["building"](around:${radiusM},${lat},${lng});
  relation["building"](around:${radiusM},${lat},${lng});
);
out geom;
`.trim();

  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': UA,
      },
      body: `data=${encodeURIComponent(query)}`,
      cache: 'no-store',
    });

    if (!res.ok) {
      return NextResponse.json(
        {
          error: 'overpass_upstream',
          message: `OpenStreetMap footprint lookup failed (${res.status})`,
        },
        { status: 502 }
      );
    }

    const raw = (await res.json()) as { elements?: OverpassElement[] };
    const elements = raw.elements || [];
    const center: LatLngPoint = { lat, lng };

    type Candidate = {
      points: LatLngPoint[];
      distFt: number;
      areaSqFt: number;
      building: string;
    };

    const candidates: Candidate[] = [];
    for (const el of elements) {
      const geom = el.geometry;
      if (!geom || geom.length < 3) continue;
      const points: LatLngPoint[] = geom
        .map((g) => ({ lat: g.lat, lng: g.lon }))
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
      // Drop closing duplicate if present
      if (
        points.length > 1 &&
        points[0].lat === points[points.length - 1].lat &&
        points[0].lng === points[points.length - 1].lng
      ) {
        points.pop();
      }
      if (points.length < 3) continue;
      const centroid = ringCentroid(points);
      if (!centroid) continue;
      const distFt = haversineFeet(center, centroid);
      const areaSqFt = Math.round(ringAreaApprox(points));
      if (areaSqFt < 80) continue; // skip tiny sheds
      candidates.push({
        points,
        distFt,
        areaSqFt,
        building: el.tags?.building || 'yes',
      });
    }

    if (candidates.length === 0) {
      return NextResponse.json({
        ok: true,
        found: false,
        source: 'osm_overpass',
        points: [] as LatLngPoint[],
        message: 'No building outline near this address — trace manually',
      });
    }

    candidates.sort((a, b) => a.distFt - b.distFt || b.areaSqFt - a.areaSqFt);
    const best = candidates[0];

    return NextResponse.json({
      ok: true,
      found: true,
      source: 'osm_overpass',
      points: best.points,
      footprintSqFt: best.areaSqFt,
      distanceFt: Math.round(best.distFt),
      building: best.building,
      center: ringCentroid(best.points),
      note: 'OSM building footprint — drag corners to match the roof edge, then Save.',
    });
  } catch (err) {
    console.error('roof footprint', err);
    return NextResponse.json(
      { error: 'footprint_fetch_failed', message: 'Could not reach OpenStreetMap' },
      { status: 502 }
    );
  }
}
