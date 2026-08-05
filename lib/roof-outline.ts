/** Free roof outline helpers — OSM footprints + Solar segment boxes. */

export type LatLngPoint = { lat: number; lng: number };

export type LatLngBox = {
  sw: { latitude: number; longitude: number };
  ne: { latitude: number; longitude: number };
};

/** Axis-aligned box → closed ring (SW → SE → NE → NW). */
export function boxToRing(box: LatLngBox): LatLngPoint[] {
  const { sw, ne } = box;
  return [
    { lat: sw.latitude, lng: sw.longitude },
    { lat: sw.latitude, lng: ne.longitude },
    { lat: ne.latitude, lng: ne.longitude },
    { lat: ne.latitude, lng: sw.longitude },
  ];
}

function cross(
  o: LatLngPoint,
  a: LatLngPoint,
  b: LatLngPoint
): number {
  return (a.lng - o.lng) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lng - o.lng);
}

/** Monotone-chain convex hull in lng/lat. Returns CCW ring (not closed duplicate). */
export function convexHull(points: LatLngPoint[]): LatLngPoint[] {
  const uniq = new Map<string, LatLngPoint>();
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    uniq.set(`${p.lat.toFixed(7)},${p.lng.toFixed(7)}`, p);
  }
  const pts = [...uniq.values()].sort(
    (a, b) => a.lng - b.lng || a.lat - b.lat
  );
  if (pts.length <= 2) return pts;

  const lower: LatLngPoint[] = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: LatLngPoint[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Prefer segment boxes (tighter) → building box for a starter outline. */
export function outlineFromSolarBoxes(opts: {
  buildingBox?: LatLngBox | null;
  segmentBoxes?: LatLngBox[];
}): LatLngPoint[] {
  const corners: LatLngPoint[] = [];
  for (const box of opts.segmentBoxes || []) {
    if (box?.sw && box?.ne) corners.push(...boxToRing(box));
  }
  if (corners.length >= 3) {
    const hull = convexHull(corners);
    if (hull.length >= 3) return hull;
  }
  if (opts.buildingBox?.sw && opts.buildingBox?.ne) {
    return boxToRing(opts.buildingBox);
  }
  return [];
}

export function haversineFeet(a: LatLngPoint, b: LatLngPoint): number {
  const R = 20902231;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function ringCentroid(points: LatLngPoint[]): LatLngPoint | null {
  if (!points.length) return null;
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
    lng: points.reduce((s, p) => s + p.lng, 0) / points.length,
  };
}
