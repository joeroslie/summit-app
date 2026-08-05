import { NextRequest, NextResponse } from 'next/server';
import { outlineFromSolarBoxes, type LatLngBox } from '@/lib/roof-outline';

/**
 * Google Solar API — Building Insights (best free squares + pitch).
 *
 * Setup:
 * 1. Google Cloud Console → enable "Solar API"
 * 2. Create an API key (restrict to Solar API)
 * 3. Add to .env.local:
 *      GOOGLE_SOLAR_API_KEY=your-key
 *    (falls back to GOOGLE_MAPS_API_KEY if set)
 *
 * Free tier: Google Cloud often includes ~$200/mo credit.
 * Does NOT return ridge/hip/rake/eave lengths — those stay blank until
 * field entry or a paid certified report.
 *
 * GET /api/solar/measure?lat=33.44&lng=-112.07
 */

export const runtime = 'nodejs';

type SolarSegment = {
  pitchDegrees?: number;
  azimuthDegrees?: number;
  center?: { latitude?: number; longitude?: number };
  boundingBox?: LatLngBox;
  stats?: {
    areaMeters2?: number;
    groundAreaMeters2?: number;
  };
};

type BuildingInsights = {
  name?: string;
  center?: { latitude?: number; longitude?: number };
  boundingBox?: LatLngBox;
  imageryDate?: { year?: number; month?: number; day?: number };
  imageryQuality?: string;
  solarPotential?: {
    wholeRoofStats?: {
      areaMeters2?: number;
      groundAreaMeters2?: number;
    };
    roofSegmentStats?: SolarSegment[];
    maxArrayAreaMeters2?: number;
  };
};

function pitchDegreesToTwelfths(deg: number): string {
  if (!Number.isFinite(deg) || deg < 1.5) return 'Flat';
  const rise = Math.tan((deg * Math.PI) / 180) * 12;
  const rounded = Math.max(1, Math.min(18, Math.round(rise)));
  return `${rounded}/12`;
}

function meters2ToSquares(m2: number): number {
  const sqFt = m2 * 10.76391041671;
  return Math.round((sqFt / 100) * 10) / 10;
}

function meters2ToSqFt(m2: number): number {
  return Math.round(m2 * 10.76391041671 * 10) / 10;
}

/** Waste hint from facet count — still editable. */
function wasteFromSegments(n: number): number {
  if (n <= 2) return 0.08;
  if (n <= 4) return 0.1;
  if (n <= 8) return 0.12;
  return 0.15;
}

export async function GET(req: NextRequest) {
  const key =
    process.env.GOOGLE_SOLAR_API_KEY?.trim() ||
    process.env.GOOGLE_MAPS_API_KEY?.trim() ||
    '';

  if (!key) {
    return NextResponse.json(
      {
        error: 'solar_not_configured',
        message:
          'Add GOOGLE_SOLAR_API_KEY to .env.local (enable Solar API in Google Cloud). Free monthly credit covers most field use.',
      },
      { status: 501 }
    );
  }

  const lat = Number(req.nextUrl.searchParams.get('lat'));
  const lng = Number(req.nextUrl.searchParams.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json(
      { error: 'bad_request', message: 'lat and lng are required numbers' },
      { status: 400 }
    );
  }

  const url = new URL(
    'https://solar.googleapis.com/v1/buildingInsights:findClosest'
  );
  url.searchParams.set('location.latitude', String(lat));
  url.searchParams.set('location.longitude', String(lng));
  url.searchParams.set('requiredQuality', 'MEDIUM');
  url.searchParams.set('key', key);

  try {
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    const raw = (await res.json()) as BuildingInsights & {
      error?: { message?: string; status?: string };
    };

    if (!res.ok) {
      return NextResponse.json(
        {
          error: 'solar_upstream',
          message:
            raw.error?.message ||
            `Solar API ${res.status}. Check billing / API enablement.`,
          status: raw.error?.status,
        },
        { status: res.status >= 400 && res.status < 600 ? res.status : 502 }
      );
    }

    const roof = raw.solarPotential;
    const wholeM2 = roof?.wholeRoofStats?.areaMeters2 ?? 0;
    const segments = [...(roof?.roofSegmentStats || [])].sort(
      (a, b) =>
        (b.stats?.areaMeters2 || 0) - (a.stats?.areaMeters2 || 0)
    );

    let dominantPitch = '6/12';
    let secondaryPitch: string | undefined;
    let secondaryFraction: number | undefined;
    if (segments.length > 0) {
      const best = segments[0];
      if (best?.pitchDegrees != null) {
        dominantPitch = pitchDegreesToTwelfths(best.pitchDegrees);
      }
      const totalArea = segments.reduce(
        (s, seg) => s + (seg.stats?.areaMeters2 || 0),
        0
      );
      if (segments.length > 1 && totalArea > 0) {
        const second = segments[1];
        const frac = (second.stats?.areaMeters2 || 0) / totalArea;
        if (frac >= 0.12 && second.pitchDegrees != null) {
          const sp = pitchDegreesToTwelfths(second.pitchDegrees);
          if (sp !== dominantPitch) {
            secondaryPitch = sp;
            secondaryFraction = Math.round(frac * 100) / 100;
          }
        }
      }
    }

    const squares = wholeM2 > 0 ? meters2ToSquares(wholeM2) : 0;
    const footprintM2 =
      roof?.wholeRoofStats?.groundAreaMeters2 ?? wholeM2;
    const footprintSqFt = meters2ToSqFt(footprintM2);
    const surfaceSqFt = meters2ToSqFt(wholeM2);

    const outlinePoints = outlineFromSolarBoxes({
      buildingBox: raw.boundingBox,
      segmentBoxes: segments
        .map((s) => s.boundingBox)
        .filter(Boolean) as LatLngBox[],
    });

    return NextResponse.json({
      ok: true,
      source: 'google_solar',
      center: {
        lat: raw.center?.latitude ?? lat,
        lng: raw.center?.longitude ?? lng,
      },
      imageryDate: raw.imageryDate || null,
      imageryQuality: raw.imageryQuality || null,
      pitch: dominantPitch,
      secondaryPitch: secondaryPitch || null,
      secondaryFraction: secondaryFraction ?? null,
      waste: wasteFromSegments(segments.length),
      squares,
      footprintSqFt,
      surfaceSqFt,
      segmentCount: segments.length,
      outlinePoints,
      edgesVerified: false,
      segments: segments.map((s) => ({
        pitch: pitchDegreesToTwelfths(s.pitchDegrees ?? 0),
        pitchDegrees: s.pitchDegrees ?? null,
        azimuthDegrees: s.azimuthDegrees ?? null,
        areaSquares: meters2ToSquares(s.stats?.areaMeters2 || 0),
      })),
      note:
        'Google Solar squares & pitch. Ridge/hip/rake not included — enter on estimate after field check, or upgrade to paid measure later.',
    });
  } catch (err) {
    console.error('solar measure', err);
    return NextResponse.json(
      { error: 'solar_fetch_failed', message: 'Could not reach Google Solar' },
      { status: 502 }
    );
  }
}
