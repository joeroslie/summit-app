/** Roof footprint geometry helpers for satellite tracing (lat/lng → feet / squares). */

export type LatLngPoint = { lat: number; lng: number };

export type RoofType =
  | 'pitched-shingles'
  | 'flat-modified-bitumen'
  | 'mixed';

/** Optional second pitch zone as fraction of footprint (multi-pitch). */
export type MultiPitchConfig = {
  /** Primary pitch string e.g. 6/12 */
  primaryPitch: string;
  /** Secondary pitch (hip/dormer/low-slope wing) */
  secondaryPitch?: string;
  /** Fraction of footprint at secondary pitch (0–1). Rest is primary. */
  secondaryFraction?: number;
};

/** Manual overrides — applied after auto calc; empty keys ignored. */
export type MetricOverrides = {
  footprintSqFt?: number | null;
  surfaceSqFt?: number | null;
  /** Pitched squares (report total) or section squares when on a section */
  squares?: number | null;
  /** Flat squares (report total); on flat sections also maps from squares */
  flatSquares?: number | null;
  perimeterLF?: number | null;
  ridgeLF?: number | null;
  hipLF?: number | null;
  eaveLF?: number | null;
  rakeLF?: number | null;
  valleyLF?: number | null;
};

/** One traced (or manual) roof plane within a multi-section report. */
export type RoofSectionKind = 'pitched' | 'flat';

export type RoofSection = {
  id: string;
  label: string;
  kind: RoofSectionKind;
  points: LatLngPoint[];
  pitch: string;
  pitchAuto?: boolean;
  waste: number;
  wasteAuto?: boolean;
  footprintSqFt: number;
  surfaceSqFt: number;
  /** Squares for this section only (pitched or flat depending on kind) */
  squares: number;
  perimeterLF: number;
  edgeLengthsLF: number[];
  ridgeLF: number;
  hipLF: number;
  eaveLF: number;
  rakeLF: number;
  valleyLF: number;
  overrides?: MetricOverrides;
};

export type RoofMeasurement = {
  id: string;
  createdAt: string;
  label: string;
  points: LatLngPoint[];
  roofType: RoofType;
  pitch: string;
  /** True when pitch was auto-estimated from the footprint polygon */
  pitchAuto?: boolean;
  /** Secondary pitch for multi-pitch roofs */
  secondaryPitch?: string;
  /** Fraction of footprint on secondary pitch */
  secondaryFraction?: number;
  waste: number; // fraction e.g. 0.1 = 10%
  wasteAuto?: boolean;
  footprintSqFt: number;
  surfaceSqFt: number;
  /** Pitched shingle squares (sum of pitched sections) */
  squares: number;
  /** Flat / modified bitumen squares (sum of flat sections) */
  flatSquares: number;
  /** For mixed roofs: fraction of footprint that is pitched (rest flat) */
  pitchedFraction?: number;
  perimeterLF: number;
  edgeLengthsLF: number[];
  ridgeLF: number;
  hipLF: number;
  eaveLF: number;
  rakeLF: number;
  valleyLF?: number;
  center?: LatLngPoint;
  /** Which fields were manually overridden (report totals) */
  overrides?: MetricOverrides;
  /** Multi-section report: pitched + flat (and more) planes */
  sections?: RoofSection[];
  /**
   * Where squares/pitch came from. Edge lengths are only safe for materials
   * when edgesVerified is true (manual entry or paid certified report).
   */
  measureSource?:
    | 'trace'
    | 'manual'
    | 'google_solar'
    | 'osm_footprint'
    | 'hybrid'
    | 'instant_roofer'
    | 'eagleview'
    | 'roofr';
  /** True only when ridge/hip/eave/rake/valley were measured or entered — not guessed. */
  edgesVerified?: boolean;
  /** EagleView drip edge (eaves + rakes) when available */
  dripEdgeLF?: number;
};

export const PITCH_MULTIPLIERS: Record<string, number> = {
  Flat: 1.0,
  '1/12': 1.003,
  '2/12': 1.014,
  '3/12': 1.031,
  '4/12': 1.054,
  '5/12': 1.083,
  '6/12': 1.118,
  '7/12': 1.158,
  '8/12': 1.202,
  '9/12': 1.25,
  '10/12': 1.302,
  '11/12': 1.357,
  '12/12': 1.414,
};

const EARTH_RADIUS_FT = 20902231;

function toRad(deg: number) {
  return (deg * Math.PI) / 180;
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function numOr(v: number | null | undefined, fallback: number) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return fallback;
  return Number(v);
}

/** Great-circle distance in feet. */
export function haversineFeet(a: LatLngPoint, b: LatLngPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_FT * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Plan area (sq ft) via equirectangular projection + shoelace. */
export function polygonAreaSqFt(points: LatLngPoint[]): number {
  if (points.length < 3) return 0;
  const lat0 = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lng0 = points.reduce((s, p) => s + p.lng, 0) / points.length;
  const cosLat = Math.cos(toRad(lat0));
  const ftPerDegLat = (Math.PI / 180) * EARTH_RADIUS_FT;
  const ftPerDegLng = ftPerDegLat * cosLat;

  const xy = points.map((p) => ({
    x: (p.lng - lng0) * ftPerDegLng,
    y: (p.lat - lat0) * ftPerDegLat,
  }));

  let area = 0;
  for (let i = 0; i < xy.length; i++) {
    const j = (i + 1) % xy.length;
    area += xy[i].x * xy[j].y - xy[j].x * xy[i].y;
  }
  return Math.abs(area) / 2;
}

export function edgeLengthsFeet(points: LatLngPoint[]): number[] {
  if (points.length < 2) return [];
  const lengths: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    // Open chain: don't close until 3+ points for perimeter metrics
    if (i === points.length - 1 && points.length < 3) break;
    lengths.push(haversineFeet(a, b));
  }
  // Closed polygon perimeter
  if (points.length >= 3) {
    const closed: number[] = [];
    for (let i = 0; i < points.length; i++) {
      closed.push(haversineFeet(points[i], points[(i + 1) % points.length]));
    }
    return closed;
  }
  return lengths;
}

