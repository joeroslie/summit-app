import { NextRequest, NextResponse } from 'next/server';
import { convexHull, type LatLngPoint } from '@/lib/roof-outline';
import { callInstantRooferV2 } from '@/lib/instant-roofer';

/**
 * Instant Roofer AI Measure (~$1–3 / address; sandbox may include free credits).
 *
 * Setup:
 * 1. https://api-dashboard.instantroofer.com/ → API key
 * 2. .env.local → INSTANT_ROOFER_API_KEY=...
 *
 * GET/POST /api/instant-roofer/measure?lat=&lng=
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type IrResponse = {
  version?: string;
  measurements?: {
    sqft?: {
      aerial?: number;
      measured?: number;
      suggested?: number;
    };
    squares?: number;
    pitch?: string;
    complexity?: number;
    perimeter?: number;
    facets?: number;
    stories?: number;
    confidence?: {
      score?: number;
      display?: { value?: string };
    };
  };
  coordinates?: { latitude?: number; longitude?: number };
  buildingPredictions?: {
    complexityWaste?: number;
  };
  imagery?: {
    mapWithOutline?: string;
    mapWithoutLine?: string;
  };
  lidar?: {
    facets?: { predicted_count?: number };
    roofPointsFacetedXYZK?: unknown;
  };
};

function normalizePitch(raw: string | undefined): string {
  if (!raw) return '6/12';
  const t = raw.trim();
  if (/^flat$/i.test(t)) return 'Flat';
  const m = t.match(/(\d+)\s*\/\s*12/);
  if (m) return `${m[1]}/12`;
  return t;
}

function wasteFromComplexity(c: number | undefined, predicted?: number): number {
  if (predicted != null && Number.isFinite(predicted)) {
    return Math.min(0.2, Math.max(0.05, predicted / 100));
  }
  if (c == null) return 0.1;
  if (c <= 0) return 0.08;
  if (c === 1) return 0.1;
  if (c === 2) return 0.12;
  return 0.15;
}

function outlineFromLidar(raw: unknown, center: LatLngPoint): LatLngPoint[] {
  if (!Array.isArray(raw) || raw.length < 3) return [];

  const pts: LatLngPoint[] = [];
  for (const item of raw) {
    if (Array.isArray(item) && item.length >= 2) {
      const a = Number(item[0]);
      const b = Number(item[1]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
        pts.push({ lat: a, lng: b });
      } else if (Math.abs(b) <= 90 && Math.abs(a) <= 180) {
        pts.push({ lat: b, lng: a });
      }
      continue;
    }
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const lat = Number(o.lat ?? o.latitude ?? o.y);
      const lng = Number(o.lng ?? o.lon ?? o.longitude ?? o.x);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90) {
        pts.push({ lat, lng });
      }
    }
  }

  if (pts.length < 3) return [];
  const near = pts.filter(
    (p) =>
      Math.abs(p.lat - center.lat) < 0.01 && Math.abs(p.lng - center.lng) < 0.01
  );
  const hull = convexHull(near.length >= 3 ? near : pts);
  return hull.length >= 3 ? hull : [];
}

async function measure(lat: number, lng: number) {
  const result = await callInstantRooferV2({ latitude: lat, longitude: lng });
  if (!result.ok) {
    return NextResponse.json(result.json, {
      status: result.status >= 400 && result.status < 600 ? result.status : 502,
    });
  }

  const raw = result.json as IrResponse;
  const m = raw.measurements;
  const squares = Number(m?.squares) || 0;
  if (squares <= 0) {
    return NextResponse.json(
      {
        error: 'no_roof',
        message: 'Instant Roofer found no roof at this location',
      },
      { status: 404 }
    );
  }

  const pitch = normalizePitch(m?.pitch);
  const footprintSqFt = Number(m?.sqft?.aerial) || 0;
  const surfaceSqFt = Number(m?.sqft?.measured) || squares * 100;
  const suggestedSqFt = Number(m?.sqft?.suggested) || surfaceSqFt;
  const center: LatLngPoint = {
    lat: raw.coordinates?.latitude ?? lat,
    lng: raw.coordinates?.longitude ?? lng,
  };

  const outlinePoints = outlineFromLidar(
    raw.lidar?.roofPointsFacetedXYZK,
    center
  );

  const outlineImage =
    raw.imagery?.mapWithOutline || raw.imagery?.mapWithoutLine || null;

  return NextResponse.json({
    ok: true,
    source: 'instant_roofer_ai',
    center,
    pitch,
    squares,
    footprintSqFt: footprintSqFt || Math.round(surfaceSqFt),
    surfaceSqFt,
    suggestedSqFt,
    perimeterLF: Number(m?.perimeter) || 0,
    facets: Number(m?.facets) || 0,
    complexity: m?.complexity ?? null,
    waste: wasteFromComplexity(
      m?.complexity,
      raw.buildingPredictions?.complexityWaste
    ),
    confidence: {
      score: m?.confidence?.score ?? null,
      label: m?.confidence?.display?.value ?? null,
    },
    outlinePoints,
    outlineImage,
    edgesVerified: false,
    note:
      'Instant Roofer AI — strong squares/pitch. Ridge/hip/rake need Human Certified (~$10) or field entry.',
  });
}

export async function GET(req: NextRequest) {
  const lat = Number(req.nextUrl.searchParams.get('lat'));
  const lng = Number(req.nextUrl.searchParams.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json(
      { error: 'bad_request', message: 'lat and lng are required numbers' },
      { status: 400 }
    );
  }
  try {
    return await measure(lat, lng);
  } catch (err) {
    console.error('instant-roofer measure', err);
    return NextResponse.json(
      {
        error: 'instant_roofer_fetch_failed',
        message: 'Could not reach Instant Roofer',
      },
      { status: 502 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { lat?: number; lng?: number };
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return NextResponse.json(
        { error: 'bad_request', message: 'lat and lng are required numbers' },
        { status: 400 }
      );
    }
    return await measure(lat, lng);
  } catch (err) {
    console.error('instant-roofer measure', err);
    return NextResponse.json(
      {
        error: 'instant_roofer_fetch_failed',
        message: 'Could not reach Instant Roofer',
      },
      { status: 502 }
    );
  }
}
