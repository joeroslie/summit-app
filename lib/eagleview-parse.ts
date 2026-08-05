/**
 * Parse EagleView (and similar) roof report PDF text into structured measurements.
 * Prefers the "Lengths, Areas and Pitches" summary block when present.
 *
 * Important: EagleView "Total Area" is measured (no waste). Summit estimator
 * `squares` is material order quantity (includes waste) — same as manual trace.
 */

export type PitchAreaRow = {
  pitch: string;
  areaSqFt: number;
  pctOfRoof: number;
};

export type ParsedRoofReport = {
  provider: 'eagleview' | 'roofr' | 'unknown';
  /** Measured roof area from Total Area (All Pitches) — no waste */
  totalAreaSqFt: number | null;
  /** Measured squares (area / 100), no waste */
  measuredSquares: number | null;
  /**
   * Order squares for the estimate (includes suggested waste).
   * Prefer EV waste-table Suggested column; else measured × (1 + waste).
   */
  squares: number | null;
  /** Suggested waste fraction, e.g. 0.15 */
  waste: number | null;
  pitch: string | null;
  /** Second-largest pitch by area % (multi-pitch roofs) */
  secondaryPitch: string | null;
  /** Fraction of roof on secondary pitch (0–1) */
  secondaryFraction: number | null;
  /** All rows from Areas per Pitch when parsed */
  areasPerPitch: PitchAreaRow[];
  /** True when any pitch ≤3/12 has meaningful area (double underlayment) */
  hasLowSlope: boolean;
  /** Fraction of roof at ≤3/12 (0–1) */
  lowSlopeFraction: number | null;
  ridgeLF: number | null;
  hipLF: number | null;
  valleyLF: number | null;
  rakeLF: number | null;
  eaveLF: number | null;
  dripEdgeLF: number | null;
  facets: number | null;
  confidence: number;
  rawHits: string[];
};

function parseNum(s: string): number | null {
  const n = Number(String(s).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function firstMatch(
  text: string,
  patterns: RegExp[]
): { value: number; hit: string } | null {
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      const value = parseNum(m[1]);
      if (value != null) return { value, hit: m[0].replace(/\s+/g, ' ').trim() };
    }
  }
  return null;
}

function firstPitch(text: string): { value: string; hit: string } | null {
  const patterns = [
    /Predominant\s+Pitch\s*=\s*(\d+\s*\/\s*12)/i,
    /Predominant\s+Pitch\s*[:=]\s*(\d+\s*\/\s*12)/i,
    /Pitch\s*=\s*(\d+\s*\/\s*12)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) {
      const value = m[1].replace(/\s+/g, '');
      return { value, hit: m[0].replace(/\s+/g, ' ').trim() };
    }
  }
  return null;
}

function detectProvider(text: string): ParsedRoofReport['provider'] {
  if (/eagleview/i.test(text) || /Lengths,\s*Areas\s+and\s+Pitches/i.test(text)) {
    return 'eagleview';
  }
  if (/roofr/i.test(text)) return 'roofr';
  return 'unknown';
}

/**
 * Prefer the Lengths/Areas/Pitches block (most reliable), else whole document.
 */
