/** Client-side snap / smart-assist for roof tracing (no external API). */

import { haversineFeet, type LatLngPoint } from './roof-geometry';

export type SnapMode = {
  /** Snap to existing vertices */
  vertex: boolean;
  /** Snap onto existing edges */
  edge: boolean;
  /** Orthogonal (90°) to previous segment, in local feet frame */
  ortho: boolean;
  /** Snap near first point to close polygon */
  close: boolean;
  /** Prefer smart ghost corners on click */
  suggest: boolean;
};

export const DEFAULT_SNAP_MODE: SnapMode = {
  vertex: true,
  edge: true,
  ortho: true,
  close: true,
  suggest: true,
};

/** Snap radii in feet (field-friendly at house zoom). */
export const SNAP_RADIUS_FT = {
  vertex: 4.5,
  edge: 3.5,
  close: 6,
  suggest: 8,
  ortho: 3.5,
};

export type SuggestCorner = {
  point: LatLngPoint;
  kind: 'continue' | 'ortho-left' | 'ortho-right' | 'close-rect' | 'close';
  label: string;
};

function toRad(deg: number) {
  return (deg * Math.PI) / 180;
}

/** Local feet frame around origin (equirectangular). */
export function toLocalFeet(
  p: LatLngPoint,
  origin: LatLngPoint
): { x: number; y: number } {
  const cosLat = Math.cos(toRad(origin.lat));
  const ftPerDegLat = (Math.PI / 180) * 20902231;
  const ftPerDegLng = ftPerDegLat * cosLat;
  return {
    x: (p.lng - origin.lng) * ftPerDegLng,
    y: (p.lat - origin.lat) * ftPerDegLat,
  };
}

export function fromLocalFeet(
  xy: { x: number; y: number },
  origin: LatLngPoint
): LatLngPoint {
  const cosLat = Math.cos(toRad(origin.lat));
  const ftPerDegLat = (Math.PI / 180) * 20902231;
  const ftPerDegLng = Math.max(ftPerDegLat * cosLat, 1e-9);
  return {
    lat: origin.lat + xy.y / ftPerDegLat,
    lng: origin.lng + xy.x / ftPerDegLng,
  };
}

function distFt(a: LatLngPoint, b: LatLngPoint) {
  return haversineFeet(a, b);
}