function footprintBBox(points: LatLngPoint[]): { width: number; height: number } {
  if (points.length === 0) return { width: 0, height: 0 };
  const lat0 = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lng0 = points.reduce((s, p) => s + p.lng, 0) / points.length;
  const cosLat = Math.cos(toRad(lat0));
  const ftPerDegLat = (Math.PI / 180) * EARTH_RADIUS_FT;
  const ftPerDegLng = ftPerDegLat * cosLat;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    const x = (p.lng - lng0) * ftPerDegLng;
    const y = (p.lat - lat0) * ftPerDegLat;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) };
}

/**
 * Estimate roof pitch from 2D footprint "slope character":
 * - Compact footprints (near-square) → steeper typical residential
 * - Elongated ranch shapes → lower pitch
 * - High edge-length variance (hips/valleys) → mid pitch
 * Flat roof type always returns Flat.
 */
export function estimatePitchFromPolygon(
  points: LatLngPoint[],
  roofType: RoofType
): string {
  if (roofType === 'flat-modified-bitumen') return 'Flat';
  if (points.length < 3) return '6/12';

  const { width, height } = footprintBBox(points);
  const longSide = Math.max(width, height, 1);
  const shortSide = Math.min(width, height, 1);
  const aspect = longSide / shortSide;

  const area = polygonAreaSqFt(points);
  const edges = edgeLengthsFeet(points);
  const perimeter = edges.reduce((s, n) => s + n, 0) || 1;
  const compactness = (4 * Math.PI * area) / (perimeter * perimeter);

  const mean = perimeter / edges.length;
  const variance =
    edges.reduce((s, e) => s + (e - mean) ** 2, 0) / Math.max(edges.length, 1);
  const cv = Math.sqrt(variance) / mean;

  if (aspect >= 2.2 || compactness < 0.35) return '4/12';
  if (aspect >= 1.6 || compactness < 0.5) return '5/12';
  if (cv > 0.45) return '6/12';
  if (compactness > 0.7 && aspect < 1.25) return '7/12';
  return '6/12';
}

/**
 * Suggest waste fraction from footprint complexity (field default).
 * More vertices / irregular edges → higher waste.
 */
export function estimateWasteFromPolygon(
  points: LatLngPoint[],
  roofType: RoofType
): number {
  if (roofType === 'flat-modified-bitumen') return 0.05;
  if (points.length < 3) return 0.1;

  const n = points.length;
  const edges = edgeLengthsFeet(points);
  const mean = edges.reduce((s, e) => s + e, 0) / Math.max(edges.length, 1);
  const cv =
    Math.sqrt(
      edges.reduce((s, e) => s + (e - mean) ** 2, 0) / Math.max(edges.length, 1)
    ) / (mean || 1);

  // Base 8%; hips/complex + vertices bump waste
  let waste = 0.08;
  if (n >= 8) waste += 0.02;
  if (n >= 12) waste += 0.03;
  if (cv > 0.35) waste += 0.02;
  if (cv > 0.55) waste += 0.03;
  if (roofType === 'mixed') waste += 0.02;
  return Math.min(0.2, Math.round(waste * 100) / 100);
}

/** Surface multiplier for multi-pitch footprint split. */
export function multiPitchMultiplier(cfg: MultiPitchConfig): number {
  const primary = PITCH_MULTIPLIERS[cfg.primaryPitch] || 1.118;
  const secPitch = cfg.secondaryPitch;
  const frac = Math.max(0, Math.min(1, cfg.secondaryFraction ?? 0));
  if (!secPitch || frac <= 0) return primary;
  const secondary = PITCH_MULTIPLIERS[secPitch] || primary;
  return primary * (1 - frac) + secondary * frac;
}

export type RoofMetricsResult = {
  footprintSqFt: number;
  surfaceSqFt: number;
  squares: number;
  flatSquares: number;
  perimeterLF: number;
  edgeLengthsLF: number[];
  ridgeLF: number;
  hipLF: number;
  eaveLF: number;
  rakeLF: number;
  valleyLF: number;
  pitch: string;
  pitchAuto: boolean;
  secondaryPitch?: string;
  secondaryFraction?: number;
  pitchedFraction?: number;
  waste: number;
  wasteAuto: boolean;
  roofType: RoofType;
};

/**
 * Linear feet from a 2D outline only.
 *
 * Perimeter is real. Ridge / hip / rake / valley cannot be known from a
 * footprint alone — inventing them inflated ridge vent / drip edge. Leave
 * those at 0 unless the user (or a certified report) supplies overrides.
 * Flat roofs: treat the full outline as eave/parapet.
 */
function classifyLinearFeet(
  points: LatLngPoint[],
  roofType: RoofType
): {
  ridgeLF: number;
  hipLF: number;
  eaveLF: number;
  rakeLF: number;
  valleyLF: number;
} {
  const edges = edgeLengthsFeet(points);
  if (edges.length === 0) {
    return { ridgeLF: 0, hipLF: 0, eaveLF: 0, rakeLF: 0, valleyLF: 0 };
  }

  const perimeter = edges.reduce((s, n) => s + n, 0);

  if (roofType === 'flat-modified-bitumen') {
    return {
      ridgeLF: 0,
      hipLF: 0,
      eaveLF: round1(perimeter),
      rakeLF: 0,
      valleyLF: 0,
    };
  }

  return {
    ridgeLF: 0,
    hipLF: 0,
    eaveLF: 0,
    rakeLF: 0,
    valleyLF: 0,
  };
}

