import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Free, no-key, no-signup public property data lookup for canvassing pins.
 *
 * Both Maricopa County (Phoenix) and Pima County (Tucson), AZ publish their
 * assessor parcel layers as open ArcGIS REST MapServer endpoints with no API key
 * and no rate-limit auth — anyone can run a point-in-polygon query against them.
 * That's exactly what we do here: given a pin's lat/lng, ask "which parcel polygon
 * contains this point?" and read back owner name / year built / assessed value.
 *
 * Coverage: Maricopa County (Phoenix metro) + Pima County (Tucson metro), AZ only —
 * matches where Joe operates today. Outside those two counties this returns
 * `{ available: false }` and the UI falls back to manual entry.
 *
 * To add another county/state later: add a new `lookupXxxCounty()` function below
 * with its ArcGIS query URL + field mapping, then add it to the `LOOKUPS` list.
 * (Most county assessors that run ArcGIS Online/Enterprise expose a similar free
 * `/query` endpoint — search "<county> assessor parcels ArcGIS REST" to find it.)
 */

type PropertyLookupResult = {
  available: boolean;
  source?: 'maricopa' | 'pima';
  ownerName?: string | null;
  yearBuilt?: string | null;
  assessedValue?: number | null;
  siteAddress?: string | null;
  parcelId?: string | null;
};

function cleanStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s && s.toLowerCase() !== 'null' ? s : null;
}

/** Maricopa Assessor "$  86,794,159" style strings → number. */
function parseMoneyLike(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[,\s$]/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      next: { revalidate: 0 },
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Maricopa County Assessor — free ArcGIS REST parcel layer, no key required. */
async function lookupMaricopa(
  lat: number,
  lng: number
): Promise<PropertyLookupResult | null> {
  const url =
    'https://gis.mcassessor.maricopa.gov/arcgis/rest/services/Parcels/MapServer/0/query' +
    `?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326` +
    '&spatialRel=esriSpatialRelIntersects' +
    '&outFields=OWNER_NAME,CONST_YEAR,FCV_CUR,PHYSICAL_ADDRESS,APN_DASH' +
    '&returnGeometry=false&f=json';
  const data = await fetchJson(url);
  const feature = (data?.features as Array<{ attributes?: Record<string, unknown> }>)?.[0];
  const a = feature?.attributes;
  if (!a) return null;
  return {
    available: true,
    source: 'maricopa',
    ownerName: cleanStr(a.OWNER_NAME),
    yearBuilt: cleanStr(a.CONST_YEAR),
    assessedValue: parseMoneyLike(a.FCV_CUR),
    siteAddress: cleanStr(a.PHYSICAL_ADDRESS),
    parcelId: cleanStr(a.APN_DASH),
  };
}

/** Pima County Assessor (Tucson) — free ArcGIS REST parcel layer, no key required. */
async function lookupPima(
  lat: number,
  lng: number
): Promise<PropertyLookupResult | null> {
  const url =
    'https://mapdata.tucsonaz.gov/public/rest/services/PublicMaps/PropertyHousing/MapServer/17/query' +
    `?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326` +
    '&spatialRel=esriSpatialRelIntersects' +
    '&outFields=ADDRESSEE,YearBuilt,FCV,SITE_ADDRESS,PARCEL' +
    '&returnGeometry=false&f=json';
  const data = await fetchJson(url);
  const feature = (data?.features as Array<{ attributes?: Record<string, unknown> }>)?.[0];
  const a = feature?.attributes;
  if (!a) return null;
  return {
    available: true,
    source: 'pima',
    ownerName: cleanStr(a.ADDRESSEE),
    yearBuilt: cleanStr(a.YearBuilt),
    assessedValue: parseMoneyLike(a.FCV),
    siteAddress: cleanStr(a.SITE_ADDRESS),
    parcelId: cleanStr(a.PARCEL),
  };
}

const LOOKUPS = [lookupMaricopa, lookupPima];

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const lat = parseFloat(searchParams.get('lat') || '');
  const lng = parseFloat(searchParams.get('lng') || '');

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: 'Missing lat/lng' }, { status: 400 });
  }

  for (const lookup of LOOKUPS) {
    try {
      const result = await lookup(lat, lng);
      if (result) {
        return NextResponse.json(result);
      }
    } catch {
      /* try next county */
    }
  }

  const empty: PropertyLookupResult = { available: false };
  return NextResponse.json(empty);
}