function projectOnSegment(
  p: LatLngPoint,
  a: LatLngPoint,
  b: LatLngPoint,
  origin: LatLngPoint
): { point: LatLngPoint; t: number; distFt: number } {
  const P = toLocalFeet(p, origin);
  const A = toLocalFeet(a, origin);
  const B = toLocalFeet(b, origin);
  const abx = B.x - A.x;
  const aby = B.y - A.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-8) {
    return { point: a, t: 0, distFt: distFt(p, a) };
  }
  let t = ((P.x - A.x) * abx + (P.y - A.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const Q = { x: A.x + t * abx, y: A.y + t * aby };
  const point = fromLocalFeet(Q, origin);
  return { point, t, distFt: distFt(p, point) };
}

/**
 * Snap a raw click to vertices, edges, ortho lines, close, or suggestions.
 * Pure geometry — fast enough for every map click.
 */
export function smartSnapPoint(
  raw: LatLngPoint,
  existing: LatLngPoint[],
  mode: SnapMode = DEFAULT_SNAP_MODE,
  suggestions: SuggestCorner[] = []
): { point: LatLngPoint; snapped: string | null } {
  if (existing.length === 0 && suggestions.length === 0) {
    return { point: raw, snapped: null };
  }

  const origin = existing[0] || raw;
  type BestSnap = { point: LatLngPoint; score: number; label: string };
  const bestBox: { current: BestSnap | null } = { current: null };

  const consider = (
    point: LatLngPoint,
    radius: number,
    label: string,
    priority: number
  ) => {
    const d = distFt(raw, point);
    if (d > radius) return;
    // Lower score wins; priority breaks ties (lower = better)
    const score = d + priority * 0.01;
    if (!bestBox.current || score < bestBox.current.score) {
      bestBox.current = { point, score, label };
    }
  };

  // 1) Close polygon to first vertex (high priority when near start)
  if (mode.close && existing.length >= 3) {
    consider(existing[0], SNAP_RADIUS_FT.close, 'close', 0);
  }

  // 2) Existing vertices
  if (mode.vertex) {
    for (const v of existing) {
      consider(v, SNAP_RADIUS_FT.vertex, 'vertex', 1);
    }
  }

  // 3) Smart ghost suggestions
  if (mode.suggest) {
    for (const s of suggestions) {
      consider(s.point, SNAP_RADIUS_FT.suggest, s.kind, 2);
    }
  }

  // 4) Snap onto existing edges
  if (mode.edge && existing.length >= 2) {
    for (let i = 0; i < existing.length; i++) {
      const a = existing[i];
      const b = existing[(i + 1) % existing.length];
      // Only snap to closed edges if polygon closed enough; always open segments between consecutive points
      if (i === existing.length - 1 && existing.length < 3) continue;
      // Prefer open chain edges (not closing edge until closed)
      if (i === existing.length - 1) continue;
      const proj = projectOnSegment(raw, a, b, origin);
      if (proj.t > 0.05 && proj.t < 0.95) {
        consider(proj.point, SNAP_RADIUS_FT.edge, 'edge', 3);
      }
    }
  }

  // 5) Ortho from last point relative to last segment direction
  if (mode.ortho && existing.length >= 1) {
    const last = existing[existing.length - 1];
    const lastLocal = toLocalFeet(last, origin);
    const rawLocal = toLocalFeet(raw, origin);

    let dir = { x: 1, y: 0 };
    if (existing.length >= 2) {
      const prev = existing[existing.length - 2];
      const prevLocal = toLocalFeet(prev, origin);
      const dx = lastLocal.x - prevLocal.x;
      const dy = lastLocal.y - prevLocal.y;
      const len = Math.hypot(dx, dy) || 1;
      dir = { x: dx / len, y: dy / len };
    }

    // Parallel and perpendicular unit axes
    const axes = [
      dir,
      { x: -dir.x, y: -dir.y },
      { x: -dir.y, y: dir.x },
      { x: dir.y, y: -dir.x },
    ];

    for (const ax of axes) {
      const vx = rawLocal.x - lastLocal.x;
      const vy = rawLocal.y - lastLocal.y;
      const along = vx * ax.x + vy * ax.y;
      if (along < 1) continue; // only outward
      const proj = {
        x: lastLocal.x + ax.x * along,
        y: lastLocal.y + ax.y * along,
      };
      const point = fromLocalFeet(proj, origin);
      const lateral = Math.abs(vx * -ax.y + vy * ax.x);
      if (lateral <= SNAP_RADIUS_FT.ortho) {
        consider(point, SNAP_RADIUS_FT.ortho + 0.5, 'ortho', 4);
      }
    }
  }

  if (bestBox.current) {
    return { point: bestBox.current.point, snapped: bestBox.current.label };
  }
  return { point: raw, snapped: null };
}

/**
 * Suggest next roof corners from current chain (no imagery AI).
 * - continue last edge length
 * - 90° left / right same length
 * - complete rectangle after 3 points
 * - close when near complete
 */
export function suggestNextCorners(points: LatLngPoint[]): SuggestCorner[] {
  if (points.length < 1) return [];
  const out: SuggestCorner[] = [];
  const origin = points[0];

  if (points.length === 1) {
    // Cardinal offsets ~20 ft from first pin (helps first edge)
    const dirs: Array<{ x: number; y: number; label: string }> = [
      { x: 20, y: 0, label: 'E ~20′' },
      { x: 0, y: 20, label: 'N ~20′' },
      { x: -20, y: 0, label: 'W ~20′' },
      { x: 0, y: -20, label: 'S ~20′' },
    ];
    for (const d of dirs) {
      out.push({
        point: fromLocalFeet(
          { x: toLocalFeet(points[0], origin).x + d.x, y: toLocalFeet(points[0], origin).y + d.y },
          origin
        ),
        kind: 'continue',
        label: d.label,
      });
    }
    return out;
  }

  const a = points[points.length - 2];
  const b = points[points.length - 1];
  const A = toLocalFeet(a, origin);
  const B = toLocalFeet(b, origin);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len = Math.hypot(dx, dy) || 20;
  const ux = dx / (Math.hypot(dx, dy) || 1);
  const uy = dy / (Math.hypot(dx, dy) || 1);
  // Perpendicular
  const lx = -uy;
  const ly = ux;

  // Continue same direction & length
  out.push({
    point: fromLocalFeet({ x: B.x + ux * len, y: B.y + uy * len }, origin),
    kind: 'continue',
    label: 'Continue',
  });
  // 90° left / right same length
  out.push({
    point: fromLocalFeet({ x: B.x + lx * len, y: B.y + ly * len }, origin),
    kind: 'ortho-left',
    label: '90° L',
  });
  out.push({
    point: fromLocalFeet({ x: B.x - lx * len, y: B.y - ly * len }, origin),
    kind: 'ortho-right',
    label: '90° R',
  });

  // After 3 points: parallelogram / rectangle close
  if (points.length === 3) {
    const p0 = toLocalFeet(points[0], origin);
    const p1 = toLocalFeet(points[1], origin);
    const p2 = toLocalFeet(points[2], origin);
    // p3 = p0 + (p2 - p1) for parallelogram, or p0 + (p2-p1) rotated for rect
    const rect = {
      x: p0.x + (p2.x - p1.x),
      y: p0.y + (p2.y - p1.y),
    };
    // Better rectangle: p3 = p0 + R90(p1-p0) scaled... use vector complete:
    // p3 = p0 + (p2 - p1) is parallelogram through p0,p1,p2 order if points are sequential
    // For chain p0→p1→p2, fourth is p0 + (p2-p1)? Actually: p3 = p0 + (p2-p1) only if p1-p0 = p2-p3.
    // Correct parallelogram: p3 = p0 + p2 - p1
    const para = {
      x: p0.x + p2.x - p1.x,
      y: p0.y + p2.y - p1.y,
    };
    out.push({
      point: fromLocalFeet(para, origin),
      kind: 'close-rect',
      label: 'Close ▭',
    });
    // Also ortho rectangle: from p2 go perpendicular to p1-p0 with length of p0-p1? 
    void rect;
  }

  // Suggest closing to start when 3+ points
  if (points.length >= 3) {
    out.push({
      point: points[0],
      kind: 'close',
      label: 'Close',
    });
  }

  return out;
}

/** True if click is near first point (user intends to close). */
export function isNearClose(
  raw: LatLngPoint,
  points: LatLngPoint[],
  radiusFt = SNAP_RADIUS_FT.close
): boolean {
  if (points.length < 3) return false;
  return distFt(raw, points[0]) <= radiusFt;
}
