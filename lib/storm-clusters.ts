/**
 * Approximate "damage zone" overlay for the Weather tool.
 *
 * This is NOT radar-derived hail-swath data (that's NOAA's MRMS MESH product,
 * decoded from raw GRIB2 grids — see the note at the bottom of this file).
 * Instead, this groups the LSR point reports we already have into spatial +
 * temporal clusters ("same storm, same afternoon") and draws a buffered hull
 * around each cluster so it reads as a "zone" instead of a scatter of dots —
 * a standard, well-understood GIS technique (buffered point-cluster
 * visualization), not an attempt to fake radar data.
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
  haversineMiles,
  parseMagnitudeNumber,
  type StormEventCategory,
  type StormReport,
} from '@/lib/weather';

/** Reports within this distance of each other can join the same cluster. */
const CLUSTER_RADIUS_MILES = 20;
/** ...and only if they also happened within this many hours of each other. */
const CLUSTER_TIME_WINDOW_HOURS = 4;
/** Outward buffer applied to each cluster's hull so it reads as a "zone." */
const ZONE_BUFFER_MILES = 4;
/** Lone reports don't form a "zone" — the pin already covers that case. */
const MIN_REPORTS_FOR_ZONE = 2;

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
};

/**
 * Severity tiers are anchored to NWS's own severe-thunderstorm criteria
 * (1"+ hail / 58mph+ gust = "severe"), not an arbitrary scale, so "Moderate"
 * here has a real meaning: it met the bar for an official severe warning.
 */
export function severityForReport(report: StormReport): StormClusterSeverity {
  if (report.category === 'tornado') return 'severe';
  const n = parseMagnitudeNumber(report.magnitude);
  if (n == null) return 'marginal';
  if (report.category === 'hail') {
    if (n >= 2) return 'severe';
    if (n >= 1) return 'moderate';
    return 'marginal';
  }
  if (report.category === 'wind') {
    if (n >= 75) return 'severe';
    if (n >= 58) return 'moderate';
    return 'marginal';
  }
  return 'marginal';
}

function closeEnough(a: StormReport, b: StormReport): boolean {
  if (haversineMiles(a, b) > CLUSTER_RADIUS_MILES) return false;
  const dtHours =
    Math.abs(new Date(a.validTime).getTime() - new Date(b.validTime).getTime()) / 3_600_000;
  return dtHours <= CLUSTER_TIME_WINDOW_HOURS;
}

/**
 * Simple flood-fill grouping (O(n^2) pairwise comparisons). Fine for the
 * realistic volume of LSR reports per category per window (tens to low
 * hundreds) — this runs memoized off the already-filtered report list, not
 * on every render. A spatial index (grid/kd-tree) would only be worth it if
 * this ever needs to cluster thousands of points at once.
 */
function groupBySpaceTime(reports: StormReport[]): StormReport[][] {
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
        if (closeEnough(reports[idx], reports[j])) {
          visited[j] = true;
          stack.push(j);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

function dedupeCoords(coords: [number, number][]): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const c of coords) {
    const key = `${c[0].toFixed(5)},${c[1].toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * Builds a "zone" polygon around a cluster's points: a buffered convex hull
 * for 3+ points, a buffered line (capsule shape) for 2, a buffered circle
 * for 1. All three read as a shaded "area" rather than connect-the-dots.
 */
function buildZonePolygon(group: StormReport[]): Feature<Polygon | MultiPolygon> | null {
  const coords = dedupeCoords(group.map((r): [number, number] => [r.lng, r.lat]));
  try {
    if (coords.length === 1) {
      return turf.circle(coords[0], ZONE_BUFFER_MILES, { steps: 32, units: 'miles' });
    }
    if (coords.length === 2) {
      const line = turf.lineString(coords);
      return turf.buffer(line, ZONE_BUFFER_MILES, { units: 'miles' }) ?? null;
    }
    const fc = turf.featureCollection(coords.map((c) => turf.point(c)));
    const hull = turf.convex(fc, { concavity: Infinity });
    if (hull) {
      return turf.buffer(hull, ZONE_BUFFER_MILES, { units: 'miles' }) ?? null;
    }
    // Collinear points (convex hull returns null) — fall back to a buffered line.
    return turf.buffer(turf.lineString(coords), ZONE_BUFFER_MILES, { units: 'miles' }) ?? null;
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
    const catReports = reports.filter((r) => r.category === category);
    const groups = groupBySpaceTime(catReports);

    groups.forEach((group, i) => {
      if (group.length < MIN_REPORTS_FOR_ZONE) return;
      const polygon = buildZonePolygon(group);
      if (!polygon) return;

      const magnitudes = group
        .map((r) => parseMagnitudeNumber(r.magnitude))
        .filter((n): n is number => n != null);
      const maxMagnitude = magnitudes.length ? Math.max(...magnitudes) : null;
      const maxReport = maxMagnitude != null
        ? group.find((r) => parseMagnitudeNumber(r.magnitude) === maxMagnitude) ?? group[0]
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
        maxMagnitudeLabel: maxMagnitude != null ? formatMagnitude(maxReport) : null,
        centroid: averagePoint(group),
        polygon,
      });
    });
  });

  return clusters;
}

export function zoneFillColor(category: StormEventCategory): string {
  return eventStyle(category).marker;
}

export function zoneStrokeColor(category: StormEventCategory): string {
  return eventStyle(category).markerStroke;
}
