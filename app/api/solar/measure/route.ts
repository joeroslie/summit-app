import { NextRequest, NextResponse } from 'next/server';

/**
 * Google Solar API — Building Insights (EagleView/Roofr-style auto measure).
 *
 * Setup:
 * 1. Google Cloud Console → enable "Solar API"
 * 2. Create an API key (restrict to Solar API)
 * 3. Add to .env.local:
 *      GOOGLE_SOLAR_API_KEY=your-key
 *    (falls back to GOOGLE_MAPS_API_KEY if set)
 *
 * Free tier: Google Cloud often includes ~$200/mo credit (~hundreds–1000s of
 * building lookups). Not a Roofr human-certified report — field-verify.
 *
 * GET /api/solar/measure?lat=33.44&lng=-112.07
 */

export const runtime = 'nodejs';

type SolarSegment = {
  pitchDegrees?: number;
  azimuthDegrees?: number;
  stats?: {
    areaMeters2?: number;
    groundAreaMeters2?: number;
  };
};

type BuildingInsights = {
  name?: string;
  center?: { latitude?: number; longitude?: number };
  imageryDate?: { year?: number; month?: number; day?: number };
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
    const segments = roof?.roofSegmentStats || [];
    let dominantPitch = '6/12';
    if (segments.length > 0) {
      const best = [...segments].sort(
        (a, b) =>
          (b.stats?.areaMeters2 || 0) - (a.stats?.areaMeters2 || 0)
      )[0];
      if (best?.pitchDegrees != null) {
        dominantPitch = pitchDegreesToTwelfths(best.pitchDegrees);
      }
    }

    const squares = wholeM2 > 0 ? meters2ToSquares(wholeM2) : 0;
    const footprintM2 =
      roof?.wholeRoofStats?.groundAreaMeters2 ??
      wholeM2;
    const footprintSqFt =
      Math.round(footprintM2 * 10.76391041671 * 10) / 10;
    const surfaceSqFt = Math.round(wholeM2 * 10.76391041671 * 10) / 10;

    return NextResponse.json({
      ok: true,
      source: 'google_solar',
      center: {
        lat: raw.center?.latitude ?? lat,
        lng: raw.center?.longitude ?? lng,
      },
      imageryDate: raw.imageryDate || null,
      pitch: dominantPitch,
      squares,
      footprintSqFt,
      surfaceSqFt,
      segmentCount: segments.length,
      segments: segments.map((s) => ({
        pitch: pitchDegreesToTwelfths(s.pitchDegrees ?? 0),
        pitchDegrees: s.pitchDegrees ?? null,
        azimuthDegrees: s.azimuthDegrees ?? null,
        areaSquares: meters2ToSquares(s.stats?.areaMeters2 || 0),
      })),
      note: 'Auto measure from Google Solar — field-verify before ordering material.',
    });
  } catch (err) {
    console.error('solar measure', err);
    return NextResponse.json(
      { error: 'solar_fetch_failed', message: 'Could not reach Google Solar' },
      { status: 502 }
    );
  }
}