export function computeRoofMetrics(
  points: LatLngPoint[],
  opts: {
    pitch: string;
    waste: number;
    roofType: RoofType;
    autoPitch?: boolean;
    autoWaste?: boolean;
    secondaryPitch?: string;
    secondaryFraction?: number;
    /** For mixed roofs: fraction of footprint that is pitched (default 0.75) */
    pitchedFraction?: number;
    overrides?: MetricOverrides;
  }
): RoofMetricsResult {
  const roofType = opts.roofType || 'pitched-shingles';
  let pitch = opts.pitch || '6/12';
  let pitchAuto = false;
  let wasteAuto = false;
  let waste = Math.max(0, opts.waste ?? 0.1);

  if (roofType === 'flat-modified-bitumen') {
    pitch = 'Flat';
    pitchAuto = true;
  } else if (opts.autoPitch && points.length >= 3) {
    pitch = estimatePitchFromPolygon(points, roofType);
    pitchAuto = true;
  }

  if (opts.autoWaste && points.length >= 3) {
    waste = estimateWasteFromPolygon(points, roofType);
    wasteAuto = true;
  }

  const secondaryPitch =
    roofType === 'flat-modified-bitumen'
      ? undefined
      : opts.secondaryPitch || undefined;
  const secondaryFraction =
    secondaryPitch != null
      ? Math.max(0, Math.min(1, opts.secondaryFraction ?? 0.25))
      : 0;

  // Pitched share of footprint (0 = all flat, 1 = all pitched). Prefer explicit % from UI.
  let pitchedFraction: number;
  if (opts.pitchedFraction != null && Number.isFinite(opts.pitchedFraction)) {
    pitchedFraction = Math.max(0, Math.min(1, opts.pitchedFraction));
  } else if (roofType === 'flat-modified-bitumen') {
    pitchedFraction = 0;
  } else if (roofType === 'mixed') {
    pitchedFraction = 0.75;
  } else {
    pitchedFraction = 1;
  }

  // Normalize type from percentage so calcs stay consistent
  const effectiveType: RoofType =
    pitchedFraction <= 0.01
      ? 'flat-modified-bitumen'
      : pitchedFraction >= 0.99
        ? 'pitched-shingles'
        : 'mixed';

  if (effectiveType === 'flat-modified-bitumen') {
    pitch = 'Flat';
    pitchAuto = true;
  }

  const edgeLengthsLF = edgeLengthsFeet(points).map((n) => round1(n));
  const perimeterLF = round1(edgeLengthsLF.reduce((s, n) => s + n, 0));
  let footprintSqFt = Math.round(polygonAreaSqFt(points));

  const pitchMult =
    pitch === 'Flat' || effectiveType === 'flat-modified-bitumen'
      ? 1.0
      : multiPitchMultiplier({
          primaryPitch: pitch,
          secondaryPitch,
          secondaryFraction,
        });

  let surfaceSqFt = 0;
  let squares = 0;
  let flatSquares = 0;

  // Always split by pitched % — flat and pitched squares stay separate
  const pitchedFp = footprintSqFt * pitchedFraction;
  const flatFp = footprintSqFt * (1 - pitchedFraction);
  const flatWaste = Math.min(waste, 0.08);
  const pitchedSurface =
    effectiveType === 'flat-modified-bitumen' ? 0 : pitchedFp * pitchMult;
  const flatSurface = flatFp; // plan area only
  surfaceSqFt = Math.round(pitchedSurface + flatSurface);
  squares =
    pitchedFp > 0 ? round2((pitchedSurface / 100) * (1 + waste)) : 0;
  flatSquares =
    flatFp > 0 ? round2((flatSurface / 100) * (1 + flatWaste)) : 0;

  const linear = classifyLinearFeet(points, effectiveType);
  let ridgeLF = linear.ridgeLF;
  let hipLF = linear.hipLF;
  let eaveLF = linear.eaveLF;
  let rakeLF = linear.rakeLF;
  let valleyLF = linear.valleyLF;

  // Apply overrides (field adjustments)
  const ov = opts.overrides || {};
  footprintSqFt = Math.round(numOr(ov.footprintSqFt, footprintSqFt));
  surfaceSqFt = Math.round(numOr(ov.surfaceSqFt, surfaceSqFt));
  squares = round2(numOr(ov.squares, squares));
  flatSquares = round2(numOr(ov.flatSquares, flatSquares));
  const perimeterOut = round1(numOr(ov.perimeterLF, perimeterLF));
  ridgeLF = round1(numOr(ov.ridgeLF, ridgeLF));
  hipLF = round1(numOr(ov.hipLF, hipLF));
  eaveLF = round1(numOr(ov.eaveLF, eaveLF));
  rakeLF = round1(numOr(ov.rakeLF, rakeLF));
  valleyLF = round1(numOr(ov.valleyLF, valleyLF));

  // If footprint overridden but surface/squares not, recompute from % split
  if (
    ov.footprintSqFt != null &&
    Number.isFinite(Number(ov.footprintSqFt)) &&
    ov.surfaceSqFt == null &&
    ov.squares == null &&
    ov.flatSquares == null
  ) {
    const fp = footprintSqFt;
    const pFp = fp * pitchedFraction;
    const fFp = fp * (1 - pitchedFraction);
    const pSurf =
      effectiveType === 'flat-modified-bitumen' ? 0 : pFp * pitchMult;
    surfaceSqFt = Math.round(pSurf + fFp);
    squares = pFp > 0 ? round2((pSurf / 100) * (1 + waste)) : 0;
    flatSquares =
      fFp > 0 ? round2((fFp / 100) * (1 + Math.min(waste, 0.08))) : 0;
  }

  return {
    footprintSqFt,
    surfaceSqFt,
    squares,
    flatSquares,
    perimeterLF: perimeterOut,
    edgeLengthsLF,
    ridgeLF,
    hipLF,
    eaveLF,
    rakeLF,
    valleyLF,
    pitch,
    pitchAuto,
    secondaryPitch,
    secondaryFraction: secondaryFraction || undefined,
    pitchedFraction,
    waste,
    wasteAuto,
    roofType: effectiveType,
  };
}