function preferredScope(text: string): string {
  const idx = text.search(/Lengths,\s*Areas\s+and\s+Pitches/i);
  if (idx >= 0) {
    return text.slice(idx, idx + 2500);
  }
  return text;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function nearestWasteOption(fraction: number): number {
  const opts = [
    0, 0.05, 0.06, 0.07, 0.08, 0.09, 0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16,
    0.18, 0.2, 0.22, 0.23, 0.25, 0.28,
  ];
  let best = 0.15;
  let bestDist = Infinity;
  for (const o of opts) {
    const d = Math.abs(o - fraction);
    if (d < bestDist) {
      bestDist = d;
      best = o;
    }
  }
  return best;
}

function pitchRise(pitch: string): number | null {
  const m = String(pitch).match(/^(\d+)\s*\/\s*12$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse EagleView "Areas per Pitch" table.
 * Typical extracted text (labels may precede data rows):
 *   Areas per Pitch
 *   Roof Pitches / Area (sq ft) / % of Roof
 *   2/12 4/12 7/12 …
 *   268.1 391.6 1953.2 …
 *   8.5% 12.4% 61.6% …
 *
 * Bound the section before Waste Calculation so waste-table numbers
 * and the "3/12 pitch or greater" note never leak in.
 */
function parseAreasPerPitch(fullText: string): {
  rows: PitchAreaRow[];
  hits: string[];
} {
  const hits: string[] = [];
  const idx = fullText.search(/Areas\s+per\s+Pitch/i);
  if (idx < 0) return { rows: [], hits };

  let section = fullText.slice(idx, idx + 1200);
  const end = section.search(
    /(?:The\s+table\s+above\s+lists|Structure\s+Complexity|Waste\s+Calculation)/i
  );
  if (end > 40) section = section.slice(0, end);

  // Pitch row: consecutive X/12 tokens (not scattered note text)
  const pitchRow = section.match(/((?:\d{1,2}\s*\/\s*12\s*){2,})/);
  if (!pitchRow?.[1]) return { rows: [], hits };
  const pitches = [...pitchRow[1].matchAll(/(\d{1,2})\s*\/\s*12/g)].map(
    (m) => `${m[1]}/12`
  );
  const n = pitches.length;
  if (n < 2) return { rows: [], hits };

  const afterPitches = section.slice(
    (pitchRow.index ?? 0) + pitchRow[0].length
  );

  // Percent row (authoritative for fractions)
  let pcts = [...afterPitches.matchAll(/(\d{1,3}(?:\.\d+)?)%/g)]
    .map((m) => Number(m[1]))
    .filter((v) => Number.isFinite(v))
    .slice(0, n);

  // Area numbers between pitch row and first percent token
  const pctIdx = afterPitches.search(/\d+(?:\.\d+)?%/);
  const areaZone =
    pctIdx >= 0 ? afterPitches.slice(0, pctIdx) : afterPitches.slice(0, 240);
  let areas = [...areaZone.matchAll(/([\d,]+\.\d+|\d{1,5}(?:\.\d+)?)/g)]
    .map((m) => parseNum(m[1]))
    .filter((v): v is number => v != null && v > 0)
    .slice(0, n);

  if (pcts.length < n && areas.length >= n) {
    const total = areas.reduce((s, a) => s + a, 0);
    if (total > 0) {
      pcts = areas.map((a) => round1((a / total) * 100));
    }
  }

  const rows: PitchAreaRow[] = [];
  for (let i = 0; i < n; i++) {
    const areaSqFt = areas[i] ?? 0;
    let pctOfRoof = pcts[i] != null ? pcts[i] / 100 : 0;
    if (pctOfRoof > 1) pctOfRoof = pctOfRoof / 100;
    if (areaSqFt <= 0 && pctOfRoof <= 0) continue;
    rows.push({ pitch: pitches[i], areaSqFt, pctOfRoof });
  }

  if (rows.length >= 2) {
    hits.push(
      `Areas per Pitch: ${rows
        .map((r) => `${r.pitch} ${Math.round(r.pctOfRoof * 1000) / 10}%`)
        .join(', ')}`
    );
  }
  return { rows, hits };
}

/**
 * Detect selected Structure Complexity.
 * EV prints "Simple Normal Complex" as radio labels — do NOT treat that as Simple.
 * Only trust a lone selected value (e.g. "Structure Complexity: Normal").
 */
function parseStructureComplexity(
  fullText: string
): { label: 'simple' | 'normal' | 'complex'; targetPct: number } | null {
  // Explicit single value
  const explicit = fullText.match(
    /Structure\s+Complexity\s*[:\-=]?\s*(Simple|Normal|Complex)\b(?!\s+(Normal|Complex|Simple))/i
  );
  if (explicit?.[1]) {
    const after = fullText.slice(
      (explicit.index ?? 0) + explicit[0].length,
      (explicit.index ?? 0) + explicit[0].length + 24
    );
    // Reject "Simple Normal Complex" radio strip
    if (/^\s*(Normal|Complex|Simple)\b/i.test(after)) {
      return null;
    }
    const c = explicit[1].toLowerCase();
    if (c === 'simple') return { label: 'simple', targetPct: 10 };
    if (c === 'normal') return { label: 'normal', targetPct: 15 };
    return { label: 'complex', targetPct: 18 };
  }
  return null;
}

/**
 * Parse EagleView Waste Calculation table + Suggested / complexity hints.
 *
 * Prefer table Squares at Suggested (~15% for Normal) over facet heuristics.
 * Never treat the "Simple Normal Complex" radio strip as selected Simple.
 */
function parseSuggestedWaste(
  fullText: string,
  measuredSquares: number | null
): { waste: number; suggestedSquares: number | null; hits: string[] } {
  const hits: string[] = [];
  const sectionIdx = fullText.search(/Waste\s+Calculation/i);
  const section =
    sectionIdx >= 0
      ? fullText.slice(sectionIdx, sectionIdx + 2200)
      : fullText.slice(0, 6000);

  // Explicit "Suggested … 15%" style (rare but definitive)
  const explicit = section.match(
    /Suggested[^\n%]{0,40}?(\d{1,2}(?:\.\d+)?)\s*%/i
  );
  if (explicit?.[1]) {
    const pct = parseNum(explicit[1]);
    if (pct != null && pct >= 0 && pct <= 40) {
      const waste = nearestWasteOption(pct / 100);
      hits.push(explicit[0].replace(/\s+/g, ' ').trim());
      const suggestedSquares =
        measuredSquares != null ? round1(measuredSquares * (1 + waste)) : null;
      return { waste, suggestedSquares, hits };
    }
  }

  // Waste % row + Squares row (table) — allow newlines between tokens
  const pctMatch = section.match(
    /Waste\s*%\s*((?:\d{1,2}(?:\.\d+)?%\s*){3,})/i
  );
  const sqMatch = section.match(
    /Squares\s*\*?\s*((?:[\d,]+\.\d+|\d{1,4}(?:\.\d+)?)\s*){3,}/i
  );

  let percents: number[] = [];
  let squareVals: number[] = [];
  if (pctMatch?.[1]) {
    percents = [...pctMatch[1].matchAll(/(\d{1,2}(?:\.\d+)?)%/g)].map((m) =>
      Number(m[1])
    );
    hits.push(`Waste % ${pctMatch[1].replace(/\s+/g, ' ').trim()}`);
  }
  if (sqMatch?.[0]) {
    squareVals = [...sqMatch[0].matchAll(/([\d,]+\.\d+|\d{1,4}(?:\.\d+)?)/g)]
      .map((m) => parseNum(m[1]))
      .filter((n): n is number => n != null && n > 0);
    hits.push(sqMatch[0].replace(/\s+/g, ' ').trim().slice(0, 120));
  }

  const complexity = parseStructureComplexity(fullText);
  let targetPct: number | null = complexity?.targetPct ?? null;
  if (complexity) {
    hits.push(`Complexity ${complexity.label}`);
  }

  const hasSuggestedLabel = /Measured\s+Suggested|Suggested\s+Measured/i.test(
    section
  );
  if (hasSuggestedLabel) hits.push('Measured/Suggested labels');

  // When EV marks Suggested but complexity radio isn't readable, prefer 15%
  // (Normal residential default) — NOT the first radio label "Simple" → 10%.
  if (targetPct == null && (hasSuggestedLabel || percents.length > 0)) {
    targetPct = 15;
    hits.push('Default Suggested target 15%');
  }

  if (percents.length > 0 && squareVals.length > 0) {
    const n = Math.min(percents.length, squareVals.length);
    percents = percents.slice(0, n);
    squareVals = squareVals.slice(0, n);

    let idx = -1;
    if (targetPct != null) {
      let best = Infinity;
      for (let i = 0; i < percents.length; i++) {
        const d = Math.abs(percents[i] - targetPct);
        if (d < best) {
          best = d;
          idx = i;
        }
      }
    } else if (hasSuggestedLabel) {
      const preferred = [15, 13, 14, 16, 18, 11, 12, 10];
      for (const p of preferred) {
        const i = percents.findIndex((x) => Math.abs(x - p) < 0.6);
        if (i >= 0) {
          idx = i;
          break;
        }
      }
      if (idx < 0 && percents.length >= 5) idx = Math.min(5, percents.length - 1);
    } else {
      const i = percents.findIndex((x) => Math.abs(x - 15) < 0.6);
      idx = i >= 0 ? i : percents.findIndex((x) => x >= 10 && x <= 18);
      if (idx < 0) idx = Math.min(4, percents.length - 1);
    }

    if (idx >= 0 && idx < squareVals.length) {
      const waste = nearestWasteOption(percents[idx] / 100);
      const suggestedSquares = round1(squareVals[idx]);
      hits.push(`Suggested col ${percents[idx]}% → ${suggestedSquares} sq`);
      return { waste, suggestedSquares, hits };
    }
  }

  // Percents found but squares row missed — still prefer waste % from table
  if (percents.length > 0 && targetPct != null) {
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < percents.length; i++) {
      const d = Math.abs(percents[i] - targetPct);
      if (d < best) {
        best = d;
        idx = i;
      }
    }
    const waste = nearestWasteOption(percents[idx] / 100);
    hits.push(`Waste % only → ${percents[idx]}%`);
    const suggestedSquares =
      measuredSquares != null ? round1(measuredSquares * (1 + waste)) : null;
    return { waste, suggestedSquares, hits };
  }

  // Facet heuristic only when no waste table / Suggested cue
  const facets = firstMatch(fullText, [
    /Total\s+Roof\s+Facets?\s*=\s*([\d,]+)/i,
  ]);
  let waste = 0.15; // residential default — not 10%
  if (targetPct != null) {
    waste = nearestWasteOption(targetPct / 100);
    hits.push(`Complexity→waste ${Math.round(waste * 100)}%`);
  } else if (facets?.value != null) {
    if (facets.value <= 4) waste = 0.1;
    else if (facets.value <= 8) waste = 0.12;
    else if (facets.value <= 14) waste = 0.15;
    else waste = 0.18;
    hits.push(`Facets→waste ${Math.round(waste * 100)}%`);
  } else {
    hits.push('Default waste 15%');
  }

  const suggestedSquares =
    measuredSquares != null ? round1(measuredSquares * (1 + waste)) : null;
  return { waste, suggestedSquares, hits };
}

function derivePitchMeta(
  areas: PitchAreaRow[],
  predominant: string | null
): {
  pitch: string | null;
  secondaryPitch: string | null;
  secondaryFraction: number | null;
  hasLowSlope: boolean;
  lowSlopeFraction: number | null;
} {
  if (areas.length === 0) {
    const rise = predominant ? pitchRise(predominant) : null;
    const low = rise != null && rise <= 3;
    return {
      pitch: predominant,
      secondaryPitch: null,
      secondaryFraction: null,
      hasLowSlope: !!low,
      lowSlopeFraction: low ? 1 : null,
    };
  }

  const sorted = [...areas].sort((a, b) => b.pctOfRoof - a.pctOfRoof);
  const primary = sorted[0];
  const secondary = sorted[1] || null;
  const lowSlopeFraction = round2(
    areas
      .filter((r) => {
        const rise = pitchRise(r.pitch);
        return rise != null && rise <= 3;
      })
      .reduce((s, r) => s + r.pctOfRoof, 0)
  );

  return {
    pitch: predominant || primary.pitch,
    secondaryPitch: secondary?.pitch ?? null,
    secondaryFraction: secondary != null ? round2(secondary.pctOfRoof) : null,
    hasLowSlope: lowSlopeFraction > 0.01,
    lowSlopeFraction: lowSlopeFraction > 0.01 ? lowSlopeFraction : null,
  };
}

export function parseRoofReportText(fullText: string): ParsedRoofReport {
  const rawHits: string[] = [];
  const provider = detectProvider(fullText);
  const scope = preferredScope(fullText);
  const both = `${scope}\n${fullText.slice(0, 4000)}`;

  const area =
    firstMatch(both, [
      /Total\s+Area\s*\(All\s+Pitches\)\s*=\s*([\d,]+(?:\.\d+)?)\s*(?:sq\s*ft|ft²|ft2)?/i,
      /Total\s+Roof\s+Area\s*=\s*([\d,]+(?:\.\d+)?)\s*(?:sq\s*ft|ft²|ft2)?/i,
      /Total\s+Area\s*=\s*([\d,]+(?:\.\d+)?)\s*(?:sq\s*ft|ft²|ft2)?/i,
    ]) ||
    firstMatch(fullText, [
      /Total\s+Roof\s+Area\s*=\s*([\d,]+(?:\.\d+)?)/i,
      /Total\s+Roof\s+Area\s+Less\s+(?:Roof\s+)?(?:Obstructions|Penetrations)\s*=\s*([\d,]+(?:\.\d+)?)/i,
    ]);

  const pitchHit = firstPitch(both) || firstPitch(fullText);

  const ridge =
    firstMatch(scope, [/Ridges?\s*=\s*([\d,]+(?:\.\d+)?)\s*ft/i]) ||
    firstMatch(fullText, [/Ridges?\s*=\s*([\d,]+(?:\.\d+)?)\s*ft/i]);

  const hip =
    firstMatch(scope, [/Hips?\s*=\s*([\d,]+(?:\.\d+)?)\s*ft/i]) ||
    firstMatch(fullText, [/Hips?\s*=\s*([\d,]+(?:\.\d+)?)\s*ft/i]);

  const valley =
    firstMatch(scope, [
      /Valleys?\s*=\s*([\d,]+(?:\.\d+)?)\s*ft/i,
      /Total\s+Valleys?\s*=\s*([\d,]+(?:\.\d+)?)\s*ft/i,
    ]) ||
    firstMatch(fullText, [/Total\s+Valleys?\s*=\s*([\d,]+(?:\.\d+)?)\s*ft/i]);

  const rake =
    firstMatch(scope, [
      /Rakes?\s*†?\s*=\s*([\d,]+(?:\.\d+)?)\s*ft/i,
      /Total\s+Rakes?\s*=\s*([\d,]+(?:\.\d+)?)\s*ft/i,
    ]) ||
    firstMatch(fullText, [/Total\s+Rakes?\s*=\s*([\d,]+(?:\.\d+)?)\s*ft/i]);

  const eave =
    firstMatch(scope, [
      /Eaves?\/Starter\s*‡?\s*=\s*([\d,]+(?:\.\d+)?)\s*ft/i,
      /Eaves?\s*=\s*([\d,]+(?:\.\d+)?)\s*ft/i,
      /Total\s+Eaves?\s*=\s*([\d,]+(?:\.\d+)?)\s*ft/i,
    ]) ||
    firstMatch(fullText, [/Total\s+Eaves?\s*=\s*([\d,]+(?:\.\d+)?)\s*ft/i]);

  const drip =
    firstMatch(scope, [
      /Drip\s+Edge\s*\(Eaves?\s*\+\s*Rakes?\)\s*=\s*([\d,]+(?:\.\d+)?)\s*ft/i,
      /Fascia\s*\(Eaves?\s*\+\s*Rakes?\)\s*=\s*([\d,]+(?:\.\d+)?)\s*ft/i,
    ]) ||
    firstMatch(fullText, [
      /Drip\s+Edge\s*\(Eaves?\s*\+\s*Rakes?\)\s*=\s*([\d,]+(?:\.\d+)?)\s*ft/i,
    ]);

  const facets = firstMatch(both, [
    /Total\s+Roof\s+Facets?\s*=\s*([\d,]+)/i,
  ]);

  for (const hit of [
    area,
    pitchHit,
    ridge,
    hip,
    valley,
    rake,
    eave,
    drip,
    facets,
  ]) {
    if (hit && 'hit' in hit) rawHits.push(hit.hit);
  }

  const areasInfo = parseAreasPerPitch(fullText);
  rawHits.push(...areasInfo.hits);

  const totalAreaSqFt = area?.value ?? null;
  const measuredSquares =
    totalAreaSqFt != null ? round1(totalAreaSqFt / 100) : null;

  const wasteInfo = parseSuggestedWaste(fullText, measuredSquares);
  rawHits.push(...wasteInfo.hits);

  const waste = wasteInfo.waste;
  // Prefer EV table order squares over measured × (1+waste)
  const squares =
    wasteInfo.suggestedSquares != null
      ? wasteInfo.suggestedSquares
      : measuredSquares != null
        ? round1(measuredSquares * (1 + waste))
        : null;

  const pitchMeta = derivePitchMeta(areasInfo.rows, pitchHit?.value ?? null);

  let confidence = 0;
  if (totalAreaSqFt != null) confidence += 0.3;
  if (pitchMeta.pitch) confidence += 0.15;
  if (wasteInfo.hits.length > 0) confidence += 0.15;
  if (ridge?.value != null || hip?.value != null) confidence += 0.15;
  if (eave?.value != null || rake?.value != null) confidence += 0.1;
  if (provider === 'eagleview') confidence += 0.1;
  if (areasInfo.rows.length >= 2) confidence += 0.05;

  return {
    provider,
    totalAreaSqFt,
    measuredSquares,
    squares,
    waste,
    pitch: pitchMeta.pitch,
    secondaryPitch: pitchMeta.secondaryPitch,
    secondaryFraction: pitchMeta.secondaryFraction,
    areasPerPitch: areasInfo.rows,
    hasLowSlope: pitchMeta.hasLowSlope,
    lowSlopeFraction: pitchMeta.lowSlopeFraction,
    ridgeLF: ridge?.value ?? null,
    hipLF: hip?.value ?? null,
    valleyLF: valley?.value ?? null,
    rakeLF: rake?.value ?? null,
    eaveLF: eave?.value ?? null,
    dripEdgeLF: drip?.value ?? null,
    facets: facets?.value ?? null,
    confidence: Math.min(1, Math.round(confidence * 100) / 100),
    rawHits,
  };
}

export function isUsableParsedReport(p: ParsedRoofReport): boolean {
  return (
    (p.squares != null && p.squares > 0) ||
    (p.measuredSquares != null && p.measuredSquares > 0) ||
    (p.totalAreaSqFt != null && p.totalAreaSqFt > 0)
  );
}
