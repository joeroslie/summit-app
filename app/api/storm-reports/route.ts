import { NextRequest, NextResponse } from 'next/server';
import {
  classifyStormEvent,
  layerIdForWindow,
  type StormReport,
  type StormReportsResponse,
  type StormWindow,
} from '@/lib/weather';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Proxies NOAA's public Local Storm Reports (LSR) service — free, no API key,
 * updated ~every 30 minutes. Layers 0/1/2 = Last 24/48/72 Hours (cumulative
 * windows, verified against the service's own `?f=pjson` metadata).
 *
 * We do the NOAA round-trip server-side to avoid CORS, apply an optional
 * state filter via NOAA's own `where` clause (cheaper than shipping the
 * whole country to the client every refresh), and normalize the odd
 * ArcGIS field names into the app's `StormReport` shape. Non hail/wind/
 * tornado reports (rain, flooding, fog, lightning, etc) are dropped here —
 * that's the entire reason Joe wants this tool.
 */

const BASE_URL =
  'https://mapservices.weather.noaa.gov/vector/rest/services/obs/nws_local_storm_reports/MapServer';

type NoaaGeometry = { type: 'Point'; coordinates: [number, number] };

type NoaaFeature = {
  type: 'Feature';
  geometry: NoaaGeometry | null;
  properties: Record<string, unknown> | null;
};

type NoaaFeatureCollection = {
  type: 'FeatureCollection';
  features: NoaaFeature[];
};

function cleanStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s && s.toLowerCase() !== 'null' ? s : null;
}

function isStormWindow(v: string | null): v is StormWindow {
  return v === '24h' || v === '48h' || v === '72h';
}

async function fetchNoaa(url: string): Promise<NoaaFeatureCollection | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/geo+json' },
      signal: controller.signal,
      next: { revalidate: 0 },
    });
    if (!res.ok) return null;
    return (await res.json()) as NoaaFeatureCollection;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const windowParam = searchParams.get('window');
  const stormWindow: StormWindow = isStormWindow(windowParam) ? windowParam : '24h';
  const stateParam = cleanStr(searchParams.get('state'))?.toUpperCase() || null;
  const layerId = layerIdForWindow(stormWindow);

  const where =
    stateParam && /^[A-Z]{2}$/.test(stateParam) ? `state='${stateParam}'` : '1=1';

  const url =
    `${BASE_URL}/${layerId}/query?` +
    new URLSearchParams({
      where,
      outFields: '*',
      f: 'geojson',
      resultRecordCount: '2000',
    }).toString();

  const data = await fetchNoaa(url);

  if (!data || !Array.isArray(data.features)) {
    return NextResponse.json(
      { error: 'NOAA storm report service is unavailable right now — try again shortly.' },
      { status: 502 }
    );
  }

  const reports: StormReport[] = [];
  for (const feature of data.features) {
    const p = feature.properties || {};
    const descript = cleanStr(p.descript);
    const category = classifyStormEvent(descript);
    if (!category) continue;

    const coords = feature.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;
    const lng = coords[0];
    const lat = coords[1];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const epochMs = typeof p.lsr_validtime === 'number' ? p.lsr_validtime : null;
    const validTime = epochMs
      ? new Date(epochMs).toISOString()
      : cleanStr(p.valid_time) || new Date().toISOString();

    const objectId = p.objectid;
    const idSuffix =
      objectId != null ? String(objectId) : `${lat.toFixed(4)}-${lng.toFixed(4)}-${reports.length}`;

    reports.push({
      id: `${stormWindow}-${idSuffix}`,
      category,
      descript: descript || category,
      locDesc: cleanStr(p.loc_desc),
      state: cleanStr(p.state),
      wfo: cleanStr(p.wfo),
      validTime,
      magnitude: cleanStr(p.magnitude),
      units: cleanStr(p.units),
      remarks: cleanStr(p.remarks),
      lat,
      lng,
    });
  }

  reports.sort((a, b) => new Date(b.validTime).getTime() - new Date(a.validTime).getTime());

  const body: StormReportsResponse = {
    reports,
    fetchedAt: new Date().toISOString(),
    window: stormWindow,
    count: reports.length,
    source: 'noaa-lsr',
  };

  return NextResponse.json(body);
}
