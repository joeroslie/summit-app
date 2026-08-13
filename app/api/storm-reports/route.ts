import { NextRequest, NextResponse } from 'next/server';
import {
  bboxAroundPoint,
  classifyStormEvent,
  classifyStormWarning,
  clampNearRadiusMiles,
  DEFAULT_NEAR_RADIUS_MILES,
  haversineMiles,
  isLiveStormWindow,
  isStormWindow,
  layerIdForWindow,
  mergeStormReports,
  parseStormDayFormat,
  STORM_DAY_LOOKBACK_YEARS,
  stormDayUtcBounds,
  stormWindowMeta,
  type StormReport,
  type StormReportsResponse,
  type StormWarning,
  type StormWarningPolygon,
  type StormWindow,
} from '@/lib/weather';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Storm reports proxy.
 *
 * Live windows (24/48/72h): NOAA's public Local Storm Reports MapServer
 * merged with IEM's live LSR archive for the same hours. NOAA alone lags
 * IEM by minutes to hours, which hid current reports on the Weather map
 * that Home already showed from IEM.
 *
 * Damage zones: IEM storm-based warnings (severe thunderstorm / tornado)
 * for live windows and calendar days — the official polygons HailTrace
 * Recon outlines. Longer historical windows skip warnings (too many).
 *
 * Historical windows (3/6/9 months, 1 year, 2 years): Iowa Environmental
 * Mesonet's LSR archive, which holds the same NWS reports going back years.
 *
 * Optional `day=YYYY-MM-DD` (with `tzOffset` minutes from the client) fetches
 * that local calendar day from IEM instead of a rolling window.
 */

const NOAA_BASE =
  'https://mapservices.weather.noaa.gov/vector/rest/services/obs/nws_local_storm_reports/MapServer';
const IEM_LSR_URL = 'https://mesonet.agron.iastate.edu/geojson/lsr.py';
const IEM_SBW_URL = 'https://mesonet.agron.iastate.edu/geojson/sbw.py';
const UA = 'SummitRoofCRM/1.0 (storm-reports; local-dev)';
const MAX_REPORTS = 2000;
const MAX_WARNINGS = 400;

type GeoJsonGeometry = { type: string; coordinates?: unknown };
type GeoJsonFeature = {
  type: 'Feature';
  id?: string | number;
  geometry: GeoJsonGeometry | null;
  properties: Record<string, unknown> | null;
};
type GeoJsonCollection = {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
};

function cleanStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s && s.toLowerCase() !== 'null' ? s : null;
}

