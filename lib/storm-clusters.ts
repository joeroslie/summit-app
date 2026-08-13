/**
 * Approximate "damage zone" overlay for the Weather tool.
 *
 * Live / calendar-day views use official NWS storm-based warning polygons
 * (the yellow outlines on HailTrace Recon). Clustered LSR corridors are the
 * fallback when no warning was issued, or on long historical lookbacks.
 *
 * Kept in its own file (rather than lib/weather.ts) so the turf.js dependency
 * — a client-side geometry library — never gets pulled into the
 * app/api/storm-reports server route's bundle.
 */

import * as turf from '@turf/turf';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import {
  STORM_CATEGORIES,
  eventStyle,
  formatMagnitude,
  formatWarningMagnitude,
  haversineMiles,
  isWindDamageReport,
  parseMagnitudeNumber,
  windSpeedMph,
  type StormEventCategory,
  type StormReport,
  type StormWarning,
} from '@/lib/weather';

/**
 * Wind outflow is broader and reports sit farther apart than hail cores.
 * 20 miles + 2-report minimum dropped Gilbert off today's West Valley wind
 * (Avondale clustered; Gilbert ~30 miles east, same cell).
 */
const CLUSTER_BY_CATEGORY: Record<
  StormEventCategory,
  { radiusMiles: number; timeHours: number; bufferMiles: number }
> = {
  hail: { radiusMiles: 25, timeHours: 4, bufferMiles: 6 },
  wind: { radiusMiles: 40, timeHours: 6, bufferMiles: 8 },
  tornado: { radiusMiles: 25, timeHours: 4, bufferMiles: 4 },
};

const DAMAGE_ZONES_STORAGE_KEY = 'summitDamageZones';

export type StormClusterSeverity = 'marginal' | 'moderate' | 'severe';

export const CLUSTER_SEVERITY_STYLES: Record<
  StormClusterSeverity,
  { label: string; fillOpacity: number; weight: number }
> = {
  marginal: { label: 'Marginal', fillOpacity: 0.12, weight: 1.5 },
  moderate: { label: 'Moderate', fillOpacity: 0.24, weight: 2 },
  severe: { label: 'Severe', fillOpacity: 0.4, weight: 2.5 },
};

const SEVERITY_RANK: Record<StormClusterSeverity, number> = {
  marginal: 0,
  moderate: 1,
  severe: 2,
};

export type StormCluster = {
  id: string;
  category: StormEventCategory;
  severity: StormClusterSeverity;
  reportCount: number;
  maxMagnitudeLabel: string | null;
  centroid: { lat: number; lng: number };
  /** GeoJSON polygon in standard [lng, lat] order — feeds straight into Leaflet's L.geoJSON. */
  polygon: Feature<Polygon | MultiPolygon>;
  /** Official NWS warning polygon vs clustered ground reports. */
  kind?: 'warning' | 'reports';
};

export function readStoredDamageZones(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = window.localStorage.getItem(DAMAGE_ZONES_STORAGE_KEY);
    if (raw == null || raw === '') return true;
    return raw === 'on';
  } catch {
    return true;
  }
}

