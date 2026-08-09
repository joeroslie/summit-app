'use client';

import { PRICING_GUIDE } from '@/lib/pricingGuide';

type CompanyPricingRegion = 'central' | 'southern' | 'northern';

type CompanyPricingProps = {
  documentWorkspaceClass: string;
  exitLeadDocumentWorkspace: () => void;
  companyPricingPane: 'labor' | 'materials';
  setCompanyPricingPane: (pane: 'labor' | 'materials') => void;
  expandedPricingSections: Set<string>;
  togglePricingSection: (title: string) => void;
  priceSheet: Record<string, number>;
  getCost: (
    itemKey: string,
    fallback?: number,
    region?: CompanyPricingRegion
  ) => number;
  isShinglePackageKey: (key: string) => boolean;
};

export default function CompanyPricing({
  documentWorkspaceClass,
  exitLeadDocumentWorkspace,
  companyPricingPane,
  setCompanyPricingPane,
  expandedPricingSections,
  togglePricingSection,
  priceSheet,
  getCost,
  isShinglePackageKey,
}: CompanyPricingProps) {
  return (
    <div className={documentWorkspaceClass}>
      <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 py-6 pb-24">
        <div className="sticky top-0 z-10 -mx-4 sm:-mx-6 px-4 sm:px-6 py-4 mb-6 bg-zinc-50/95 backdrop-blur border-b border-zinc-200/70">
          <button
            type="button"
            onClick={() => exitLeadDocumentWorkspace()}
            className="text-sm text-zinc-500 hover:text-zinc-800 mb-3 inline-flex items-center gap-1"
          >
            ← Back
          </button>
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
            <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">
              Company pricing
            </h1>
            <div className="inline-flex rounded-2xl border border-zinc-200 bg-white p-1 shadow-sm">
              {(
                [
                  ['labor', 'Labor'],
                  ['materials', 'Materials'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setCompanyPricingPane(id)}
                  className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
                    companyPricingPane === id
                      ? 'bg-zinc-900 text-white'
                      : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-5">
          {PRICING_GUIDE.filter((s) => s.pane === companyPricingPane).map(
            (section) => {
              const expanded = expandedPricingSections.has(section.title);
              return (
              <section
                key={section.title}
                className="rounded-3xl border border-zinc-200/80 bg-white overflow-hidden shadow-sm"
              >
                <button
                  type="button"
                  onClick={() => togglePricingSection(section.title)}
                  className="w-full px-5 py-4 border-b border-zinc-100 flex items-center justify-between gap-3 bg-gradient-to-r from-zinc-50 to-white hover:from-zinc-100 transition-colors text-left"
                  aria-expanded={expanded}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <svg
                      className={`w-4 h-4 text-zinc-400 shrink-0 transition-transform duration-200 ${
                        expanded ? 'rotate-90' : ''
                      }`}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-hidden
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M9 6l6 6-6 6"
                      />
                    </svg>
                    <h2 className="text-base font-semibold text-zinc-900 truncate">
                      {section.title}
                    </h2>
                  </div>
                  {(section.supplier === 'Miller' ||
                    section.supplier === 'SRS') && (
                    <span
                      className={`text-[11px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full shrink-0 ${
                        section.supplier === 'Miller'
                          ? 'bg-amber-50 text-amber-800 ring-1 ring-amber-100'
                          : 'bg-[var(--chrome-soft)] text-[var(--graphite)] ring-1 ring-[var(--chrome-line)]'
                      }`}
                    >
                      {section.supplier}
                    </span>
                  )}
                </button>
                <div
                  className="grid transition-[grid-template-rows] duration-300 ease-in-out"
                  style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
                >
                  <div className="overflow-hidden">
                <div className="divide-y divide-zinc-100">
                  {section.rows.map((row, idx) => {
                    const live =
                      row.key && priceSheet && priceSheet[row.key] != null
                        ? Number(priceSheet[row.key])
                        : null;
                    // Steep rows: ignore stale legacy RFQ labor-base values
                    // ($100/$175/$250 or old 20%-pad $30/$90/$180) left over
                    // in price_sheet — sell is cover-only ($25/$75/$150).
                    const isLegacySteepValue =
                      (row.key === 'steep_8_9' ||
                        row.key === 'steep_9_11' ||
                        row.key === 'steep_11_12') &&
                      live != null &&
                      [100, 175, 250, 30, 90, 180].includes(live);
                    // HVAC: ignore stale pre-2026 $1,250 override —
                    // current sell is $1,300 PHX (see getHvacSellPrice).
                    const isLegacyHvacValue =
                      row.key === 'hvac' && live === 1250;
                    const sellPhx =
                      live != null &&
                      live > 0 &&
                      !isLegacySteepValue &&
                      !isLegacyHvacValue
                        ? live
                        : row.sellPhx;
                    const liveCost =
                      row.key != null
                        ? getCost(row.key, row.cost ?? 0)
                        : row.cost ?? 0;
                    // "Shingle package sells" cost is the field shingle
                    // bundle (material) price only. The package itself —
                    // what it actually costs us to deliver — is material
                    // + base install labor (mirrors realMaterial/realLabor
                    // in the Internal cost breakdown). Show that all-in
                    // package cost per region alongside the material cost
                    // so margin vs. the all-in sell price isn't overstated.
                    const isShinglePackageRow =
                      row.key != null && isShinglePackageKey(row.key);
                    const packageLaborCentral = getCost(
                      'base_shingle',
                      100,
                      'central'
                    );
                    const packageLaborSouthern = getCost(
                      'base_shingle',
                      110,
                      'southern'
                    );
                    const packageLaborNorthern = getCost(
                      'base_shingle',
                      110,
                      'northern'
                    );
                    const packageCostPhx =
                      isShinglePackageRow && liveCost > 0
                        ? liveCost + packageLaborCentral
                        : 0;
                    const packageCostTuc =
                      isShinglePackageRow && liveCost > 0
                        ? liveCost + packageLaborSouthern
                        : 0;
                    const packageCostNorth =
                      isShinglePackageRow && liveCost > 0
                        ? liveCost + packageLaborNorthern
                        : 0;
                    const unit = row.unit || '';
                    const fmt = (n: number, digits = 2) =>
                      `$${n.toLocaleString(undefined, {
                        maximumFractionDigits: digits,
                      })}`;
                    const hasSell =
                      (sellPhx != null && sellPhx > 0) ||
                      (row.sellTuc != null && row.sellTuc > 0) ||
                      (row.sellNorth != null && row.sellNorth > 0);
                    const costLabel = isShinglePackageRow
                      ? 'Material'
                      : 'Cost';
                    const hasCost = liveCost > 0;
                    // Horizontal "stack" of region figures within one stat card
                    // (e.g. Cost | All-in | Sell), given room to breathe.
                    const regionStack = (
                      entries: Array<[string, number]>
                    ) => (
                      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                        {entries
                          .filter(([, v]) => v > 0)
                          .map(([reg, v]) => (
                            <span
                              key={reg}
                              className="whitespace-nowrap text-sm tabular-nums"
                            >
                              <span className="text-[10px] text-zinc-400 mr-1">
                                {reg}
                              </span>
                              <span className="font-semibold text-zinc-900">
                                {fmt(v, 0)}
                              </span>
                            </span>
                          ))}
                      </div>
                    );
                    return (
                      <div
                        key={`${section.title}-${idx}`}
                        className="px-5 py-5 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-5 hover:bg-zinc-50/60 transition-colors"
                      >
                        <div className="min-w-0 sm:w-48 md:w-56 sm:shrink-0">
                          <div className="text-sm font-medium text-zinc-900 leading-snug">
                            {row.label}
                          </div>
                          {row.note && (
                            <div className="text-[11px] text-zinc-400 leading-snug mt-0.5">
                              {row.note}
                            </div>
                          )}
                        </div>
                        <div className="flex-1 flex flex-wrap items-stretch gap-3">
                          {hasCost && (
                            <div className="flex-1 min-w-[130px] rounded-2xl bg-zinc-50 px-4 py-3 flex flex-col justify-center gap-1.5">
                              <span className="text-[9px] font-semibold uppercase tracking-wider text-zinc-400 whitespace-nowrap">
                                {costLabel}
                              </span>
                              <span className="whitespace-nowrap text-sm tabular-nums font-semibold text-zinc-900">
                                {fmt(liveCost)}
                                {unit ? (
                                  <span className="text-[10px] font-normal text-zinc-400 ml-1">
                                    {unit}
                                  </span>
                                ) : null}
                              </span>
                            </div>
                          )}
                          {isShinglePackageRow && hasCost && (
                            <div className="flex-[1.6] min-w-[210px] rounded-2xl bg-zinc-50 px-4 py-3 flex flex-col justify-center gap-1.5">
                              <span className="text-[9px] font-semibold uppercase tracking-wider text-zinc-400 whitespace-nowrap">
                                All-in (mat + labor)
                              </span>
                              {regionStack([
                                ['PHX', packageCostPhx],
                                ['Tuc', packageCostTuc],
                                ['North', packageCostNorth],
                              ])}
                            </div>
                          )}
                          {hasSell && (
                            <div className="flex-[1.6] min-w-[210px] rounded-2xl bg-zinc-50 px-4 py-3 flex flex-col justify-center gap-1.5">
                              <span className="text-[9px] font-semibold uppercase tracking-wider text-zinc-400 whitespace-nowrap">
                                Sell
                              </span>
                              {regionStack([
                                ['PHX', sellPhx ?? 0],
                                ['Tuc', row.sellTuc ?? 0],
                                ['North', row.sellNorth ?? 0],
                              ])}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                  </div>
                </div>
              </section>
              );
            }
          )}
        </div>
      </div>
    </div>
  );
}