function parseCoordPair(geometry: GeoJsonGeometry | null): { lat: number; lng: number } | null {
  const coords = geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function parseLatLng(rawLat: string | null, rawLng: string | null): { lat: number; lng: number } | null {
  if (rawLat == null || rawLng == null) return null;
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function parseRadiusMiles(raw: string | null): number {
  if (raw == null || raw === '') return DEFAULT_NEAR_RADIUS_MILES;
  return clampNearRadiusMiles(Number(raw));
}

async function fetchGeoJson(url: string, timeoutMs: number): Promise<GeoJsonCollection | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/geo+json, application/json', 'User-Agent': UA },
      signal: controller.signal,
      next: { revalidate: 0 },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as GeoJsonCollection;
    if (!data || !Array.isArray(data.features)) return null;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function mapNoaaFeature(feature: GeoJsonFeature, stormWindow: StormWindow, index: number): StormReport | null {
  const p = feature.properties || {};
  const descript = cleanStr(p.descript);
  const category = classifyStormEvent(descript);
  if (!category) return null;

  const point = parseCoordPair(feature.geometry);
  if (!point) return null;

  const epochMs = typeof p.lsr_validtime === 'number' ? p.lsr_validtime : null;
  const validTime = epochMs
    ? new Date(epochMs).toISOString()
    : cleanStr(p.valid_time) || new Date().toISOString();

  const objectId = p.objectid;
  const idSuffix =
    objectId != null ? String(objectId) : `${point.lat.toFixed(4)}-${point.lng.toFixed(4)}-${index}`;

  return {
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
    lat: point.lat,
    lng: point.lng,
  };
}

function mapIemFeature(feature: GeoJsonFeature, stormWindow: StormWindow, index: number): StormReport | null {
  const p = feature.properties || {};
  const descript = cleanStr(p.typetext) || cleanStr(p.type);
  const category = classifyStormEvent(descript);
  if (!category) return null;

  const point = parseCoordPair(feature.geometry);
  if (!point) return null;

  const validRaw = cleanStr(p.valid);
  const validTime = validRaw ? new Date(validRaw).toISOString() : new Date().toISOString();
  if (Number.isNaN(new Date(validTime).getTime())) return null;

  const productId = cleanStr(p.product_id);
  // One NWS LSR product often contains many reports — product_id alone is not unique.
  const id = [
    'iem',
    stormWindow,
    productId || 'x',
    validTime,
    point.lat.toFixed(4),
    point.lng.toFixed(4),
    category,
    String(index),
  ].join('-');

  return {
    id,
    category,
    descript: descript || category,
    locDesc: cleanStr(p.city),
    state: cleanStr(p.st) || cleanStr(p.state),
    wfo: cleanStr(p.wfo),
    validTime,
    magnitude: cleanStr(p.magnitude),
    units: cleanStr(p.unit),
    remarks: cleanStr(p.remark),
    lat: point.lat,
    lng: point.lng,
  };
}

async function fetchNoaaLive(opts: {
  stormWindow: StormWindow;
  state: string | null;
  origin: { lat: number; lng: number } | null;
  radiusMiles: number;
}): Promise<GeoJsonCollection | null> {
  const layerId = layerIdForWindow(opts.stormWindow);
  const where = opts.state && /^[A-Z]{2}$/.test(opts.state) ? `state='${opts.state}'` : '1=1';
  const params = new URLSearchParams({
    where,
    outFields: '*',
    f: 'geojson',
    resultRecordCount: String(MAX_REPORTS),
  });
  if (opts.origin) {
    const box = bboxAroundPoint(opts.origin.lat, opts.origin.lng, opts.radiusMiles);
    params.set('geometry', `${box.west},${box.south},${box.east},${box.north}`);
    params.set('geometryType', 'esriGeometryEnvelope');
    params.set('inSR', '4326');
    params.set('spatialRel', 'esriSpatialRelIntersects');
  }
  return fetchGeoJson(`${NOAA_BASE}/${layerId}/query?${params.toString()}`, 9000);
}

async function fetchIemHistorical(opts: {
  stormWindow: StormWindow;
  state: string | null;
  origin: { lat: number; lng: number } | null;
  radiusMiles: number;
  dayRange?: { sts: string; ets: string };
}): Promise<GeoJsonCollection | null> {
  const params = new URLSearchParams();
  if (opts.dayRange) {
    params.set('sts', iemTimestamp(opts.dayRange.sts));
    params.set('ets', iemTimestamp(opts.dayRange.ets));
  } else {
    params.set('hours', String(stormWindowMeta(opts.stormWindow).hours));
  }
  if (opts.state && /^[A-Z]{2}$/.test(opts.state)) {
    params.set('states', opts.state);
  }
  if (opts.origin) {
    const box = bboxAroundPoint(opts.origin.lat, opts.origin.lng, opts.radiusMiles);
    params.set('west', String(box.west));
    params.set('east', String(box.east));
    params.set('south', String(box.south));
    params.set('north', String(box.north));
  }
  return fetchGeoJson(`${IEM_LSR_URL}?${params.toString()}`, 20000);
}

function warningWindowBounds(opts: {
  stormWindow: StormWindow;
  dayRange?: { sts: string; ets: string };
}): { sts: string; ets: string } | null {
  if (opts.dayRange) return opts.dayRange;
  if (!isLiveStormWindow(opts.stormWindow)) return null;
  const hours = stormWindowMeta(opts.stormWindow).hours;
  const ets = new Date();
  const sts = new Date(ets.getTime() - hours * 3_600_000);
  return { sts: sts.toISOString(), ets: ets.toISOString() };
}

async function fetchIemWarnings(opts: {
  stormWindow: StormWindow;
  state: string | null;
  dayRange?: { sts: string; ets: string };
}): Promise<GeoJsonCollection | null> {
  const bounds = warningWindowBounds(opts);
  if (!bounds) return null;
  const params = new URLSearchParams({
    sts: iemTimestamp(bounds.sts),
    ets: iemTimestamp(bounds.ets),
  });
  if (opts.state && /^[A-Z]{2}$/.test(opts.state)) {
    params.set('states', opts.state);
  }
  return fetchGeoJson(`${IEM_SBW_URL}?${params.toString()}`, 20000);
}

function flattenPositions(coords: unknown, out: { lat: number; lng: number }[]): void {
  if (!Array.isArray(coords) || coords.length === 0) return;
  if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) out.push({ lat, lng });
    return;
  }
  for (const item of coords) flattenPositions(item, out);
}