export function buildRoofMeasurement(
  points: LatLngPoint[],
  opts: {
    pitch: string;
    waste: number;
    roofType: RoofType;
    autoPitch?: boolean;
    autoWaste?: boolean;
    secondaryPitch?: string;
    secondaryFraction?: number;
    pitchedFraction?: number;
    overrides?: MetricOverrides;
    label?: string;
  }
): RoofMeasurement {
  const metrics = computeRoofMetrics(points, opts);
  const center =
    points.length > 0
      ? {
          lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
          lng: points.reduce((s, p) => s + p.lng, 0) / points.length,
        }
      : undefined;

  return {
    id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toLocaleString(),
    label: opts.label || `Roof ${new Date().toLocaleDateString()}`,
    points,
    center,
    waste: metrics.waste,
    wasteAuto: metrics.wasteAuto,
    roofType: metrics.roofType,
    pitch: metrics.pitch,
    pitchAuto: metrics.pitchAuto,
    secondaryPitch: metrics.secondaryPitch,
    secondaryFraction: metrics.secondaryFraction,
    pitchedFraction: metrics.pitchedFraction ?? 1,
    footprintSqFt: metrics.footprintSqFt,
    surfaceSqFt: metrics.surfaceSqFt,
    squares: metrics.squares,
    flatSquares: metrics.flatSquares,
    perimeterLF: metrics.perimeterLF,
    edgeLengthsLF: metrics.edgeLengthsLF,
    ridgeLF: metrics.ridgeLF,
    hipLF: metrics.hipLF,
    eaveLF: metrics.eaveLF,
    rakeLF: metrics.rakeLF,
    valleyLF: metrics.valleyLF,
    overrides: opts.overrides,
  };
}

export function buildManualRoofMeasurement(opts: {
  squares?: number;
  flatSquares?: number;
  footprintSqFt?: number;
  pitch: string;
  waste: number;
  roofType: RoofType;
  label?: string;
  ridgeLF?: number;
  hipLF?: number;
  eaveLF?: number;
  rakeLF?: number;
  valleyLF?: number;
  secondaryPitch?: string;
  secondaryFraction?: number;
  pitchedFraction?: number;
  center?: LatLngPoint;
  overrides?: MetricOverrides;
}): RoofMeasurement {
  const roofType = opts.roofType || 'pitched-shingles';
  const pitch =
    roofType === 'flat-modified-bitumen' ? 'Flat' : opts.pitch || '6/12';
  const pitchMult = multiPitchMultiplier({
    primaryPitch: pitch,
    secondaryPitch: opts.secondaryPitch,
    secondaryFraction: opts.secondaryFraction,
  });
  const waste = Math.max(0, opts.waste);
  const pitchedFraction =
    roofType === 'mixed'
      ? Math.max(0.05, Math.min(0.95, opts.pitchedFraction ?? 0.75))
      : roofType === 'flat-modified-bitumen'
        ? 0
        : 1;

  let footprintSqFt = Math.max(0, Math.round(opts.footprintSqFt || 0));
  let squares = Math.max(0, Number(opts.squares) || 0);
  let flatSquares = Math.max(0, Number(opts.flatSquares) || 0);

  if (roofType === 'flat-modified-bitumen') {
    if (flatSquares > 0 && footprintSqFt <= 0) {
      footprintSqFt = Math.round((flatSquares * 100) / (1 + waste));
    }
    if (footprintSqFt > 0 && flatSquares <= 0) {
      flatSquares = round2((footprintSqFt / 100) * (1 + waste));
    }
    squares = 0;
  } else if (roofType === 'mixed') {
    if (footprintSqFt > 0 && squares <= 0 && flatSquares <= 0) {
      const pitchedFp = footprintSqFt * pitchedFraction;
      const flatFp = footprintSqFt * (1 - pitchedFraction);
      squares = round2((pitchedFp * pitchMult * (1 + waste)) / 100);
      flatSquares = round2((flatFp / 100) * (1 + Math.min(waste, 0.08)));
    } else if ((squares > 0 || flatSquares > 0) && footprintSqFt <= 0) {
      const pitchedFp =
        squares > 0 ? (squares * 100) / (pitchMult * (1 + waste)) : 0;
      const flatFp =
        flatSquares > 0 ? (flatSquares * 100) / (1 + Math.min(waste, 0.08)) : 0;
      footprintSqFt = Math.round(pitchedFp + flatFp);
    }
  } else {
    if (squares > 0 && footprintSqFt <= 0) {
      footprintSqFt = Math.round((squares * 100) / (pitchMult * (1 + waste)));
    }
    if (footprintSqFt > 0 && squares <= 0) {
      squares = round2((footprintSqFt * pitchMult * (1 + waste)) / 100);
    }
    flatSquares = Math.max(0, flatSquares); // allow optional flat add-on even on pitched
  }

  const surfaceSqFt =
    roofType === 'flat-modified-bitumen'
      ? footprintSqFt
      : Math.round(
          footprintSqFt *
            (roofType === 'mixed'
              ? pitchedFraction * pitchMult + (1 - pitchedFraction)
              : pitchMult)
        );
  const side = Math.sqrt(Math.max(footprintSqFt, 1));
  const perimeterLF = round1(side * 4);

  const ov = opts.overrides || {};
  // Only use explicit edge lengths — never invent ridge/hip/rake from area
  const ridgeLF = round1(numOr(ov.ridgeLF, opts.ridgeLF ?? 0));
  const hipLF = round1(numOr(ov.hipLF, opts.hipLF ?? 0));
  const eaveLF = round1(
    numOr(
      ov.eaveLF,
      opts.eaveLF ??
        (roofType === 'flat-modified-bitumen' ? perimeterLF : 0)
    )
  );
  const rakeLF = round1(numOr(ov.rakeLF, opts.rakeLF ?? 0));
  const valleyLF = round1(numOr(ov.valleyLF, opts.valleyLF ?? 0));
  const edgesVerified =
    ridgeLF > 0 || hipLF > 0 || rakeLF > 0 || valleyLF > 0 ||
    (roofType !== 'flat-modified-bitumen' && eaveLF > 0);

  return {
    id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toLocaleString(),
    label: opts.label || `Manual roof ${new Date().toLocaleDateString()}`,
    points: [],
    roofType,
    pitch,
    pitchAuto: roofType === 'flat-modified-bitumen',
    secondaryPitch: opts.secondaryPitch,
    secondaryFraction: opts.secondaryFraction,
    pitchedFraction: roofType === 'mixed' ? pitchedFraction : undefined,
    waste,
    center: opts.center,
    footprintSqFt: Math.round(numOr(ov.footprintSqFt, footprintSqFt)),
    surfaceSqFt: Math.round(numOr(ov.surfaceSqFt, surfaceSqFt)),
    squares: round2(numOr(ov.squares, squares)),
    flatSquares: round2(numOr(ov.flatSquares, flatSquares)),
    perimeterLF: round1(numOr(ov.perimeterLF, perimeterLF)),
    edgeLengthsLF: [],
    ridgeLF,
    hipLF,
    eaveLF,
    rakeLF,
    valleyLF,
    measureSource: 'manual',
    edgesVerified,
    overrides: opts.overrides,
  };
}