export function writeStoredDamageZones(on: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DAMAGE_ZONES_STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * Severity tiers are anchored to NWS's own severe-thunderstorm criteria
 * (1"+ hail / 58mph+ gust = "severe"), not an arbitrary scale, so "Moderate"
 * here has a real meaning: it met the bar for an official severe warning.
 * Wind-damage LSRs with no mph still count — those are confirmed damage.
 */
export function severityForReport(report: StormReport): StormClusterSeverity {
  if (report.category === 'tornado') return 'severe';
  if (report.category === 'hail') {
    const n = parseMagnitudeNumber(report.magnitude);
    if (n == null) return 'marginal';
    if (n >= 2) return 'severe';
    if (n >= 1) return 'moderate';
    return 'marginal';
  }
  if (report.category === 'wind') {
    const mph = windSpeedMph(report);
    if (mph != null) {
      if (mph >= 75) return 'severe';
      if (mph >= 58) return 'moderate';
      return 'marginal';
    }
    return isWindDamageReport(report) ? 'moderate' : 'marginal';
  }
  return 'marginal';
}

function closeEnough(
  a: StormReport,
  b: StormReport,
  radiusMiles: number,
  timeHours: number
): boolean {
  if (haversineMiles(a, b) > radiusMiles) return false;
  const dtHours =
    Math.abs(new Date(a.validTime).getTime() - new Date(b.validTime).getTime()) / 3_600_000;
  return dtHours <= timeHours;
}

/**
 * Simple flood-fill grouping (O(n^2) pairwise comparisons). Fine for the
 * realistic volume of LSR reports per category per window (tens to low
 * hundreds) — this runs memoized off the already-filtered report list, not
 * on every render. A spatial index (grid/kd-tree) would only be worth it if
 * this ever needs to cluster thousands of points at once.
 */
function groupBySpaceTime(
  reports: StormReport[],
  radiusMiles: number,
  timeHours: number
): StormReport[][] {
  const n = reports.length;
  const visited = new Array(n).fill(false);
  const groups: StormReport[][] = [];
  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    visited[i] = true;
    const stack = [i];
    const group: StormReport[] = [];
    while (stack.length) {
      const idx = stack.pop() as number;
      group.push(reports[idx]);
      for (let j = 0; j < n; j++) {
        if (visited[j]) continue;
        if (closeEnough(reports[idx], reports[j], radiusMiles, timeHours)) {
          visited[j] = true;
          stack.push(j);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

function coordsInStormOrder(group: StormReport[]): [number, number][] {
  const sorted = [...group].sort((a, b) => a.validTime.localeCompare(b.validTime));
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const r of sorted) {
    const coord: [number, number] = [r.lng, r.lat];
    const key = `${coord[0].toFixed(5)},${coord[1].toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(coord);
  }
  return out;
}

/**
 * Buffered corridor along storm motion (time order). Convex hulls filled
 * undamaged area between unrelated corners; recon draws a swath along the
 * track. Round caps on a buffered line cover each report the way a hail
 * swath covers the core.
 */
function buildZonePolygon(
  group: StormReport[],
  bufferMiles: number
): Feature<Polygon | MultiPolygon> | null {
  const coords = coordsInStormOrder(group);
  try {
    if (coords.length === 0) return null;
    if (coords.length === 1) {
      return turf.circle(coords[0], bufferMiles, { steps: 32, units: 'miles' });
    }
    return turf.buffer(turf.lineString(coords), bufferMiles, { units: 'miles' }) ?? null;
  } catch {
    return null;
  }
}

function averagePoint(reports: StormReport[]): { lat: number; lng: number } {
  const lat = reports.reduce((s, r) => s + r.lat, 0) / reports.length;
  const lng = reports.reduce((s, r) => s + r.lng, 0) / reports.length;
  return { lat, lng };
}

/**
 * Groups reports (already filtered by whatever time-window/state/category
 * filters are active) into approximate damage zones, one cluster set per
 * event category so severity coloring stays meaningful per type.
 */
export function clusterStormReports(reports: StormReport[]): StormCluster[] {
  const clusters: StormCluster[] = [];

  STORM_CATEGORIES.forEach((category) => {
    const rules = CLUSTER_BY_CATEGORY[category];
    const catReports = reports.filter((r) => r.category === category);
    const groups = groupBySpaceTime(catReports, rules.radiusMiles, rules.timeHours);

    groups.forEach((group, i) => {
      const polygon = buildZonePolygon(group, rules.bufferMiles);
      if (!polygon) return;

      const magnitudes = group
        .map((r) =>
          category === 'wind' ? windSpeedMph(r) : parseMagnitudeNumber(r.magnitude)
        )
        .filter((n): n is number => n != null);
      const maxMagnitude = magnitudes.length ? Math.max(...magnitudes) : null;
      const maxReport =
        maxMagnitude != null
          ? group.find((r) => {
              const n =
                category === 'wind' ? windSpeedMph(r) : parseMagnitudeNumber(r.magnitude);
              return n === maxMagnitude;
            }) ?? group[0]
          : group[0];

      const severity = group.reduce<StormClusterSeverity>((worst, r) => {
        const s = severityForReport(r);
        return SEVERITY_RANK[s] > SEVERITY_RANK[worst] ? s : worst;
      }, 'marginal');

      clusters.push({
        id: `${category}-${i}`,
        category,
        severity,
        reportCount: group.length,
        maxMagnitudeLabel:
          maxMagnitude != null
            ? formatMagnitude(maxReport)
            : category === 'wind' && group.some(isWindDamageReport)
              ? 'Wind damage'
              : null,
        centroid: averagePoint(group),
        polygon,
        kind: 'reports',
      });
    });
  });

  return clusters;
}

export function severityForWarning(warning: StormWarning): StormClusterSeverity {
  if (warning.category === 'tornado') return 'severe';
  if (warning.category === 'hail') {
    const n = warning.hailTagInches;
    if (n == null) return 'marginal';
    if (n >= 2) return 'severe';
    if (n >= 1) return 'moderate';
    return 'marginal';
  }
  const mph = warning.windTagMph;
  if (mph == null) return 'moderate';
  if (mph >= 75) return 'severe';
  if (mph >= 58) return 'moderate';
  return 'marginal';
}

function reportMagnitudeValue(report: StormReport): number | null {
  if (report.category === 'wind') return windSpeedMph(report);
  return parseMagnitudeNumber(report.magnitude);
}

function reportsInsideWarning(warning: StormWarning, reports: StormReport[]): StormReport[] {
  const polygon = warning.polygon as Feature<Polygon | MultiPolygon>;
  const search =
    turf.buffer(polygon, 3, { units: 'miles' }) ?? polygon;
  return reports.filter((report) => {
    if (report.category !== warning.category) return false;
    try {
      return turf.booleanPointInPolygon(turf.point([report.lng, report.lat]), search);
    } catch {
      return false;
    }
  });
}

function labelForWarning(warning: StormWarning, inside: StormReport[]): string | null {
  const magnitudes = inside
    .map((r) => reportMagnitudeValue(r))
    .filter((n): n is number => n != null);
  if (magnitudes.length) {
    const max = Math.max(...magnitudes);
    const maxReport = inside.find((r) => reportMagnitudeValue(r) === max) ?? inside[0];
    return formatMagnitude(maxReport);
  }
  if (inside.some(isWindDamageReport)) return 'Wind damage';
  return formatWarningMagnitude(warning);
}

export function clustersFromWarnings(
  warnings: StormWarning[],
  reports: StormReport[] = []
): StormCluster[] {
  return warnings.flatMap((warning) => {
    const geometry = warning.polygon?.geometry;
    if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) {
      return [];
    }
    const inside = reportsInsideWarning(warning, reports);
    const severity = inside.length
      ? inside.reduce<StormClusterSeverity>((worst, r) => {
          const s = severityForReport(r);
          return SEVERITY_RANK[s] > SEVERITY_RANK[worst] ? s : worst;
        }, 'marginal')
      : severityForWarning(warning);
    return [
      {
        id: warning.id,
        category: warning.category,
        severity,
        reportCount: inside.length,
        maxMagnitudeLabel: labelForWarning(warning, inside),
        centroid: warning.centroid,
        polygon: warning.polygon as Feature<Polygon | MultiPolygon>,
        kind: 'warning' as const,
      },
    ];
  });
}

/**
 * Official warning polygons win for any category that has them (that's the
 * Recon outline). Categories with no warning still get clustered LSRs so a
 * lone gust without an SVR isn't invisible.
 */
export function mergeDamageZones(
  reports: StormReport[],
  warnings: StormWarning[]
): StormCluster[] {
  const fromWarnings = clustersFromWarnings(warnings, reports);
  const warningCats = new Set(fromWarnings.map((c) => c.category));
  const leftover = reports.filter((r) => !warningCats.has(r.category));
  return [...fromWarnings, ...clusterStormReports(leftover)];
}

export function zoneFillColor(category: StormEventCategory): string {
  return eventStyle(category).marker;
}

export function zoneStrokeColor(category: StormEventCategory): string {
  return eventStyle(category).markerStroke;
}