function warningCentroid(geometry: GeoJsonGeometry | null): { lat: number; lng: number } | null {
  const points: { lat: number; lng: number }[] = [];
  flattenPositions(geometry?.coordinates, points);
  if (points.length === 0) return null;
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lng = points.reduce((s, p) => s + p.lng, 0) / points.length;
  return { lat, lng };
}

function warningInRadius(
  geometry: GeoJsonGeometry | null,
  origin: { lat: number; lng: number },
  radiusMiles: number
): boolean {
  const points: { lat: number; lng: number }[] = [];
  flattenPositions(geometry?.coordinates, points);
  if (points.some((p) => haversineMiles(origin, p) <= radiusMiles)) return true;
  const centroid = warningCentroid(geometry);
  return centroid ? haversineMiles(origin, centroid) <= radiusMiles : false;
}

function parseTagNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asWarningPolygon(geometry: GeoJsonGeometry | null): StormWarningPolygon | null {
  if (!geometry) return null;
  const type = geometry.type;
  if (type !== 'Polygon' && type !== 'MultiPolygon') return null;
  if (geometry.coordinates == null) return null;
  return {
    type: 'Feature',
    geometry: {
      type,
      coordinates: geometry.coordinates,
    },
    properties: {},
  };
}

function mapIemWarning(feature: GeoJsonFeature): StormWarning | null {
  const p = feature.properties || {};
  const status = cleanStr(p.status)?.toUpperCase();
  if (status === 'CAN') return null;
  const phenomena = cleanStr(p.phenomena)?.toUpperCase();
  const windTagMph = parseTagNumber(p.max_windtag ?? p.windtag);
  const hailTagInches = parseTagNumber(p.max_hailtag ?? p.hailtag);
  const category = classifyStormWarning({ phenomena, windTagMph, hailTagInches });
  if (!category) return null;
  const polygon = asWarningPolygon(feature.geometry);
  if (!polygon) return null;
  const centroid = warningCentroid(feature.geometry);
  if (!centroid) return null;
  const issuedAt =
    cleanStr(p.issue) || cleanStr(p.polygon_begin) || new Date().toISOString();
  const id =
    cleanStr(feature.id != null ? String(feature.id) : null) ||
    [phenomena, cleanStr(p.wfo), p.eventid, issuedAt].join('-');
  return {
    id,
    category,
    wfo: cleanStr(p.wfo),
    issuedAt,
    expiresAt: cleanStr(p.expire) || cleanStr(p.polygon_end),
    windTagMph,
    hailTagInches,
    centroid,
    polygon,
  };
}

function collectWarnings(
  data: GeoJsonCollection | null,
  opts: { origin: { lat: number; lng: number } | null; radiusMiles: number }
): StormWarning[] {
  if (!data) return [];
  const byEvent = new Map<string, StormWarning>();
  for (const feature of data.features) {
    const mapped = mapIemWarning(feature);
    if (!mapped) continue;
    if (opts.origin && !warningInRadius(feature.geometry, opts.origin, opts.radiusMiles)) {
      continue;
    }
    const p = feature.properties || {};
    const key = [
      cleanStr(p.year) || '',
      mapped.wfo || '',
      cleanStr(p.phenomena) || '',
      p.eventid != null ? String(p.eventid) : mapped.id,
    ].join('|');
    const prev = byEvent.get(key);
    if (!prev || mapped.issuedAt > prev.issuedAt) byEvent.set(key, mapped);
    if (byEvent.size >= MAX_WARNINGS) break;
  }
  return [...byEvent.values()].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
}

function iemTimestamp(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, 'Z');
}

function parseTzOffsetMinutes(raw: string | null): number {
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.abs(n) > 14 * 60) return 0;
  return Math.round(n);
}

function dayIsWithinArchive(day: string): boolean {
  const [y, mo, d] = day.split('-').map(Number);
  const t = Date.UTC(y, mo - 1, d);
  const now = Date.now();
  const twoYears = STORM_DAY_LOOKBACK_YEARS * 366 * 24 * 60 * 60 * 1000;
  return t <= now + 2 * 24 * 60 * 60 * 1000 && t >= now - twoYears;
}