export function polygonToSvgPath(
  points: LatLngPoint[],
  size = 280,
  pad = 16
): { path: string; viewBox: string } {
  if (points.length < 2) {
    return { path: '', viewBox: `0 0 ${size} ${size}` };
  }
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const dLat = maxLat - minLat || 0.0001;
  const dLng = maxLng - minLng || 0.0001;
  const scale = (size - pad * 2) / Math.max(dLat, dLng);

  const coords = points.map((p) => {
    const x = pad + (p.lng - minLng) * scale;
    const y = pad + (maxLat - p.lat) * scale;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return {
    path: `M ${coords.join(' L ')} Z`,
    viewBox: `0 0 ${size} ${size}`,
  };
}

/** Multi-section diagram — all polygons in one viewBox. */
export function multiSectionSvgPaths(
  sections: Array<{ points: LatLngPoint[]; kind?: RoofSectionKind }>,
  size = 280,
  pad = 16
): { paths: Array<{ d: string; kind: RoofSectionKind }>; viewBox: string } {
  const all = sections.flatMap((s) => s.points);
  if (all.length < 2) {
    return { paths: [], viewBox: `0 0 ${size} ${size}` };
  }
  const lats = all.map((p) => p.lat);
  const lngs = all.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const dLat = maxLat - minLat || 0.0001;
  const dLng = maxLng - minLng || 0.0001;
  const scale = (size - pad * 2) / Math.max(dLat, dLng);

  const paths = sections
    .filter((s) => s.points.length >= 2)
    .map((s) => {
      const coords = s.points.map((p) => {
        const x = pad + (p.lng - minLng) * scale;
        const y = pad + (maxLat - p.lat) * scale;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
      return {
        d: `M ${coords.join(' L ')} Z`,
        kind: s.kind || 'pitched',
      };
    });

  return { paths, viewBox: `0 0 ${size} ${size}` };
}

function newId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Build one pitched or flat section from a map outline.
 *  Kind is authoritative: flat → flatSquares pipeline, pitched → squares.
 *  Order of sections in a multi-section report does not matter.
 */
export function buildRoofSection(
  points: LatLngPoint[],
  opts: {
    kind: RoofSectionKind;
    label?: string;
    pitch?: string;
    waste?: number;
    autoPitch?: boolean;
    autoWaste?: boolean;
    overrides?: MetricOverrides;
  }
): RoofSection {
  // Kind is the single source of truth (never infer from pitch string alone)
  const kind: RoofSectionKind = opts.kind === 'flat' ? 'flat' : 'pitched';
  const roofType: RoofType =
    kind === 'flat' ? 'flat-modified-bitumen' : 'pitched-shingles';
  // Pitched sections must not inherit residual Flat pitch from a prior flat step
  const pitchForCalc =
    kind === 'flat'
      ? 'Flat'
      : opts.pitch && opts.pitch !== 'Flat'
        ? opts.pitch
        : '6/12';
  const metrics = computeRoofMetrics(points, {
    pitch: pitchForCalc,
    waste: opts.waste ?? (kind === 'flat' ? 0.05 : 0.1),
    roofType,
    autoPitch: kind === 'flat' ? false : !!opts.autoPitch,
    autoWaste: !!opts.autoWaste,
    pitchedFraction: kind === 'flat' ? 0 : 1,
    overrides:
      kind === 'flat'
        ? {
            ...opts.overrides,
            // Section.squares is the area for this plane; map into flatSquares for calc
            flatSquares:
              opts.overrides?.flatSquares ?? opts.overrides?.squares ?? null,
            // Never put flat area into pitched squares total
            squares: null,
          }
        : {
            ...opts.overrides,
            // Pitched plane: keep squares; do not bleed into flatSquares
            flatSquares: opts.overrides?.flatSquares ?? null,
          },
  });

  // Section.squares always holds this plane's area (kind decides which aggregate bucket)
  const sectionSquares =
    kind === 'flat'
      ? numOr(
          opts.overrides?.flatSquares ?? opts.overrides?.squares,
          metrics.flatSquares
        )
      : numOr(opts.overrides?.squares, metrics.squares);

  return {
    id: newId('sec'),
    label:
      opts.label ||
      (kind === 'flat' ? 'Flat section' : 'Pitched section'),
    kind,
    points: [...points],
    pitch: kind === 'flat' ? 'Flat' : metrics.pitch,
    pitchAuto: kind === 'flat' ? true : metrics.pitchAuto,
    waste: metrics.waste,
    wasteAuto: metrics.wasteAuto,
    footprintSqFt: metrics.footprintSqFt,
    surfaceSqFt: metrics.surfaceSqFt,
    squares: round2(sectionSquares),
    perimeterLF: metrics.perimeterLF,
    edgeLengthsLF: metrics.edgeLengthsLF,
    ridgeLF: kind === 'flat' ? 0 : metrics.ridgeLF,
    hipLF: kind === 'flat' ? 0 : metrics.hipLF,
    eaveLF: metrics.eaveLF,
    rakeLF: metrics.rakeLF,
    valleyLF: kind === 'flat' ? 0 : metrics.valleyLF,
    overrides: opts.overrides,
  };
}

/** Manual section (no map outline). */
export function buildManualRoofSection(opts: {
  kind: RoofSectionKind;
  label?: string;
  squares?: number;
  footprintSqFt?: number;
  pitch?: string;
  waste?: number;
  overrides?: MetricOverrides;
}): RoofSection {
  const kind = opts.kind;
  const waste = Math.max(0, opts.waste ?? (kind === 'flat' ? 0.05 : 0.1));
  const pitch = kind === 'flat' ? 'Flat' : opts.pitch || '6/12';
  const pitchMult = PITCH_MULTIPLIERS[pitch] || 1.118;
  const ov = opts.overrides || {};

  let footprintSqFt = Math.max(0, Math.round(opts.footprintSqFt || 0));
  let squares = Math.max(0, Number(opts.squares) || 0);

  if (squares > 0 && footprintSqFt <= 0) {
    footprintSqFt =
      kind === 'flat'
        ? Math.round((squares * 100) / (1 + waste))
        : Math.round((squares * 100) / (pitchMult * (1 + waste)));
  }
  if (footprintSqFt > 0 && squares <= 0) {
    squares =
      kind === 'flat'
        ? round2((footprintSqFt / 100) * (1 + waste))
        : round2((footprintSqFt * pitchMult * (1 + waste)) / 100);
  }

  squares = round2(numOr(ov.squares, squares));
  footprintSqFt = Math.round(numOr(ov.footprintSqFt, footprintSqFt));
  const surfaceSqFt = Math.round(
    numOr(
      ov.surfaceSqFt,
      kind === 'flat' ? footprintSqFt : footprintSqFt * pitchMult
    )
  );
  const side = Math.sqrt(Math.max(footprintSqFt, 1));

  return {
    id: newId('sec'),
    label: opts.label || (kind === 'flat' ? 'Flat section' : 'Pitched section'),
    kind,
    points: [],
    pitch,
    pitchAuto: kind === 'flat',
    waste,
    footprintSqFt,
    surfaceSqFt,
    squares,
    perimeterLF: round1(numOr(ov.perimeterLF, side * 4)),
    edgeLengthsLF: [],
    ridgeLF: round1(
      numOr(ov.ridgeLF, kind === 'flat' ? 0 : side * 0.55)
    ),
    hipLF: round1(numOr(ov.hipLF, kind === 'flat' ? 0 : side * 0.4)),
    eaveLF: round1(numOr(ov.eaveLF, side * 2)),
    rakeLF: round1(numOr(ov.rakeLF, side * 2)),
    valleyLF: round1(numOr(ov.valleyLF, 0)),
    overrides: opts.overrides,
  };
}

/** Re-apply overrides onto an existing section (field edits). */
export function applySectionOverrides(
  section: RoofSection,
  overrides?: MetricOverrides
): RoofSection {
  if (!overrides) return section;
  const next = { ...section, overrides };
  if (overrides.footprintSqFt != null)
    next.footprintSqFt = Math.round(Number(overrides.footprintSqFt));
  if (overrides.surfaceSqFt != null)
    next.surfaceSqFt = Math.round(Number(overrides.surfaceSqFt));
  if (overrides.squares != null)
    next.squares = round2(Number(overrides.squares));
  if (overrides.perimeterLF != null)
    next.perimeterLF = round1(Number(overrides.perimeterLF));
  if (overrides.ridgeLF != null) next.ridgeLF = round1(Number(overrides.ridgeLF));
  if (overrides.hipLF != null) next.hipLF = round1(Number(overrides.hipLF));
  if (overrides.eaveLF != null) next.eaveLF = round1(Number(overrides.eaveLF));
  if (overrides.rakeLF != null) next.rakeLF = round1(Number(overrides.rakeLF));
  if (overrides.valleyLF != null)
    next.valleyLF = round1(Number(overrides.valleyLF));
  return next;
}

/**
 * Combine sections into one report: separate pitched/flat squares + totals.
 * Total-level overrides adjust the aggregate numbers.
 */
export function aggregateSectionsToMeasurement(
  sections: RoofSection[],
  opts?: {
    label?: string;
    center?: LatLngPoint;
    totalOverrides?: MetricOverrides;
    measureSource?: RoofMeasurement['measureSource'];
    edgesVerified?: boolean;
  }
): RoofMeasurement {
  const secs = sections.map((s) => applySectionOverrides(s, s.overrides));
  let pitchedSquares = 0;
  let flatSquares = 0;
  let footprintSqFt = 0;
  let surfaceSqFt = 0;
  let perimeterLF = 0;
  let ridgeLF = 0;
  let hipLF = 0;
  let eaveLF = 0;
  let rakeLF = 0;
  let valleyLF = 0;
  const allPoints: LatLngPoint[] = [];
  let wasteSum = 0;
  let primaryPitch = '6/12';

  // Sum by kind only — section order (flat-first or pitched-first) is irrelevant
  for (const s of secs) {
    if (s.kind === 'flat') flatSquares += s.squares;
    else {
      pitchedSquares += s.squares;
      if (s.pitch && s.pitch !== 'Flat') primaryPitch = s.pitch;
    }
    footprintSqFt += s.footprintSqFt;
    surfaceSqFt += s.surfaceSqFt;
    perimeterLF += s.perimeterLF;
    ridgeLF += s.ridgeLF;
    hipLF += s.hipLF;
    eaveLF += s.eaveLF;
    rakeLF += s.rakeLF;
    valleyLF += s.valleyLF;
    wasteSum += s.waste;
    allPoints.push(...s.points);
  }

  pitchedSquares = round2(pitchedSquares);
  flatSquares = round2(flatSquares);
  footprintSqFt = Math.round(footprintSqFt);
  surfaceSqFt = Math.round(surfaceSqFt);
  perimeterLF = round1(perimeterLF);
  ridgeLF = round1(ridgeLF);
  hipLF = round1(hipLF);
  eaveLF = round1(eaveLF);
  rakeLF = round1(rakeLF);
  valleyLF = round1(valleyLF);

  const hasPitched = secs.some((s) => s.kind === 'pitched');
  const hasFlat = secs.some((s) => s.kind === 'flat');
  const roofType: RoofType =
    hasPitched && hasFlat
      ? 'mixed'
      : hasFlat
        ? 'flat-modified-bitumen'
        : 'pitched-shingles';
  const pitch = roofType === 'flat-modified-bitumen' ? 'Flat' : primaryPitch;
  const waste = secs.length ? wasteSum / secs.length : 0.1;
  const pitchedFraction =
    footprintSqFt > 0
      ? secs
          .filter((s) => s.kind === 'pitched')
          .reduce((a, s) => a + s.footprintSqFt, 0) / footprintSqFt
      : hasPitched
        ? 1
        : 0;

  const center =
    opts?.center ||
    (allPoints.length
      ? {
          lat: allPoints.reduce((s, p) => s + p.lat, 0) / allPoints.length,
          lng: allPoints.reduce((s, p) => s + p.lng, 0) / allPoints.length,
        }
      : undefined);

  const ov = opts?.totalOverrides || {};
  footprintSqFt = Math.round(numOr(ov.footprintSqFt, footprintSqFt));
  surfaceSqFt = Math.round(numOr(ov.surfaceSqFt, surfaceSqFt));
  pitchedSquares = round2(numOr(ov.squares, pitchedSquares));
  flatSquares = round2(numOr(ov.flatSquares, flatSquares));
  perimeterLF = round1(numOr(ov.perimeterLF, perimeterLF));
  ridgeLF = round1(numOr(ov.ridgeLF, ridgeLF));
  hipLF = round1(numOr(ov.hipLF, hipLF));
  eaveLF = round1(numOr(ov.eaveLF, eaveLF));
  rakeLF = round1(numOr(ov.rakeLF, rakeLF));
  valleyLF = round1(numOr(ov.valleyLF, valleyLF));

  return {
    id: newId('m'),
    createdAt: new Date().toLocaleString(),
    label: opts?.label || `Roof ${new Date().toLocaleDateString()}`,
    points: allPoints,
    sections: secs,
    center,
    waste: round2(waste),
    roofType,
    pitch,
    pitchAuto: secs.every((s) => s.pitchAuto),
    pitchedFraction: round2(pitchedFraction),
    measureSource: opts?.measureSource || 'trace',
    edgesVerified: opts?.edgesVerified === true,
    footprintSqFt,
    surfaceSqFt,
    squares: pitchedSquares,
    flatSquares,
    perimeterLF,
    edgeLengthsLF: [],
    ridgeLF,
    hipLF,
    eaveLF,
    rakeLF,
    valleyLF,
    overrides: opts?.totalOverrides,
  };
}

function normalizeSection(raw: Partial<RoofSection>): RoofSection | null {
  if (!raw) return null;
  const kind: RoofSectionKind = raw.kind === 'flat' ? 'flat' : 'pitched';
  const points = Array.isArray(raw.points)
    ? raw.points
        .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    : [];
  const waste = typeof raw.waste === 'number' ? raw.waste : kind === 'flat' ? 0.05 : 0.1;
  const pitch = kind === 'flat' ? 'Flat' : raw.pitch || '6/12';

  if (points.length >= 3) {
    return buildRoofSection(points, {
      kind,
      label: raw.label,
      pitch,
      waste,
      autoPitch: false,
      autoWaste: false,
      overrides: {
        footprintSqFt: raw.footprintSqFt,
        surfaceSqFt: raw.surfaceSqFt,
        squares: raw.squares,
        perimeterLF: raw.perimeterLF,
        ridgeLF: raw.ridgeLF,
        hipLF: raw.hipLF,
        eaveLF: raw.eaveLF,
        rakeLF: raw.rakeLF,
        valleyLF: raw.valleyLF,
        ...raw.overrides,
      },
    });
  }

  if ((Number(raw.squares) || 0) <= 0 && (Number(raw.footprintSqFt) || 0) <= 0)
    return null;

  return buildManualRoofSection({
    kind,
    label: raw.label,
    squares: Number(raw.squares) || 0,
    footprintSqFt: Number(raw.footprintSqFt) || 0,
    pitch,
    waste,
    overrides: raw.overrides,
  });
}

export function normalizeMeasurement(
  raw: Partial<RoofMeasurement>
): RoofMeasurement | null {
  if (!raw) return null;

  // Prefer multi-section when present
  if (Array.isArray(raw.sections) && raw.sections.length > 0) {
    const sections = raw.sections
      .map((s) => normalizeSection(s as Partial<RoofSection>))
      .filter(Boolean) as RoofSection[];
    if (!sections.length) return null;
    const base = aggregateSectionsToMeasurement(sections, {
      label: raw.label,
      center: raw.center,
      totalOverrides: raw.overrides,
      measureSource: raw.measureSource,
      edgesVerified: raw.edgesVerified,
    });
    const trustEdges = raw.edgesVerified === true;
    return {
      ...base,
      id: raw.id || base.id,
      createdAt: raw.createdAt || base.createdAt,
      // Preserve stored totals if already saved (respect field overrides)
      squares: raw.squares ?? base.squares,
      flatSquares: raw.flatSquares ?? base.flatSquares,
      footprintSqFt: raw.footprintSqFt ?? base.footprintSqFt,
      surfaceSqFt: raw.surfaceSqFt ?? base.surfaceSqFt,
      perimeterLF: raw.perimeterLF ?? base.perimeterLF,
      ridgeLF: trustEdges ? (raw.ridgeLF ?? base.ridgeLF) : base.ridgeLF,
      hipLF: trustEdges ? (raw.hipLF ?? base.hipLF) : base.hipLF,
      eaveLF: trustEdges ? (raw.eaveLF ?? base.eaveLF) : base.eaveLF,
      rakeLF: trustEdges ? (raw.rakeLF ?? base.rakeLF) : base.rakeLF,
      valleyLF: trustEdges ? (raw.valleyLF ?? base.valleyLF) : base.valleyLF,
      measureSource: raw.measureSource ?? base.measureSource,
      edgesVerified: trustEdges,
      dripEdgeLF: raw.dripEdgeLF ?? base.dripEdgeLF,
    };
  }

  const roofType: RoofType =
    raw.roofType === 'flat-modified-bitumen'
      ? 'flat-modified-bitumen'
      : raw.roofType === 'mixed'
        ? 'mixed'
        : 'pitched-shingles';
  const waste = typeof raw.waste === 'number' ? raw.waste : 0.1;
  const pitch =
    roofType === 'flat-modified-bitumen' ? 'Flat' : raw.pitch || '6/12';
  const points = Array.isArray(raw.points)
    ? raw.points
        .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    : [];

  if (points.length >= 3) {
    const recomputed = computeRoofMetrics(points, {
      pitch,
      waste,
      roofType,
      autoPitch: false,
      secondaryPitch: raw.secondaryPitch,
      secondaryFraction: raw.secondaryFraction,
      pitchedFraction: raw.pitchedFraction,
      overrides: raw.overrides,
    });
    const trustEdges = raw.edgesVerified === true;
    return {
      id: raw.id || `m-${Date.now()}`,
      createdAt: raw.createdAt || new Date().toLocaleString(),
      label: raw.label || 'Roof measurement',
      points,
      roofType,
      pitch: raw.pitch || recomputed.pitch,
      pitchAuto: raw.pitchAuto,
      secondaryPitch: raw.secondaryPitch ?? recomputed.secondaryPitch,
      secondaryFraction: raw.secondaryFraction ?? recomputed.secondaryFraction,
      pitchedFraction: raw.pitchedFraction ?? recomputed.pitchedFraction,
      waste,
      wasteAuto: raw.wasteAuto,
      center: raw.center,
      footprintSqFt: raw.footprintSqFt ?? recomputed.footprintSqFt,
      surfaceSqFt: raw.surfaceSqFt ?? recomputed.surfaceSqFt,
      squares: raw.squares ?? recomputed.squares,
      flatSquares: raw.flatSquares ?? recomputed.flatSquares,
      perimeterLF: raw.perimeterLF ?? recomputed.perimeterLF,
      edgeLengthsLF: raw.edgeLengthsLF ?? recomputed.edgeLengthsLF,
      ridgeLF: trustEdges ? (raw.ridgeLF ?? recomputed.ridgeLF) : recomputed.ridgeLF,
      hipLF: trustEdges ? (raw.hipLF ?? recomputed.hipLF) : recomputed.hipLF,
      eaveLF: trustEdges
        ? (raw.eaveLF ?? recomputed.eaveLF)
        : recomputed.eaveLF,
      rakeLF: trustEdges ? (raw.rakeLF ?? recomputed.rakeLF) : recomputed.rakeLF,
      valleyLF: trustEdges
        ? (raw.valleyLF ?? recomputed.valleyLF)
        : recomputed.valleyLF,
      measureSource: raw.measureSource || 'trace',
      edgesVerified: trustEdges,
      dripEdgeLF: raw.dripEdgeLF,
      overrides: raw.overrides,
    };
  }

  const squares = Number(raw.squares) || 0;
  const flatSquares = Number(raw.flatSquares) || 0;
  const footprintSqFt = Number(raw.footprintSqFt) || 0;
  if (squares <= 0 && flatSquares <= 0 && footprintSqFt <= 0) return null;

  const manual = buildManualRoofMeasurement({
    squares,
    flatSquares,
    footprintSqFt,
    pitch,
    waste,
    roofType,
    label: raw.label,
    ridgeLF: raw.ridgeLF,
    hipLF: raw.hipLF,
    eaveLF: raw.eaveLF,
    rakeLF: raw.rakeLF,
    valleyLF: raw.valleyLF,
    secondaryPitch: raw.secondaryPitch,
    secondaryFraction: raw.secondaryFraction,
    pitchedFraction: raw.pitchedFraction,
    center: raw.center,
    overrides: raw.overrides,
  });
  return {
    ...manual,
    id: raw.id || manual.id,
    createdAt: raw.createdAt || manual.createdAt,
    dripEdgeLF: raw.dripEdgeLF ?? manual.dripEdgeLF,
    measureSource: raw.measureSource || manual.measureSource || 'manual',
    edgesVerified:
      raw.edgesVerified === true ||
      (raw.edgesVerified !== false && manual.edgesVerified === true),
  };
}