function collectReports(
  data: GeoJsonCollection | null,
  mapper: (feature: GeoJsonFeature, stormWindow: StormWindow, index: number) => StormReport | null,
  opts: {
    stormWindow: StormWindow;
    origin: { lat: number; lng: number } | null;
    radiusMiles: number;
    rangeStart: number | null;
    rangeEnd: number | null;
    minTimeMs?: number;
  }
): StormReport[] {
  if (!data) return [];
  const reports: StormReport[] = [];
  for (let i = 0; i < data.features.length; i += 1) {
    const mapped = mapper(data.features[i], opts.stormWindow, i);
    if (!mapped) continue;
    if (opts.origin && haversineMiles(opts.origin, mapped) > opts.radiusMiles) continue;
    const t = new Date(mapped.validTime).getTime();
    if (!Number.isFinite(t)) continue;
    if (opts.minTimeMs != null && t < opts.minTimeMs) continue;
    if (opts.rangeStart != null && opts.rangeEnd != null) {
      if (t < opts.rangeStart || t >= opts.rangeEnd) continue;
    }
    reports.push(mapped);
    if (reports.length >= MAX_REPORTS) break;
  }
  return reports;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const requestedDay = parseStormDayFormat(searchParams.get('day'));
  const day = requestedDay && dayIsWithinArchive(requestedDay) ? requestedDay : null;
  const windowParam = searchParams.get('window');
  const stormWindow: StormWindow = day
    ? 'day'
    : isStormWindow(windowParam) && windowParam !== 'day'
      ? windowParam
      : '24h';
  const stateParam = cleanStr(searchParams.get('state'))?.toUpperCase() || null;
  const origin = parseLatLng(searchParams.get('lat'), searchParams.get('lng'));
  const radiusMiles = parseRadiusMiles(searchParams.get('radius'));
  const live = !day && isLiveStormWindow(stormWindow);
  const dayRange = day
    ? stormDayUtcBounds(day, parseTzOffsetMinutes(searchParams.get('tzOffset')))
    : undefined;

  const rangeStart = dayRange ? new Date(dayRange.sts).getTime() : null;
  const rangeEnd = dayRange ? new Date(dayRange.ets).getTime() : null;
  const collectOpts = {
    stormWindow,
    origin,
    radiusMiles,
    rangeStart,
    rangeEnd,
  };

  let reports: StormReport[] = [];
  let warnings: StormWarning[] = [];
  let source: StormReportsResponse['source'] = live ? 'noaa-lsr' : 'iem-lsr';
  const warningOpts = { stormWindow, state: stateParam, dayRange };

  if (live) {
    // NOAA's MapServer lags IEM by minutes to hours. Home and the Weather map
    // both need the same live picture, so merge IEM for the same hour window.
    const [noaa, iem, sbw] = await Promise.all([
      fetchNoaaLive({ stormWindow, state: stateParam, origin, radiusMiles }),
      fetchIemHistorical({ stormWindow, state: stateParam, origin, radiusMiles }),
      fetchIemWarnings(warningOpts),
    ]);
    if (!noaa && !iem) {
      return NextResponse.json(
        { error: 'NOAA storm report service is unavailable right now — try again shortly.' },
        { status: 502 }
      );
    }
    const minTimeMs = Date.now() - stormWindowMeta(stormWindow).hours * 3_600_000;
    reports = mergeStormReports([
      collectReports(iem, mapIemFeature, { ...collectOpts, minTimeMs }),
      collectReports(noaa, mapNoaaFeature, { ...collectOpts, minTimeMs }),
    ]);
    warnings = collectWarnings(sbw, { origin, radiusMiles });
    source = iem ? 'iem-lsr' : 'noaa-lsr';
  } else {
    const [data, sbw] = await Promise.all([
      fetchIemHistorical({
        stormWindow,
        state: stateParam,
        origin,
        radiusMiles,
        dayRange,
      }),
      fetchIemWarnings(warningOpts),
    ]);
    if (!data) {
      return NextResponse.json(
        {
          error:
            'Historical storm archive is unavailable right now — try a shorter window or pick a location.',
        },
        { status: 502 }
      );
    }
    reports = collectReports(data, mapIemFeature, collectOpts);
    warnings = collectWarnings(sbw, { origin, radiusMiles });
    source = 'iem-lsr';
  }

  reports.sort((a, b) => new Date(b.validTime).getTime() - new Date(a.validTime).getTime());
  if (reports.length > MAX_REPORTS) reports = reports.slice(0, MAX_REPORTS);

  const body: StormReportsResponse = {
    reports,
    warnings,
    fetchedAt: new Date().toISOString(),
    window: stormWindow,
    day,
    count: reports.length,
    source,
  };

  return NextResponse.json(body);
}
