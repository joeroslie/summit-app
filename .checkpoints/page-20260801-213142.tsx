'use client';
import { useState, useEffect, useRef, useMemo } from 'react';
import dynamic from 'next/dynamic';
import jsPDF from 'jspdf';
import {
  buildRoofSection,
  aggregateSectionsToMeasurement,
  normalizeMeasurement,
  polygonToSvgPath,
  multiSectionSvgPaths,
  computeRoofMetrics,
  estimatePitchFromPolygon,
  estimateWasteFromPolygon,
  type RoofMeasurement,
  type RoofSection,
  type RoofSectionKind,
  type LatLngPoint,
  type RoofType,
} from '@/lib/roof-geometry';
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';

const PITCH_OPTIONS = [
  'Flat',
  '2/12',
  '3/12',
  '4/12',
  '5/12',
  '6/12',
  '7/12',
  '8/12',
  '9/12',
  '10/12',
  '11/12',
  '12/12',
] as const;
import { geocodeAddress as geocodeAddressApi } from '@/lib/geocode';
import { displayPhoneUS } from '@/lib/phone';
import PhoneInput from '@/components/PhoneInput';
import AddressAutocomplete from '@/components/AddressAutocomplete';

const RoofTracer = dynamic(() => import('@/components/RoofTracer'), {
  ssr: false,
  loading: () => (
    <div className="h-[min(56vh,520px)] min-h-[420px] rounded-2xl border border-zinc-200 bg-zinc-100 flex items-center justify-center text-sm text-zinc-400">
      Loading map…
    </div>
  ),
});

type AppTab =
  | 'home'
  | 'leads' // Jobs board
  | 'estimates'
  | 'invoices'
  | 'calendar'
  | 'performance'
  | 'tools'
  | 'documents'
  | 'settings';
/** Customer estimate form vs internal financials (inside lead profile). */
type EstimateWorkspace = 'estimate' | 'internal';

/** Primary app destinations (sidebar). Estimator stays lead-profile only. */
const APP_TABS: AppTab[] = [
  'home',
  'leads',
  'estimates',
  'invoices',
  'calendar',
  'performance',
  'tools',
  'documents',
  'settings',
];

const NEGOTIATION_BUFFER_CAP = 3500;

const DEFAULT_USER_PROFILE = {
  name: 'Joe Roslie',
  title: 'Project Manager',
  company: 'Summit Roofing',
  phone: '2533812035',
  email: 'joe.roslie@prowest.com',
} as const;

/** Appearance: Day, Night, or Auto (by local clock). */
type ThemePreference = 'day' | 'night' | 'auto';
type ThemeMode = 'day' | 'night';

const THEME_PREFS: ThemePreference[] = ['day', 'night', 'auto'];
/** Auto night window: 7:00 PM – 6:59 AM local time */
const AUTO_NIGHT_START_HOUR = 19;
const AUTO_NIGHT_END_HOUR = 7;

function readStoredThemePref(): ThemePreference {
  if (typeof window === 'undefined') return 'auto';
  try {
    const t = localStorage.getItem('summitThemePref');
    if (t && (THEME_PREFS as string[]).includes(t)) return t as ThemePreference;
  } catch {
    /* ignore */
  }
  return 'auto';
}

function resolveThemeMode(
  pref: ThemePreference,
  date: Date = new Date()
): ThemeMode {
  if (pref === 'day') return 'day';
  if (pref === 'night') return 'night';
  const hour = date.getHours();
  return hour >= AUTO_NIGHT_START_HOUR || hour < AUTO_NIGHT_END_HOUR
    ? 'night'
    : 'day';
}

function applyThemeMode(mode: ThemeMode) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', mode);
  document.documentElement.style.colorScheme =
    mode === 'night' ? 'dark' : 'light';
}

function timeOfDayGreeting(date: Date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function firstNameFrom(fullName: string, fallback = 'Joe'): string {
  const part = fullName.trim().split(/\s+/)[0];
  return part || fallback;
}

/** Local YYYY-MM-DD for calendar cells */
function toLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfWeekSunday(d: Date): Date {
  const x = new Date(d);
  x.setHours(12, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay());
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Parse lead date fields into YYYY-MM-DD when possible */
function leadScheduleIso(lead: {
  followUpDate?: string;
  date?: string;
  calendarSyncedAt?: string;
}): string | null {
  const raw = lead.followUpDate || lead.date || '';
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return raw.trim();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return toLocalIsoDate(d);
}

function readStoredTab(): AppTab {
  if (typeof window === 'undefined') return 'home';
  try {
    const t = localStorage.getItem('summitActiveTab');
    if (t && (APP_TABS as string[]).includes(t)) return t as AppTab;
  } catch {
    /* ignore */
  }
  return 'home';
}

function readStoredBool(key: string, fallback = false): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    return v === 'true';
  } catch {
    return fallback;
  }
}

function readStoredLeadId(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = localStorage.getItem('summitCurrentLeadId');
    if (!v) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

type RoofSystem = 'shingle' | 'tile' | 'flat';
/** Top-level low slope roof system (estimator flat product tree). */
type FlatSystem = 'mod_bit' | 'bur' | 'foam' | 'coating' | '';
/** Coating chemistry when FlatSystem is coating. */
type CoatingKind = 'elastomeric' | 'silicone' | 'urethane' | '';
/** Foam install style when FlatSystem is foam. */
type FoamKind = 'full' | 'overlay' | '';
type ShingleType =
  | 'cambridge'
  | 'dynasty'
  | 'armourshake'
  | 'gaf_hdz'
  | 'gaf_natural_shadow'
  | 'owens_oakridge'
  | 'owens_duration'
  | 'tile_dr'
  | 'tile_rr'
  | 'sa_underlayment'
  | 'coating'
  | 'elastomeric'
  | 'silicone'
  | 'urethane'
  | 'full_foam'
  | 'foam_overlay'
  | 'mod_bitumen'
  | 'bur'
  | '';

const SHINGLE_PRODUCTS: {
  key: ShingleType;
  label: string;
  description: string;
  colors: string[];
}[] = [
  {
    key: 'cambridge',
    label: 'IKO Cambridge',
    description:
      'Architectural shingle with laminated two-piece design that creates depth and dimension. Fiberglass core, FastLock® bonding, Class 3 impact resistance, and built-in algae resistance.',
    colors: [
      'Dual Brown',
      'Weatherwood',
      'Driftwood',
      'Charcoal Grey',
      'Harvard Slate',
      'Dual Black',
      'Autumn Brown',
      'Shadow Black',
    ],
  },
  {
    key: 'dynasty',
    label: 'IKO Dynasty',
    description:
      'High-performance laminated shingle with ArmourZone® reinforced nailing surface for superior wind resistance. Class 3 impact rating and enhanced granule adhesion.',
    colors: [
      'Cornerstone',
      'Shadow Brown',
      'Driftwood',
      'Charcoal Grey',
      'Harvard Slate',
      'Dual Black',
      'Castle Grey',
      'Summit Grey',
    ],
  },
  {
    key: 'armourshake',
    label: 'IKO Armourshake',
    description:
      'Premium designer shingle with deep dimensional profile that mimics the look of hand-hewn cedar shakes. Heavyweight construction with Class 3 impact resistance.',
    colors: [
      'Weathered Summit',
      'Shadow Black',
      'Harvard Slate',
      'Dual Brown',
      'Charcoal Grey',
    ],
  },
  {
    key: 'gaf_hdz',
    label: 'GAF Timberline HDZ',
    description:
      "GAF's #1-selling architectural shingle. Features LayerLock® Technology with the industry’s widest nailing area (StrikeZone®) and DuraGrip® adhesive.",
    colors: [
      'Charcoal',
      'Barkwood',
      'Pewter Gray',
      'Shakewood',
      'Slate',
      'Hickory',
      'Weathered Wood',
    ],
  },
  {
    key: 'gaf_natural_shadow',
    label: 'GAF Natural Shadow',
    description:
      'Architectural shingle with a classic shadow effect for a subtle, even-toned wood-shake look. Practical performance with lifetime limited warranty eligibility.',
    colors: [
      'Charcoal',
      'Weathered Wood',
      'Barkwood',
      'Pewter Gray',
      'Shakewood',
    ],
  },
  {
    key: 'owens_oakridge',
    label: 'Owens Corning Oakridge',
    description:
      'Laminated architectural shingle with a full double-layer nailing zone for better holding power. Warm, dimensional appearance in popular colors.',
    colors: [
      'Estate Gray',
      'Brownwood',
      'Driftwood',
      'Onyx Black',
      'Teak',
      'Desert Tan',
    ],
  },
  {
    key: 'owens_duration',
    label: 'Owens Corning Duration',
    description:
      'Premium architectural shingle with patented SureNail® Technology — a woven fabric strip in the nailing zone for outstanding gripping power and wind resistance.',
    colors: [
      'Estate Gray',
      'Brownwood',
      'Driftwood',
      'Onyx Black',
      'Teak',
      'Desert Tan',
      'Williamswood',
    ],
  },
];

const TILE_PRODUCTS: { key: string; label: string; description: string }[] = [
  {
    key: 'concrete',
    label: 'Concrete Tile',
    description:
      'Durable concrete tile in common profiles. Strong wind and fire performance.',
  },
  {
    key: 'clay',
    label: 'Clay Tile',
    description:
      'Traditional clay tile with a premium look. Excellent longevity and curb appeal.',
  },
  {
    key: 'concrete_s',
    label: 'Concrete S-Tile',
    description: 'S-profile concrete tile for a classic Mediterranean look.',
  },
  {
    key: 'concrete_flat',
    label: 'Concrete Flat / Shake',
    description:
      'Flat or shake-profile concrete tile for a more contemporary appearance.',
  },
];

/** Brands per tile type — fill later from suppliers */
const TILE_BRANDS: Record<string, { key: string; label: string }[]> = {
  concrete: [],
  clay: [],
  concrete_s: [],
  concrete_flat: [],
};

const LOW_SLOPE_TYPES: { key: string; label: string; description: string }[] = [
  {
    key: 'mod_bitumen',
    label: 'Modified Bitumen',
    description:
      'Torch-down or cold-applied modified bitumen system with base and cap sheet.',
  },
  {
    key: 'bur',
    label: 'Built-Up Roof (BUR)',
    description: 'Traditional multi-ply built-up roof system.',
  },
  {
    key: 'full_foam',
    label: 'Full Foam (SPF)',
    description: 'Full spray polyurethane foam system with protective coating.',
  },
  {
    key: 'foam_overlay',
    label: 'Foam Overlay',
    description: 'SPF overlay over an existing roof with protective coating.',
  },
  {
    key: 'coating',
    label: 'Roof Coating',
    description:
      'Elastomeric, silicone, or urethane coating system over existing roof.',
  },
];

const COATING_TYPES: { key: string; label: string; description: string }[] = [
  {
    key: 'elastomeric',
    label: 'Acrylic Elastomeric',
    description:
      'Water-based acrylic elastomeric coating. Cost-effective and reflective.',
  },
  {
    key: 'silicone',
    label: 'Silicone',
    description:
      'High-solids silicone coating. Excellent ponding-water resistance.',
  },
  {
    key: 'urethane',
    label: 'Urethane',
    description:
      'Durable urethane coating with strong adhesion and abrasion resistance.',
  },
];

const MOD_BITUMEN_CAP_COLORS = [
  'White',
  'Black',
  'Buff',
  'Gray Slate',
  'Weatherwood',
  'Chestnut',
  'Heather Blend',
  'Oak',
  'Red Blend',
  'Pine Green',
  'Other',
];

type FasciaMode = 'repair' | 'full' | '';
type DeckingMode = 'repair' | 'full' | '';
type FasciaType = '2x6' | '2x8' | '';
type Underlayment = 'standard' | 'high-temp' | 'sa-high-temp' | '';

type Estimate = {
  id: number;
  date: string;
  clientFirstName: string;
  clientLastName: string;
  clientAddress: string;
  clientCity: string;
  clientState: string;
  clientZip: string;
  clientPhone: string;
  clientEmail: string;
  clientJobNumber: string;
  squares: string;
  layers: string;
  waste: string;
  pitch: string;
  stories: string;
  fasciaLF: string;
  deckingSheets: string;
  deckingOsbSheets?: string;
  deckingCdxSheets?: string;
  solarPanels: string;
  hvacUnits: string;
  skylights: string;
  ridgeVentLF: string;
  gutterMode?: 'none' | 'dr' | 'rr';
  gutterLF?: string;
  selectedShingle: ShingleType;
  cambridgeColor: string;
  dynastyColor: string;
  armourshakeColor: string;
  selectedUnderlayment: Underlayment;
  fasciaMode: FasciaMode;
  deckingMode: DeckingMode;
  fasciaType: FasciaType;
  modifiedBitumenSquares: string;
  modifiedBitumenColor: string;
  dripEdgeColor: string;
  notes: string;
  total: number;
  negotiatedPrice: number;
  originalTotalForBuffer: number;
  measurementId?: string;
  /** Supabase `estimates.id` when synced to cloud */
  supabaseId?: string;
};

type LeadNote = {
  text: string;
  date: string;
};

/** Field guide for Company pricing document (sell + known costs + crews/contacts). */
const PRICING_GUIDE: {
  title: string;
  rows: {
    label: string;
    unit: string;
    cost?: number;
    sellPhx?: number;
    sellTuc?: number;
    key?: string;
    note?: string;
  }[];
}[] = [
  {
    title: 'Shingle systems — sell',
    rows: [
      { key: 'cambridge', label: 'IKO Cambridge', unit: '/sq', cost: 89, sellPhx: 485, sellTuc: 485, note: '$29.67/bdl × 3' },
      { key: 'dynasty', label: 'IKO Dynasty', unit: '/sq', cost: 94, sellPhx: 500, sellTuc: 500, note: '$31.33/bdl × 3' },
      { key: 'armourshake', label: 'IKO Armourshake', unit: '/sq', cost: 240, sellPhx: 785, sellTuc: 785, note: '$48/bdl × 5' },
      { key: 'gaf_hdz', label: 'GAF HDZ', unit: '/sq', sellPhx: 500, sellTuc: 525 },
      { key: 'gaf_natural_shadow', label: 'GAF Natural Shadow', unit: '/sq', sellPhx: 475, sellTuc: 500 },
      { key: 'owens_oakridge', label: 'Owens Oakridge', unit: '/sq', sellPhx: 500, sellTuc: 525 },
      { key: 'owens_duration', label: 'Owens Duration', unit: '/sq', sellPhx: 525, sellTuc: 550 },
    ],
  },
  {
    title: 'Shingle adders — sell',
    rows: [
      { label: 'Remove additional layer', unit: '/sq', sellPhx: 20, sellTuc: 25 },
      { label: 'R&R OSB', unit: '/sheet', cost: 0, sellPhx: 80, sellTuc: 90 },
      { label: 'R&R Fascia 2x6', unit: '/LF', sellPhx: 15, sellTuc: 18 },
      { label: 'R&R Fascia 2x8', unit: '/LF', sellPhx: 18, sellTuc: 18 },
      { label: 'Install ridge vent', unit: '/LF', cost: 6, sellPhx: 13, sellTuc: 14 },
      { label: 'HD Skylight', unit: '/each', sellPhx: 525, sellTuc: 550 },
      { label: 'R&R Shingle mold', unit: '/LF', sellPhx: 5, sellTuc: 6 },
      { label: 'D&R Gutters', unit: '/LF', sellPhx: 18, sellTuc: 20 },
      { label: 'R&R Gutters', unit: '/LF', sellPhx: 25, sellTuc: 30 },
      { label: 'Roof repairs minimum', unit: '/job', sellPhx: 1500, sellTuc: 1750 },
      { label: 'Steep charge', unit: '/sq', note: 'Depends on pitch / crew · $100–250' },
    ],
  },
  {
    title: 'Tile — sell',
    rows: [
      { key: 'tile_dr', label: 'Detach & Reset', unit: '/sq', sellPhx: 525, sellTuc: 550 },
      { key: 'tile_rr', label: 'Remove & Replace', unit: '/sq', sellPhx: 925, sellTuc: 950 },
      { label: 'SA / upgraded underlayment', unit: '/sq', sellPhx: 85, sellTuc: 100 },
    ],
  },
  {
    title: 'Low slope / foam / coating — sell',
    rows: [
      { key: 'mod_bitumen', label: 'Modified bitumen', unit: '/sq', cost: 375, sellPhx: 600, sellTuc: 600, note: 'Cost ~cap+base ply' },
      { key: 'elastomeric', label: 'Elastomeric coating', unit: '/sq', sellPhx: 275, sellTuc: 300 },
      { key: 'silicone', label: 'Silicone coating', unit: '/sq', sellPhx: 325, sellTuc: 350 },
      { key: 'urethane', label: 'Urethane coating', unit: '/sq', sellPhx: 350, sellTuc: 375 },
      { key: 'coating', label: 'Coating (legacy)', unit: '/sq', sellPhx: 275, sellTuc: 300, note: 'Prefer kind keys' },
      { key: 'full_foam', label: 'Full foam', unit: '/sq', sellPhx: 600, sellTuc: 650 },
      { key: 'foam_overlay', label: 'Foam overlay', unit: '/sq', sellPhx: 575, sellTuc: 615 },
      { key: 'bur', label: 'Built-up (BUR)', unit: '/sq', note: 'Set sell in price_sheet' },
      { key: 'iso_board', label: 'ISO board (fallback)', unit: '/sheet', note: 'Prefer iso_4x8 / iso_4x4' },
      { key: 'iso_4x8', label: 'ISO 4×8 sheet', unit: '/sheet', note: '32 sq ft' },
      { key: 'iso_4x4', label: 'ISO 4×4 sheet', unit: '/sheet', note: '16 sq ft' },
      { key: 'granules', label: 'Granules adder', unit: '/sq', note: 'Foam adder' },
      { key: 'extra_spf', label: 'Extra inch SPF', unit: '/sq', note: 'Foam adder' },
      { key: 'scarify', label: 'Scarify', unit: '/sq', note: 'Foam adder' },
      { key: 'extra_pass', label: 'Additional coat', unit: '/sq', note: 'Coating adder' },
      { key: 'pressure_wash', label: 'Pressure wash & clean', unit: '/sq', note: 'Coating adder' },
    ],
  },
  {
    title: 'HVAC — sell',
    rows: [
      { key: 'hvac', label: 'D&R HVAC unit', unit: '/each', sellPhx: 1500, sellTuc: 1600 },
    ],
  },
  {
    title: 'Known material / labor cost',
    rows: [
      { label: 'Dynasty material', unit: '/sq', cost: 94, note: '$31.33/bdl × 3' },
      { label: 'Cambridge material', unit: '/sq', cost: 89, note: '$29.67/bdl × 3' },
      { label: 'Armourshake material', unit: '/sq', cost: 240, note: '$48/bdl × 5' },
      { label: 'Ridge vent material', unit: '/LF', cost: 6 },
      { label: 'MB cap sheet', unit: '/sq', cost: 123 },
      { label: 'MB base ply', unit: '/sq/ply', cost: 126 },
      { label: 'Base labor (shingle)', unit: '/sq', cost: 100, note: 'Phoenix' },
    ],
  },
  {
    title: 'Sub labor — Phoenix',
    rows: [
      { label: 'Maldonado', unit: '/sq', cost: 100 },
      { label: 'Delgado', unit: '/sq', cost: 110, note: '100–120' },
      { label: 'Mile High', unit: '/sq', cost: 100, note: '95–110' },
      { label: 'EZ', unit: '/sq', cost: 105, note: '100–110' },
      { label: 'TRC', unit: '/sq', cost: 120, note: '110–130' },
      { label: 'Crew', unit: '/sq', cost: 110, note: '105–120' },
      { label: 'JJ', unit: '/sq', cost: 105, note: '100–115' },
      { label: 'Blueprint', unit: '/sq', cost: 130 },
      { label: 'G&M', unit: '/sq', cost: 120, note: '100–140' },
      { label: 'Spearhead', unit: '/sq', cost: 110, note: '95–130' },
      { label: 'My Way', unit: '/sq', cost: 100 },
      { label: 'Gleason', unit: '/sq', cost: 110, note: '100–125' },
      { label: 'Rosales', unit: '/sq', cost: 115, note: '110–120' },
      { label: 'ACI', unit: '/sq', cost: 110, note: '105–120' },
      { label: 'Nailed It', unit: '/sq', cost: 120, note: '110–130' },
    ],
  },
  {
    title: 'Crew contacts',
    rows: [
      { label: 'Manuel Maldonado', unit: '', note: '915-252-2646 · Maldonado' },
      { label: 'Jesus Delgado', unit: '', note: '573-281-9441 · Delgado' },
      { label: 'Pancho Raigoza', unit: '', note: '303-995-6983 · Mile High' },
      { label: 'Sergio Quintanar', unit: '', note: '623-349-2515 · EZ' },
      { label: 'Josue Mtz', unit: '', note: '520-313-1641 · TRC' },
      { label: 'George Galvin', unit: '', note: '602-789-4358 · Crew' },
      { label: 'Joell Jaquez', unit: '', note: '602-471-3715 · JJ' },
      { label: 'Daniel Romero', unit: '', note: '520-548-9949 · Blueprint' },
      { label: 'Gerry Busta', unit: '', note: '520-336-1261 · G&M' },
      { label: 'Joe Jasso', unit: '', note: '480-979-2349 · Spearhead' },
      { label: 'Jesus Lugo', unit: '', note: '520-260-3276 · My Way' },
      { label: 'Joshua Hardin', unit: '', note: '336-306-3380 · Gleason' },
      { label: 'Chris Rosales Jr', unit: '', note: '480-749-8089 · Rosales' },
      { label: 'Hugo/Victor Rivera', unit: '', note: '928-310-1710 · Nailed It' },
      { label: 'Hunter Mainville', unit: '', note: '480-761-5674 · EV Foam' },
      { label: 'Fidel Cruz', unit: '', note: '480-352-6432 · Amber' },
      { label: 'Rick Amaral', unit: '', note: '602-561-1325 · Superior Foam' },
      { label: 'Travis Witt', unit: '', note: '602-908-6884 · Next Gen' },
    ],
  },
];

const SYSTEM_DOCUMENTS = [
  {
    id: 'takeoff',
    name: 'Take-off / Inspection Sheet',
    description: 'Roof accessories, vents, flashings, interior notes',
  },
  {
    id: 'pricing',
    name: 'Company pricing',
    description: 'Sell rates and your costs for field reference',
  },
] as const;

type TakeoffSheet = {
  roofTypeLayers: string;
  pipeJacks: string;
  turtleVents: string;
  powerAtticVents: string;
  windTurbines: string;
  ridgeVent: string;
  roofExhaustCap: string;
  hvacVent: string;
  hvacMount: string;
  chimneyFlashing: string;
  soffitOverhang: string;
  satelliteDish: string;
  electricalMast: string;
  skylights: string;
  dripEdgeGutterApron: string;
  iceAndWaterShield: string;
  valleyLiner: string;
  drywallSf: string;
  paintingSf: string;
  ceilingHeight: string;
  ceilingFans: string;
  notes: string;
};

const emptyTakeoff = (): TakeoffSheet => ({
  roofTypeLayers: '',
  pipeJacks: '',
  turtleVents: '',
  powerAtticVents: '',
  windTurbines: '',
  ridgeVent: '',
  roofExhaustCap: '',
  hvacVent: '',
  hvacMount: '',
  chimneyFlashing: '',
  soffitOverhang: '',
  satelliteDish: '',
  electricalMast: '',
  skylights: '',
  dripEdgeGutterApron: '',
  iceAndWaterShield: '',
  valleyLiner: '',
  drywallSf: '',
  paintingSf: '',
  ceilingHeight: '',
  ceilingFans: '',
  notes: '',
});

/** Lead photos: prefer Supabase Storage `url`; legacy `dataUrl` still displays. */
type LeadPhoto = {
  id: string;
  name: string;
  /** Public URL from Supabase Storage bucket `lead-photos` */
  url?: string;
  /** Legacy base64 preview (local-only older data) */
  dataUrl?: string;
  createdAt: string;
};
type PhotoReportItem = {
  photoId: string;
  caption: string;
};
type PhotoReport = {
  id: string;
  title: string;
  createdAt: string;
  items: PhotoReportItem[];
};


/** Lead documents: PDFs and files in Supabase Storage bucket `lead-docs`. */
type LeadDocument = {
  id: string;
  name: string;
  url: string;
  size?: number;
  mimeType?: string;
  createdAt: string;
};

/** Soft-deleted lead media on a single lead (legacy; prefer AppTrashItem). */
type LeadTrashItem = {
  id: string;
  kind: 'photo' | 'document' | 'measurement';
  deletedAt: string;
  photo?: LeadPhoto;
  document?: LeadDocument;
};

/** App-wide trash: whole leads + media soft-deletes. */
type AppTrashItem =
  | {
      id: string;
      kind: 'lead';
      deletedAt: string;
      lead: Lead;
    }
  | {
      id: string;
      kind: 'photo';
      deletedAt: string;
      leadId: number;
      leadLabel: string;
      photo: LeadPhoto;
    }
  | {
      id: string;
      kind: 'document' | 'measurement';
      deletedAt: string;
      leadId: number;
      leadLabel: string;
      document: LeadDocument;
    }
  | {
      id: string;
      kind: 'roofMeasurement';
      deletedAt: string;
      leadId: number;
      leadLabel: string;
      measurement: RoofMeasurement;
    }
  | {
      id: string;
      kind: 'estimate';
      deletedAt: string;
      leadId: number;
      leadLabel: string;
      estimate: Estimate;
    }
  | {
      id: string;
      kind: 'note';
      deletedAt: string;
      leadId: number;
      leadLabel: string;
      note: LeadNote;
    };

/** Pricing region for multi-area sell rates (price_sheet.region). */
type PricingRegion = 'central' | 'southern' | 'northern';

/** Mitigation line from Supabase mitigation_price_sheet */
type MitigationPriceRow = {
  item_key: string;
  label: string;
  category: string;
  unit: string;
  insurance_rate: number | null;
  cash_retail: number | null;
};

type MitigationEntity = 'rosalie' | 'prowest';

type MitigationLineItem = {
  id: string;
  itemKey: string;
  label: string;
  qty: number;
  unitPrice: number;
  amount: number;
};

type MitigationInvoiceDraft = {
  entity: MitigationEntity;
  rateMode: 'insurance' | 'cash';
  invoiceFor: string;
  location: string;
  job: string;
  claimNumber: string;
  date: string;
  lines: MitigationLineItem[];
  notes: string;
};

const VALLEY_CITIES = [
  'phoenix',
  'mesa',
  'chandler',
  'gilbert',
  'tempe',
  'scottsdale',
  'glendale',
  'peoria',
  'surprise',
  'avondale',
  'goodyear',
  'buckeye',
  'el mirage',
  'litchfield park',
  'tolleson',
  'youngtown',
  'sun city',
  'sun city west',
  'sun lakes',
  'queen creek',
  'san tan valley',
  'apache junction',
  'fountain hills',
  'paradise valley',
  'cave creek',
  'carefree',
  'anthem',
  'new river',
  'desert hills',
  'rio verde',
  'guadalupe',
  'komatke',
  'maricopa',
  'casa grande',
  'coolidge',
  'florence',
  'aj',
  'ahwatukee',
];

const TUCSON_CITIES = [
  'tucson',
  'oro valley',
  'marana',
  'sahuarita',
  'green valley',
  'vail',
  'catalina',
  'flowing wells',
  'south tucson',
  'sierra vista',
  'benson',
  'willcox',
  'douglas',
  'nogales',
  'rio rico',
  'corona de tucson',
  'picture rocks',
  'valencia west',
  'drexel heights',
  'three points',
];

const NORTH_CITIES = [
  'payson',
  'cottonwood',
  'camp verde',
  'prescott',
  'prescott valley',
  'chino valley',
  'sedona',
  'jerome',
  'flagstaff',
  'williams',
  'show low',
  'pinetop',
  'lakeside',
  'springerville',
  'eagar',
  'holbrook',
  'winslow',
  'page',
  'wickenburg',
  'congress',
  'yarnell',
  'dewey',
  'humboldt',
  'mayer',
  'crown king',
  'pine',
  'strawberry',
  'star valley',
  'christopher creek',
  'heber',
  'overgaard',
  'snowflake',
  'taylor',
  'clarkdale',
  'cornville',
];

/** Map DB / legacy region strings onto PricingRegion. */
function normalizePricingRegion(raw?: string | null): PricingRegion {
  const r = String(raw || 'central')
    .toLowerCase()
    .trim();
  if (r === 'phx' || r === 'central' || r === 'valley' || r === 'phoenix') {
    return 'central';
  }
  if (r === 'tuc' || r === 'southern' || r === 'tucson') return 'southern';
  if (r === 'north' || r === 'northern') return 'northern';
  return 'central';
}

function resolvePricingRegion(
  city?: string,
  state?: string,
  zip?: string
): PricingRegion {
  const c = (city || '').trim().toLowerCase();
  const st = (state || '').trim().toLowerCase();
  if (st && st !== 'az' && st !== 'arizona') return 'central';
  if (!c) {
    const z = (zip || '').trim();
    if (/^85[67]/.test(z)) return 'southern';
    if (/^86[0-4]/.test(z)) return 'northern';
    return 'central';
  }
  const cityHit = (list: string[]) =>
    list.some((x) => c === x || c.includes(x) || x.includes(c));
  if (cityHit(VALLEY_CITIES)) return 'central';
  if (cityHit(TUCSON_CITIES)) return 'southern';
  if (cityHit(NORTH_CITIES)) return 'northern';
  const z = (zip || '').trim();
  if (/^85[0-3]/.test(z) || /^852\d{2}$/.test(z) || /^853\d{2}$/.test(z)) {
    return 'central';
  }
  if (/^85[6-7]/.test(z)) return 'southern';
  if (/^86[0-4]/.test(z)) return 'northern';
  return 'central';
}

const REGION_LABEL: Record<PricingRegion, string> = {
  central: 'Central',
  southern: 'Southern',
  northern: 'Northern',
};

/** Single 6-stage pipeline used on home, kanban, and lead profile. */
type PipelineStage =
  | 'Lead'
  | 'Prospect'
  | 'Approved'
  | 'Completed'
  | 'Invoiced'
  | 'Closed';

const PIPELINE_STAGES: PipelineStage[] = [
  'Lead',
  'Prospect',
  'Approved',
  'Completed',
  'Invoiced',
  'Closed',
];

/**
 * Home + Leads: matte chrome cards; small colored stage dots for character.
 * Lead amber · Prospect orange · Approved emerald · Completed blue · Invoiced amber · Closed emerald
 */
const PIPELINE_STAGE_STYLES: Record<
  PipelineStage,
  {
    card: string;
    count: string;
    label: string;
    column: string;
    header: string;
    pill: string;
    badge: string;
    /** Colored dot next to stage label */
    dash: string;
    ring: string;
    cardAccent: string;
  }
> = {
  Lead: {
    card: 'bg-white border-zinc-200 hover:border-amber-300/70 hover:shadow-sm transition-all',
    count: 'text-zinc-900',
    label: 'text-zinc-500',
    column: 'bg-zinc-100 border-zinc-200',
    header: 'text-zinc-900',
    pill: 'bg-white border-zinc-200 text-zinc-600',
    badge: 'bg-amber-50 text-amber-800 border-amber-100',
    dash: 'bg-amber-400',
    ring: 'ring-amber-300/50',
    cardAccent: '',
  },
  Prospect: {
    card: 'bg-white border-zinc-200 hover:border-orange-300/70 hover:shadow-sm transition-all',
    count: 'text-zinc-900',
    label: 'text-zinc-500',
    column: 'bg-zinc-100 border-zinc-200',
    header: 'text-zinc-900',
    pill: 'bg-white border-zinc-200 text-zinc-600',
    badge: 'bg-orange-50 text-orange-800 border-orange-100',
    dash: 'bg-orange-400',
    ring: 'ring-orange-300/50',
    cardAccent: '',
  },
  Approved: {
    card: 'bg-white border-zinc-200 hover:border-sky-300/70 hover:shadow-sm transition-all',
    count: 'text-zinc-900',
    label: 'text-zinc-500',
    column: 'bg-zinc-100/80 border-zinc-200',
    header: 'text-zinc-900',
    pill: 'bg-white border-zinc-200 text-zinc-600',
    badge: 'bg-emerald-50 text-emerald-800 border-emerald-100',
    dash: 'bg-emerald-500',
    ring: 'ring-emerald-300/50',
    cardAccent: '',
  },
  Completed: {
    card: 'bg-white border-zinc-200 hover:border-sky-300/70 hover:shadow-sm transition-all',
    count: 'text-zinc-900',
    label: 'text-zinc-500',
    column: 'bg-zinc-100/70 border-zinc-200',
    header: 'text-zinc-900',
    pill: 'bg-white border-zinc-200 text-zinc-600',
    badge: 'bg-sky-50 text-sky-800 border-sky-100',
    dash: 'bg-sky-500',
    ring: 'ring-sky-300/50',
    cardAccent: '',
  },
  Invoiced: {
    card: 'bg-white border-zinc-200 hover:border-amber-300/70 hover:shadow-sm transition-all',
    count: 'text-zinc-900',
    label: 'text-zinc-500',
    column: 'bg-zinc-100 border-zinc-200',
    header: 'text-zinc-900',
    pill: 'bg-white border-zinc-200 text-zinc-600',
    badge: 'bg-amber-50 text-amber-900 border-amber-100',
    dash: 'bg-amber-600',
    ring: 'ring-amber-300/50',
    cardAccent: '',
  },
  Closed: {
    card: 'bg-white border-zinc-200 hover:border-sky-400/60 hover:shadow-sm transition-all',
    count: 'text-zinc-900',
    label: 'text-zinc-500',
    column: 'bg-zinc-100/80 border-zinc-300',
    header: 'text-zinc-900',
    pill: 'bg-white border-zinc-200 text-zinc-600',
    badge: 'bg-emerald-800 text-white border-emerald-800',
    dash: 'bg-emerald-700',
    ring: 'ring-emerald-400/40',
    cardAccent: '',
  },
};

type JobCategory = 'Residential' | 'Commercial' | 'Property Management';
type LeadSource =
  | 'Self Generated'
  | 'Referral'
  | 'In-House'
  | 'Yard Sign'
  | 'Social Media'
  | 'Other';

type ProfileTab =
  | 'overview'
  | 'pipeline'
  | 'measurements'
  | 'insurance'
  | 'notes'
  | 'estimates'
  | 'estimator'
  | 'photos'
  | 'documents'
  | 'takeoff'
  | 'financial';

/** Extra people on a job (spouse, co-owner, etc.) beyond primary client. */
type AdditionalContact = {
  id: string;
  firstName: string;
  lastName: string;
  /** spouse, other, … */
  relationship?: string;
  phone?: string;
  email?: string;
};

const emptyAdditionalContact = (
  overrides: Partial<AdditionalContact> = {}
): AdditionalContact => ({
  id:
    overrides.id ||
    `ac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  firstName: overrides.firstName || '',
  lastName: overrides.lastName || '',
  relationship: overrides.relationship || '',
  phone: overrides.phone || '',
  email: overrides.email || '',
});

function normalizeAdditionalContacts(raw: unknown): AdditionalContact[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, i) => {
    const c = (item && typeof item === 'object' ? item : {}) as Record<
      string,
      unknown
    >;
    return emptyAdditionalContact({
      id: String(c.id ?? `ac-${i}`),
      firstName: String(c.firstName ?? c.first_name ?? ''),
      lastName: String(c.lastName ?? c.last_name ?? ''),
      relationship: String(c.relationship ?? ''),
      phone: String(c.phone ?? ''),
      email: String(c.email ?? ''),
    });
  });
}

/** Line item inside a job financial section (change order, upgrade, etc.). */
type JobFinancialLine = {
  id: string;
  label: string;
  amount: number;
};

/** Named group of financial lines on a lead. */
type JobFinancialSection = {
  id: string;
  title: string;
  lines: JobFinancialLine[];
};

const emptyJobFinancialLine = (
  overrides: Partial<JobFinancialLine> = {}
): JobFinancialLine => ({
  id:
    overrides.id ||
    `jfl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  label: overrides.label || '',
  amount: Number(overrides.amount) || 0,
});

const emptyJobFinancialSection = (
  overrides: Partial<JobFinancialSection> = {}
): JobFinancialSection => ({
  id:
    overrides.id ||
    `jfs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  title: overrides.title || '',
  lines: Array.isArray(overrides.lines)
    ? overrides.lines.map((l) => emptyJobFinancialLine(l))
    : [],
});

function normalizeJobFinancialSections(raw: unknown): JobFinancialSection[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, i) => {
    const s = (item && typeof item === 'object' ? item : {}) as Record<
      string,
      unknown
    >;
    const linesRaw = Array.isArray(s.lines) ? s.lines : [];
    return emptyJobFinancialSection({
      id: String(s.id ?? `jfs-${i}`),
      title: String(s.title ?? ''),
      lines: linesRaw.map((line, j) => {
        const l = (line && typeof line === 'object' ? line : {}) as Record<
          string,
          unknown
        >;
        return emptyJobFinancialLine({
          id: String(l.id ?? `jfl-${i}-${j}`),
          label: String(l.label ?? ''),
          amount: Number(l.amount) || 0,
        });
      }),
    });
  });
}

/** balanceDue = approvedJobValue − collected */
function jobBalanceDue(lead: {
  financialWorksheet?: unknown;
  approvedJobValue?: number;
  collected?: number;
  sections?: unknown;
}): number {
  const fw = resolveFinancialWorksheet(lead);
  return Math.max(0, (fw.approvedJobValue || 0) - (fw.collected || 0));
}

/** Sum of all section line amounts (optional cross-check vs approvedJobValue). */
function jobSectionsTotal(sections?: JobFinancialSection[]): number {
  if (!sections?.length) return 0;
  return sections.reduce(
    (sum, sec) =>
      sum +
      (sec.lines || []).reduce((s, line) => s + (Number(line.amount) || 0), 0),
    0
  );
}

const newFinId = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** AccuLynx-style job financial worksheet (sections + approved / collected). */
type FinancialWorksheet = {
  sections: JobFinancialSection[];
  approvedJobValue: number;
  collected: number;
  notes?: string;
};

function worksheetGrandTotal(w: FinancialWorksheet): number {
  return jobSectionsTotal(w.sections);
}

/** Keep approved job value locked to worksheet grand total. */
function withAutoApproved(w: FinancialWorksheet): FinancialWorksheet {
  return {
    ...w,
    approvedJobValue: worksheetGrandTotal(w),
  };
}

const emptyFinancialWorksheet = (): FinancialWorksheet => ({
  sections: [],
  approvedJobValue: 0,
  collected: 0,
  notes: '',
});

const normalizeFinancialWorksheet = (raw: unknown): FinancialWorksheet => {
  if (!raw || typeof raw !== 'object') return emptyFinancialWorksheet();
  const r = raw as Record<string, unknown>;

  // Legacy flat lines → one section
  if (Array.isArray(r.lines) && !Array.isArray(r.sections)) {
    const lines = (r.lines as unknown[]).map((line, j) => {
      const l = (line && typeof line === 'object' ? line : {}) as Record<
        string,
        unknown
      >;
      return emptyJobFinancialLine({
        id: String(l.id ?? `jfl-legacy-${j}`),
        label: String(l.label ?? ''),
        amount: Number(l.amount) || 0,
      });
    });
    return {
      sections: lines.length
        ? [{ id: newFinId(), title: 'Worksheet', lines }]
        : [],
      approvedJobValue: Number(r.jobValue ?? r.approvedJobValue) || 0,
      collected: Number(r.collected) || 0,
      notes: String(r.notes ?? ''),
    };
  }

  return {
    sections: normalizeJobFinancialSections(r.sections),
    approvedJobValue: Number(r.approvedJobValue ?? r.jobValue) || 0,
    collected: Number(r.collected) || 0,
    notes: String(r.notes ?? ''),
  };
};

/** Prefer worksheet.approvedJobValue; fall back to flat lead fields. */
function resolveFinancialWorksheet(lead: {
  financialWorksheet?: unknown;
  sections?: unknown;
  approvedJobValue?: number;
  collected?: number;
}): FinancialWorksheet {
  if (lead.financialWorksheet != null) {
    return normalizeFinancialWorksheet(lead.financialWorksheet);
  }
  // Migrate older flat fields on the lead
  if (
    Array.isArray(lead.sections) ||
    lead.approvedJobValue != null ||
    lead.collected != null
  ) {
    return normalizeFinancialWorksheet({
      sections: lead.sections,
      approvedJobValue: lead.approvedJobValue,
      collected: lead.collected,
    });
  }
  return emptyFinancialWorksheet();
}

type Lead = {
  id: number;
  date: string;
  clientFirstName: string;
  clientLastName: string;
  clientAddress: string;
  clientCity: string;
  clientState: string;
  clientZip: string;
  clientPhone: string;
  clientEmail: string; // primary email
  additionalEmails?: string[];
  /** Spouse / co-owner / other contacts on this job */
  additionalContacts?: AdditionalContact[];
  /**
   * Job financials: sections/lines worksheet + approved value + collected.
   * balanceDue = approvedJobValue − collected.
   */
  financialWorksheet?: FinancialWorksheet;
  /** @deprecated prefer financialWorksheet — kept for localStorage migration */
  sections?: JobFinancialSection[];
  /** @deprecated prefer financialWorksheet */
  approvedJobValue?: number;
  /** @deprecated prefer financialWorksheet */
  collected?: number;
  company?: string;
  jobNumber: string;
  mailingSameAsBilling: boolean;
  billingAddress?: string;
  billingCity?: string;
  billingState?: string;
  billingZip?: string;
  jobCategory: JobCategory;
  hasHOA: boolean;
  hoaInfo?: string;
  leadSource: LeadSource;
  referralName?: string;
  insuranceCompany?: string;
  damageLocation?: string;
  dateOfLoss?: string;
  claimFiled: boolean;
  adjusterName?: string;
  adjusterPhone?: string;
  adjusterEmail?: string;
  metAdjuster: boolean;
  claimNumber?: string;
  policyNumber?: string;
  /** Pipeline stage: Lead → Prospect → Approved → Completed → Invoiced → Closed */
  category: PipelineStage;
  estimates: Estimate[];
  notes?: LeadNote[];
  photos?: LeadPhoto[];
  photoReports?: PhotoReport[];
  documents?: LeadDocument[];
  /** EagleView / Roofr PDFs uploaded from Measurements */
  measurementReports?: LeadDocument[];
  /** Soft-deleted photos / documents / measurement reports */
  trash?: LeadTrashItem[];
  /** Site inspection take-off sheet */
  takeoff?: TakeoffSheet | null;
  measurements?: RoofMeasurement[];
  /** Optional scheduled follow-up (YYYY-MM-DD) — used for Google Calendar sync */
  followUpDate?: string;
  /** Google Calendar event id after sync */
  calendarEventId?: string;
  calendarHtmlLink?: string;
  calendarSyncedAt?: string;
  /** Supabase `leads.id` (uuid) when synced to cloud */
  supabaseId?: string;
};

/**
 * Pipeline / Home stage $ totals.
 * Job value comes ONLY from the financial worksheet — never from estimates on file.
 */
function leadEstimateValue(lead: {
  financialWorksheet?: { approvedJobValue?: number; jobValue?: number };
  approvedJobValue?: number;
  sections?: unknown;
  collected?: number;
}): number {
  const w = resolveFinancialWorksheet(lead);
  const v = Number(w.approvedJobValue ?? 0);
  return v > 0 ? v : 0;
}

/** Map current + legacy kanban labels onto the 6-stage pipeline. */
function normalizePipelineStage(raw: unknown): PipelineStage {
  if (typeof raw !== 'string') return 'Lead';
  if ((PIPELINE_STAGES as string[]).includes(raw)) return raw as PipelineStage;
  const legacy: Record<string, PipelineStage> = {
    'New Lead': 'Lead',
    'Follow Up': 'Prospect',
    Quoted: 'Approved',
    Closed: 'Closed',
  };
  return legacy[raw] ?? 'Lead';
}

/** Normalize legacy localStorage leads (e.g. clientJobNumber → jobNumber). */
function normalizeLead(raw: Partial<Lead> & { clientJobNumber?: string }): Lead {
  return {
    id: raw.id ?? Date.now(),
    date: raw.date ?? new Date().toLocaleDateString(),
    clientFirstName: raw.clientFirstName ?? '',
    clientLastName: raw.clientLastName ?? '',
    clientAddress: raw.clientAddress ?? '',
    clientCity: raw.clientCity ?? '',
    clientState: raw.clientState ?? '',
    clientZip: raw.clientZip ?? '',
    clientPhone: raw.clientPhone ?? '',
    clientEmail: raw.clientEmail ?? '',
    additionalEmails: raw.additionalEmails ?? [],
    additionalContacts: normalizeAdditionalContacts(raw.additionalContacts),
    financialWorksheet: resolveFinancialWorksheet(raw),
    company: raw.company ?? '',
    jobNumber: raw.jobNumber ?? raw.clientJobNumber ?? '',
    mailingSameAsBilling: raw.mailingSameAsBilling ?? true,
    billingAddress: raw.billingAddress ?? '',
    billingCity: raw.billingCity ?? '',
    billingState: raw.billingState ?? '',
    billingZip: raw.billingZip ?? '',
    jobCategory: raw.jobCategory ?? 'Residential',
    hasHOA: raw.hasHOA ?? false,
    hoaInfo: raw.hoaInfo ?? '',
    leadSource: raw.leadSource ?? 'Self Generated',
    referralName: raw.referralName ?? '',
    insuranceCompany: raw.insuranceCompany ?? '',
    damageLocation: raw.damageLocation ?? '',
    dateOfLoss: raw.dateOfLoss ?? '',
    claimFiled: raw.claimFiled ?? false,
    adjusterName: raw.adjusterName ?? '',
    adjusterPhone: raw.adjusterPhone ?? '',
    adjusterEmail: raw.adjusterEmail ?? '',
    metAdjuster: raw.metAdjuster ?? false,
    claimNumber: raw.claimNumber ?? '',
    policyNumber: raw.policyNumber ?? '',
    // Prefer explicit category; fall back to legacy `milestone` if present
    category: normalizePipelineStage(
      raw.category ?? (raw as { milestone?: unknown }).milestone
    ),
    estimates: raw.estimates ?? [],
    notes: raw.notes ?? [],
    photos: raw.photos ?? [],
    photoReports: raw.photoReports ?? [],
    documents: raw.documents ?? [],
    measurementReports: raw.measurementReports ?? [],
    trash: Array.isArray(raw.trash) ? (raw.trash as LeadTrashItem[]) : [],
    takeoff:
      raw.takeoff && typeof raw.takeoff === 'object'
        ? { ...emptyTakeoff(), ...raw.takeoff }
        : null,
    measurements: Array.isArray(raw.measurements)
      ? (raw.measurements
          .map((m) => normalizeMeasurement(m as Partial<RoofMeasurement>))
          .filter(Boolean) as RoofMeasurement[])
      : [],
    followUpDate: raw.followUpDate ?? '',
    calendarEventId: raw.calendarEventId,
    calendarHtmlLink: raw.calendarHtmlLink,
    calendarSyncedAt: raw.calendarSyncedAt,
    supabaseId: raw.supabaseId,
  };
}

function createEmptyLead(overrides: Partial<Lead> = {}): Lead {
  return normalizeLead({
    id: Date.now(),
    date: new Date().toLocaleDateString(),
    category: 'Lead',
    mailingSameAsBilling: true,
    jobCategory: 'Residential',
    hasHOA: false,
    leadSource: 'Self Generated',
    claimFiled: false,
    metAdjuster: false,
    estimates: [],
    notes: [],
    photos: [],
    documents: [],
    measurementReports: [],
    trash: [],
    measurements: [],
    photoReports: [],
    ...overrides,
  });
}

/** Convert app Lead → payload for Supabase `leads` table */
function mapAppLeadToDb(lead: Lead) {
  const name =
    [lead.clientFirstName, lead.clientLastName].filter(Boolean).join(' ').trim() ||
    'New Lead';
  const addressParts = [
    lead.clientAddress,
    lead.clientCity,
    lead.clientState,
    lead.clientZip,
  ].filter(Boolean);
  const addressStr = addressParts.join(', ');

  const notesText =
    Array.isArray(lead.notes) && lead.notes.length > 0
      ? lead.notes.map((n) => n.text || '').filter(Boolean).join('\n')
      : '';

  /** Extra profile fields stored as JSON (columns optional on server) */
  const details = {
    clientFirstName: lead.clientFirstName || '',
    clientLastName: lead.clientLastName || '',
    clientAddress: lead.clientAddress || '',
    clientCity: lead.clientCity || '',
    clientState: lead.clientState || '',
    clientZip: lead.clientZip || '',
    clientPhone: lead.clientPhone || '',
    clientEmail: lead.clientEmail || '',
    additionalEmails: lead.additionalEmails || [],
    additionalContacts: lead.additionalContacts || [],
    financialWorksheet: resolveFinancialWorksheet(lead),
    mailingSameAsBilling: lead.mailingSameAsBilling ?? true,
    billingAddress: lead.billingAddress || '',
    billingCity: lead.billingCity || '',
    billingState: lead.billingState || '',
    billingZip: lead.billingZip || '',
    jobCategory: lead.jobCategory || 'Residential',
    hasHOA: !!lead.hasHOA,
    hoaInfo: lead.hoaInfo || '',
    leadSource: lead.leadSource || '',
    referralName: lead.referralName || '',
    insuranceCompany: lead.insuranceCompany || '',
    damageLocation: lead.damageLocation || '',
    dateOfLoss: lead.dateOfLoss || '',
    claimFiled: !!lead.claimFiled,
    adjusterName: lead.adjusterName || '',
    adjusterPhone: lead.adjusterPhone || '',
    adjusterEmail: lead.adjusterEmail || '',
    metAdjuster: !!lead.metAdjuster,
    claimNumber: lead.claimNumber || '',
    policyNumber: lead.policyNumber || '',
    photos: lead.photos,
    photoReports: lead.photoReports || [],
    documents: lead.documents,
    measurementReports: lead.measurementReports || [],
    trash: lead.trash || [],
    takeoff: lead.takeoff || null,
    followUpDate: lead.followUpDate || '',
    calendarEventId: lead.calendarEventId || '',
    calendarHtmlLink: lead.calendarHtmlLink || '',
    calendarSyncedAt: lead.calendarSyncedAt || '',
    // estimates live in `estimates` table; keep a denormalized copy in details if useful
    estimates: lead.estimates || [],
  };

  return {
    name,
    company: lead.company || null,
    phone: lead.clientPhone || null,
    addresses: addressStr ? [addressStr] : [],
    emails: lead.clientEmail ? [lead.clientEmail] : [],
    stage: lead.category || 'Lead',
    source: lead.leadSource || null,
    hoa: lead.hasHOA ? lead.hoaInfo || 'Yes' : null,
    notes: notesText || null,
    measurements: lead.measurements || [],
    job_number: lead.jobNumber || null,
    details,
    updated_at: new Date().toISOString(),
  };
}

/** Stable numeric id from Supabase UUID / number */
function stableLeadIdFromDb(id: unknown): number {
  if (typeof id === 'number' && Number.isFinite(id)) return id;
  if (typeof id === 'string' && /^\d+$/.test(id)) return parseInt(id, 10);
  const s = String(id ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || Date.now();
}

/**
 * Map a row from the Supabase `leads` table into the app Lead shape.
 * Expected columns (flexible): id, name, phone, emails, addresses, company,
 * stage, notes, created_at — adjust if your schema differs.
 */
function mapDbLeadToApp(row: Record<string, unknown>): Lead {
  const d =
    row.details && typeof row.details === 'object'
      ? (row.details as Record<string, unknown>)
      : {};

  const fullName = String(row.name ?? row.client_name ?? '').trim();
  const nameParts = fullName ? fullName.split(/\s+/) : [];
  const firstName =
    String(
      d.clientFirstName ??
        row.client_first_name ??
        row.first_name ??
        nameParts[0] ??
        ''
    ) || 'Unknown';
  const lastName = String(
    d.clientLastName ??
      row.client_last_name ??
      row.last_name ??
      (nameParts.length > 1 ? nameParts.slice(1).join(' ') : '')
  );

  let address = String(d.clientAddress ?? '');
  let city = String(d.clientCity ?? '');
  let state = String(d.clientState ?? '');
  let zip = String(d.clientZip ?? '');
  if (!address) {
    const addresses = row.addresses;
    if (typeof addresses === 'string') {
      address = addresses;
    } else if (Array.isArray(addresses) && addresses.length > 0) {
      const first = addresses[0] as string | Record<string, unknown>;
      if (typeof first === 'string') {
        address = first;
      } else if (first && typeof first === 'object') {
        address = String(first.line1 ?? first.address ?? first.street ?? '');
        city = city || String(first.city ?? '');
        state = state || String(first.state ?? '');
        zip = zip || String(first.zip ?? first.postal_code ?? '');
      }
    } else {
      address = String(row.address ?? row.client_address ?? '');
      city = city || String(row.city ?? row.client_city ?? '');
      state = state || String(row.state ?? row.client_state ?? '');
      zip = zip || String(row.zip ?? row.client_zip ?? '');
    }
  }

  let email = String(d.clientEmail ?? '');
  if (!email) {
    const emails = row.emails;
    if (typeof emails === 'string') {
      email = emails;
    } else if (Array.isArray(emails) && emails.length > 0) {
      const first = emails[0] as string | Record<string, unknown>;
      email =
        typeof first === 'string'
          ? first
          : String((first as Record<string, unknown>)?.email ?? '');
    } else {
      email = String(row.email ?? row.client_email ?? '');
    }
  }

  const stageRaw = String(row.stage ?? row.category ?? row.pipeline_stage ?? '');
  const stageMap: Record<string, PipelineStage> = {
    'New Lead': 'Lead',
    Lead: 'Lead',
    'Follow Up': 'Prospect',
    Prospect: 'Prospect',
    Quoted: 'Approved',
    Approved: 'Approved',
    Completed: 'Completed',
    Invoiced: 'Invoiced',
    Closed: 'Closed',
  };
  const category =
    stageMap[stageRaw] || normalizePipelineStage(stageRaw) || 'Lead';

  const createdAt = row.created_at ?? row.createdAt;
  const noteText = row.notes;
  let notes: LeadNote[] = [];
  if (typeof noteText === 'string' && noteText.trim()) {
    notes = [
      {
        text: noteText.trim(),
        date: createdAt
          ? new Date(String(createdAt)).toLocaleDateString()
          : new Date().toLocaleDateString(),
      },
    ];
  } else if (Array.isArray(d.notes)) {
    notes = (d.notes as LeadNote[]).map((n) => ({
      text: String(n?.text ?? ''),
      date: String(n?.date ?? ''),
    }));
  }

  const dbId = row.id != null ? String(row.id) : undefined;

  return normalizeLead({
    id: stableLeadIdFromDb(row.id),
    clientFirstName: firstName,
    clientLastName: lastName,
    clientAddress: address,
    clientCity: city,
    clientState: state,
    clientZip: zip,
    clientPhone: String(d.clientPhone ?? row.phone ?? row.client_phone ?? ''),
    clientEmail: email,
    company: String(row.company ?? d.company ?? ''),
    jobNumber: String(row.job_number ?? d.jobNumber ?? row.jobNumber ?? ''),
    additionalEmails: Array.isArray(d.additionalEmails)
      ? (d.additionalEmails as string[])
      : [],
    additionalContacts: normalizeAdditionalContacts(d.additionalContacts),
    financialWorksheet: resolveFinancialWorksheet({
      financialWorksheet: d.financialWorksheet,
      sections: d.sections as JobFinancialSection[] | undefined,
      approvedJobValue: Number(d.approvedJobValue) || 0,
      collected: Number(d.collected) || 0,
    }),
    mailingSameAsBilling: d.mailingSameAsBilling !== false,
    billingAddress: String(d.billingAddress ?? ''),
    billingCity: String(d.billingCity ?? ''),
    billingState: String(d.billingState ?? ''),
    billingZip: String(d.billingZip ?? ''),
    jobCategory: (d.jobCategory as JobCategory) || 'Residential',
    hasHOA: Boolean(d.hasHOA ?? row.hoa),
    hoaInfo: String(d.hoaInfo ?? row.hoa ?? ''),
    leadSource: (d.leadSource as LeadSource) ||
      (String(row.source || 'Self Generated') as LeadSource),
    referralName: String(d.referralName ?? ''),
    insuranceCompany: String(d.insuranceCompany ?? ''),
    damageLocation: String(d.damageLocation ?? ''),
    dateOfLoss: String(d.dateOfLoss ?? ''),
    claimFiled: Boolean(d.claimFiled),
    adjusterName: String(d.adjusterName ?? ''),
    adjusterPhone: String(d.adjusterPhone ?? ''),
    adjusterEmail: String(d.adjusterEmail ?? ''),
    metAdjuster: Boolean(d.metAdjuster),
    claimNumber: String(d.claimNumber ?? ''),
    policyNumber: String(d.policyNumber ?? ''),
    category,
    notes,
    photos: Array.isArray(d.photos) ? (d.photos as LeadPhoto[]) : [],
    photoReports: Array.isArray((d as any).photoReports)
      ? (d as any).photoReports
      : [],
    documents: Array.isArray(d.documents) ? (d.documents as LeadDocument[]) : [],
    measurementReports: Array.isArray((d as any).measurementReports)
      ? ((d as any).measurementReports as LeadDocument[])
      : [],
    trash: Array.isArray((d as any).trash)
      ? ((d as any).trash as LeadTrashItem[])
      : [],
    takeoff:
      d.takeoff && typeof d.takeoff === 'object'
        ? { ...emptyTakeoff(), ...(d.takeoff as TakeoffSheet) }
        : null,
    measurements: Array.isArray(row.measurements)
      ? (row.measurements as RoofMeasurement[])
      : Array.isArray(d.measurements)
        ? (d.measurements as RoofMeasurement[])
        : [],
    // Prefer estimates from estimates table (bootstrap attaches them); details is fallback
    estimates: Array.isArray(d.estimates) ? (d.estimates as Estimate[]) : [],
    followUpDate: String(d.followUpDate ?? ''),
    calendarEventId: d.calendarEventId
      ? String(d.calendarEventId)
      : undefined,
    calendarHtmlLink: d.calendarHtmlLink
      ? String(d.calendarHtmlLink)
      : undefined,
    calendarSyncedAt: d.calendarSyncedAt
      ? String(d.calendarSyncedAt)
      : undefined,
    date: createdAt
      ? new Date(String(createdAt)).toLocaleDateString()
      : new Date().toLocaleDateString(),
    supabaseId: dbId,
  });
}

const PITCH_MULTIPLIERS: Record<string, number> = {
  Flat: 1.0,
  '2/12': 1.02,
  '3/12': 1.03,
  '4/12': 1.054,
  '5/12': 1.08,
  '6/12': 1.118,
  '7/12': 1.16,
  '8/12': 1.202,
  '9/12': 1.25,
  '10/12': 1.302,
  '11/12': 1.36,
  '12/12': 1.414,
};

export default function SummitApp() {
  /** Supabase client from env (NEXT_PUBLIC_SUPABASE_*). Null if not configured. */
  const supabase = useMemo(() => getSupabase(), []);
  const supabaseEnabled = isSupabaseConfigured() && supabase != null;

  // TEMP TEST - remove later
  useEffect(() => {
    console.log('Supabase test - configured?', isSupabaseConfigured());
    console.log('Supabase client?', getSupabase() ? 'yes' : 'no');
  }, []);

  /** False until localStorage is read — keeps SSR and first client paint identical */
  const [sessionReady, setSessionReady] = useState(false);
  const [activeTab, setActiveTab] = useState<AppTab>('home');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const skipUnsavedMarkRef = useRef(false);
  /**
   * Lead we opened the estimator from — used to return without losing context.
   * Draft lead data is persisted before leaving the profile.
   */
  const [estimatorSourceLeadId, setEstimatorSourceLeadId] = useState<number | null>(
    null
  );
  /** Latest tab for dirty-tracking effect without listing activeTab as a dep */
  const activeTabRef = useRef(activeTab);
  const negotiatedPriceRef = useRef(0);
  const originalTotalForBufferRef = useRef(0);
  const [showProfessionalEstimate, setShowProfessionalEstimate] = useState(false);
  const [showCostBreakdown, setShowCostBreakdown] = useState(false);
  const [estimatorTotalPrice, setEstimatorTotalPrice] = useState(0);
  /** Estimate form vs Internal calc (buffer / commission) — only when estimator is open. */
  const [estimateWorkspace, setEstimateWorkspace] =
    useState<EstimateWorkspace>('estimate');
  const [negotiatedPrice, setNegotiatedPrice] = useState(0);
  const [originalTotalForBuffer, setOriginalTotalForBuffer] = useState(0);
  const [roofSystem, setRoofSystem] = useState<RoofSystem>('shingle');
  const [flatSystem, setFlatSystem] = useState<FlatSystem>('');
  const [coatingKind, setCoatingKind] = useState<CoatingKind>('');
  const [foamKind, setFoamKind] = useState<FoamKind>('');

  const [foamIso48, setFoamIso48] = useState(''); // 4x8 sheet count
  const [foamIso44, setFoamIso44] = useState(''); // 4x4 sheet count
  const [foamGranules, setFoamGranules] = useState(false);
  const [foamExtraSpf, setFoamExtraSpf] = useState(false);
  const [foamScarify, setFoamScarify] = useState(false);
  const [coatingExtraPass, setCoatingExtraPass] = useState(false);
  const [coatingPressureWash, setCoatingPressureWash] = useState(false);
  const [estimateFlow, setEstimateFlow] = useState<'pick' | 'estimate'>('pick');
  const [lowSlopeMode, setLowSlopeMode] = useState<
    'none' | 'attached' | 'detached'
  >('none');
  const [lowSlopeType, setLowSlopeType] = useState<
    | 'none'
    | 'mod_bitumen'
    | 'full_foam'
    | 'coating'
    | 'elastomeric'
    | 'silicone'
    | 'urethane'
  >('none');
  const [selectedShingle, setSelectedShingle] = useState<ShingleType>('');
  const [productColors, setProductColors] = useState<Record<string, string>>({});
  const [cambridgeColor, setCambridgeColor] = useState('');
  const [dynastyColor, setDynastyColor] = useState('');
  const [armourshakeColor, setArmourshakeColor] = useState('');
  const [selectedUnderlayment, setSelectedUnderlayment] = useState<Underlayment>('');
  const [tileMode, setTileMode] = useState<'dr' | 'rr' | ''>('');
  const [tileProduct, setTileProduct] = useState('');
  const [tileBrand, setTileBrand] = useState('');
  const [currentTile, setCurrentTile] = useState('');
  const [fasciaMode, setFasciaMode] = useState<FasciaMode>('');
  const [deckingMode, setDeckingMode] = useState<DeckingMode>('');
  const [fasciaType, setFasciaType] = useState<FasciaType>('');
  const [stories, setStories] = useState<'1' | '2' | ''>('');
  const [squares, setSquares] = useState('');
  const [layers, setLayers] = useState('');
  const [waste, setWaste] = useState('');
  const [pitch, setPitch] = useState('');
  const [fasciaLF, setFasciaLF] = useState('');
  const [deckingSheets, setDeckingSheets] = useState('');
  const [deckingOsbSheets, setDeckingOsbSheets] = useState('');
  const [deckingCdxSheets, setDeckingCdxSheets] = useState('');
  const [solarPanels, setSolarPanels] = useState('');
  const [hvacUnits, setHvacUnits] = useState('');
  const [skylights, setSkylights] = useState('');
  const [ridgeVentLF, setRidgeVentLF] = useState('');
  const [gutterMode, setGutterMode] = useState<'none' | 'dr' | 'rr'>('none');
  const [gutterLF, setGutterLF] = useState('');
  const [notes, setNotes] = useState('');
  const [leadNoteDraft, setLeadNoteDraft] = useState('');
  const [isEditingLead, setIsEditingLead] = useState(false);
  const [profileTab, setProfileTab] = useState<ProfileTab>('overview');
  const [takeoffForm, setTakeoffForm] = useState<TakeoffSheet>(emptyTakeoff());
  const [photoDragOver, setPhotoDragOver] = useState(false);
  const [photosUploading, setPhotosUploading] = useState(false);
  const [docsUploading, setDocsUploading] = useState(false);
  const [docAddMenuOpen, setDocAddMenuOpen] = useState(false);
  const [systemDocPreview, setSystemDocPreview] = useState<string | null>(null);
  const [systemDocWorkspace, setSystemDocWorkspace] = useState<
    null | 'takeoff' | 'pricing'
  >(null);
  const [takeoffAssignOpen, setTakeoffAssignOpen] = useState(false);
  const [takeoffAssignSearch, setTakeoffAssignSearch] = useState('');
  const [lightboxPhoto, setLightboxPhoto] = useState<LeadPhoto | null>(null);
  const [measurementPdfUrl, setMeasurementPdfUrl] = useState<string | null>(null);
  const [measurementPdfName, setMeasurementPdfName] = useState('');
  const measurementFileRef = useRef<HTMLInputElement | null>(null);
  const [photoReportOpen, setPhotoReportOpen] = useState(false);
  const [photoReportTitle, setPhotoReportTitle] = useState('Photo Report');
  const [photoReportSelected, setPhotoReportSelected] = useState<string[]>([]);
  const [photoReportCaptions, setPhotoReportCaptions] = useState<Record<string, string>>({});
  const [photoReportBusy, setPhotoReportBusy] = useState(false);
  const [dragLeadId, setDragLeadId] = useState<number | null>(null);
  const [dragOverStage, setDragOverStage] = useState<PipelineStage | null>(null);
  const suppressCardClickRef = useRef(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const photoCameraInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  /** Measurement tracer draft (profile tab) */
  const [tracePoints, setTracePoints] = useState<LatLngPoint[]>([]);
  const [measurePitch, setMeasurePitch] = useState('6/12');
  const [measureWaste, setMeasureWaste] = useState(0.1);
  const [measureWasteAuto, setMeasureWasteAuto] = useState(true);
  const [measureLabel, setMeasureLabel] = useState('');
  const [measurePitchAuto, setMeasurePitchAuto] = useState(true);
  /** Pitched or flat for the current trace */
  const [sectionKind, setSectionKind] = useState<RoofSectionKind>('pitched');
  /** Always-current kind for map callbacks (avoids stale closure on polygon complete) */
  const sectionKindRef = useRef<RoofSectionKind>(sectionKind);
  /** Sections committed this session (any order) before final Save */
  const [draftSections, setDraftSections] = useState<RoofSection[]>([]);
  const [selectedMeasurementId, setSelectedMeasurementId] = useState<string | null>(null);
  const [showTracer, setShowTracer] = useState(false);
  const [activeMeasurementId, setActiveMeasurementId] = useState<string | null>(null);
  const [mapCenter, setMapCenter] = useState<LatLngPoint | null>(null);
  const [showMeasureAddressModal, setShowMeasureAddressModal] = useState(false);
  /** Home / nav: pick a lead (or saved estimate) before opening estimator */
  const [showEstimatePicker, setShowEstimatePicker] = useState(false);
  const [estimatePickerQuery, setEstimatePickerQuery] = useState('');
  const [measureAddrStreet, setMeasureAddrStreet] = useState('');
  const [measureAddrCity, setMeasureAddrCity] = useState('');
  const [measureAddrState, setMeasureAddrState] = useState('');
  const [measureAddrZip, setMeasureAddrZip] = useState('');
  const [geocoding, setGeocoding] = useState(false);
  const [addressGeocodeFailed, setAddressGeocodeFailed] = useState(false);
  /** Bumps to force RoofTracer remount + clear previous house/trace */
  const [mapSessionKey, setMapSessionKey] = useState(0);
  /** Invalidates in-flight geocode when user switches lead/address */
  const geocodeReqIdRef = useRef(0);
  /** Hub report drawer: measurement opened from Measurements list */
  const [hubReport, setHubReport] = useState<{
    leadId: number;
    measurementId: string;
  } | null>(null);
  const [clientFirstName, setClientFirstName] = useState('');
  const [clientLastName, setClientLastName] = useState('');
  const [clientAddress, setClientAddress] = useState('');
  const [clientCity, setClientCity] = useState('');
  const [clientState, setClientState] = useState('');
  const [clientZip, setClientZip] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [additionalContacts, setAdditionalContacts] = useState<
    AdditionalContact[]
  >([]);
  const [financialWorksheet, setFinancialWorksheet] = useState<FinancialWorksheet>(
    emptyFinancialWorksheet()
  );
  const [finSectionMenuOpen, setFinSectionMenuOpen] = useState(false);
  const [clientJobNumber, setClientJobNumber] = useState('');
  const [leadCompany, setLeadCompany] = useState('');
  const [mailingSameAsBilling, setMailingSameAsBilling] = useState(true);
  const [billingAddress, setBillingAddress] = useState('');
  const [billingCity, setBillingCity] = useState('');
  const [billingState, setBillingState] = useState('');
  const [billingZip, setBillingZip] = useState('');
  const [jobCategory, setJobCategory] = useState<JobCategory>('Residential');
  const [hasHOA, setHasHOA] = useState(false);
  const [hoaInfo, setHoaInfo] = useState('');
  const [leadSource, setLeadSource] = useState<LeadSource>('Self Generated');
  const [referralName, setReferralName] = useState('');
  const [insuranceCompany, setInsuranceCompany] = useState('');
  const [damageLocation, setDamageLocation] = useState('');
  const [dateOfLoss, setDateOfLoss] = useState('');
  const [claimFiled, setClaimFiled] = useState(false);
  const [adjusterName, setAdjusterName] = useState('');
  const [adjusterPhone, setAdjusterPhone] = useState('');
  const [adjusterEmail, setAdjusterEmail] = useState('');
  const [metAdjuster, setMetAdjuster] = useState(false);
  const [claimNumber, setClaimNumber] = useState('');
  const [policyNumber, setPolicyNumber] = useState('');
  const [dripEdgeColor, setDripEdgeColor] = useState('');
  const [modifiedBitumenSquares, setModifiedBitumenSquares] = useState('');
  const [modifiedBitumenColor, setModifiedBitumenColor] = useState('');
  // Set only after mount — Date locale can differ server vs client
  const [estimateDate, setEstimateDate] = useState('');

  // Leads management
  const [leads, setLeads] = useState<Lead[]>([]);
  const [trash, setTrash] = useState<AppTrashItem[]>([]);
  const [leadsView, setLeadsView] = useState<'active' | 'trash'>('active');
  /** Live sell rates from Supabase `price_sheet` (item_key → price, or item_key__region) */
  const [priceSheet, setPriceSheet] = useState<Record<string, number>>({});
  const [pricesReady, setPricesReady] = useState(false);
  /** Live cost rates from Supabase `cost_sheet` (item_key → cost) */
  const [costSheet, setCostSheet] = useState<Record<string, number>>({});
  const [costsReady, setCostsReady] = useState(false);
  /** Mitigation price sheet (insurance / cash retail) */
  const [mitigationPrices, setMitigationPrices] = useState<MitigationPriceRow[]>(
    []
  );
  const [mitigationPricesReady, setMitigationPricesReady] = useState(false);
  const [showMitigationInvoice, setShowMitigationInvoice] = useState(false);
  const [mitigationDraft, setMitigationDraft] =
    useState<MitigationInvoiceDraft | null>(null);
  /** Manual override for pricing region (null = derive from job address) */
  const [pricingRegionOverride, setPricingRegionOverride] =
    useState<PricingRegion | null>(null);
  /** When set, Jobs board shows only this pipeline stage (shared with Home cards). */
  const [pipelineFilter, setPipelineFilter] = useState<PipelineStage | null>(
    null
  );
  const [currentLeadId, setCurrentLeadId] = useState<number | null>(null);
  const [leadCategory, setLeadCategory] = useState<PipelineStage>('Lead');
  const [headerSearch, setHeaderSearch] = useState('');
  const [leadsSearch, setLeadsSearch] = useState('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  /** Signed-in user contact — used on estimates / PDF */
  const [userName, setUserName] = useState<string>(DEFAULT_USER_PROFILE.name);
  const [userTitle, setUserTitle] = useState<string>(DEFAULT_USER_PROFILE.title);
  const [userCompany, setUserCompany] = useState<string>(
    DEFAULT_USER_PROFILE.company
  );
  const [userPhone, setUserPhone] = useState<string>(
    displayPhoneUS(DEFAULT_USER_PROFILE.phone)
  );
  const [userEmail, setUserEmail] = useState<string>(DEFAULT_USER_PROFILE.email);
  const [themePref, setThemePref] = useState<ThemePreference>('auto');
  const [themeMode, setThemeMode] = useState<ThemeMode>('day');
  /** Google Calendar connection (from /api/google/calendar/status) */
  const [gcalConfigured, setGcalConfigured] = useState(false);
  const [gcalConnected, setGcalConnected] = useState(false);
  const [gcalEmail, setGcalEmail] = useState<string | null>(null);
  const [gcalName, setGcalName] = useState<string | null>(null);
  const [gcalBusy, setGcalBusy] = useState(false);
  const [gcalLastSync, setGcalLastSync] = useState<string | null>(null);
  const [followUpDate, setFollowUpDate] = useState('');
  /** Summit Calendar cursor (drives mini-month + week strip) */
  const [calendarCursor, setCalendarCursor] = useState(() => new Date());
  const [calendarSelectedDay, setCalendarSelectedDay] = useState<string | null>(
    null
  );
  /** Live events pulled from connected Google Calendar */
  const [googleCalendarEvents, setGoogleCalendarEvents] = useState<
    Array<{
      id: string;
      summary: string;
      htmlLink?: string;
      location?: string;
      start: { dateTime?: string; date?: string };
      end: { dateTime?: string; date?: string };
    }>
  >([]);
  const [googleEventsLoading, setGoogleEventsLoading] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarProfileOpen, setSidebarProfileOpen] = useState(false);
  /** Estimate picker opens estimate vs internal workspace after lead pick */
  const [estimatePickerMode, setEstimatePickerMode] =
    useState<EstimateWorkspace>('estimate');
  const headerSearchRef = useRef<HTMLDivElement>(null);

  // Pricing region from open lead address (or form fields / manual override)
  const regionLeadId = currentLeadId ?? estimatorSourceLeadId;
  const liveLeadForRegion =
    regionLeadId != null ? leads.find((l) => l.id === regionLeadId) : null;
  const addressPricingRegion = resolvePricingRegion(
    (liveLeadForRegion?.clientCity || clientCity || '').trim(),
    (liveLeadForRegion?.clientState || clientState || '').trim(),
    (liveLeadForRegion?.clientZip || clientZip || '').trim()
  );
  const activePricingRegion: PricingRegion =
    pricingRegionOverride || addressPricingRegion;

  const getMitigationRate = (
    itemKey: string,
    mode: 'insurance' | 'cash' = 'insurance'
  ): number => {
    const row = mitigationPrices.find((r) => r.item_key === itemKey);
    if (!row) return 0;
    const v = mode === 'cash' ? row.cash_retail : row.insurance_rate;
    return typeof v === 'number' && !Number.isNaN(v) ? v : 0;
  };

  const startMitigationInvoice = (leadId?: number | null) => {
    const lead =
      leadId != null
        ? leads.find((l) => l.id === leadId)
        : currentLeadId != null
          ? leads.find((l) => l.id === currentLeadId)
          : null;
    const name = lead
      ? [lead.clientFirstName, lead.clientLastName].filter(Boolean).join(' ')
      : '';
    const addr = lead
      ? [lead.clientAddress, lead.clientCity, lead.clientState, lead.clientZip]
          .filter(Boolean)
          .join(', ')
      : '';
    setMitigationDraft({
      entity: 'rosalie',
      rateMode: 'insurance',
      invoiceFor: name,
      location: addr,
      job: lead?.jobNumber || '',
      claimNumber: '',
      date: new Date().toLocaleDateString(),
      lines: [],
      notes:
        'Work performed to mitigate any further damages.\nPrice includes materials, labor and roof access / set up.\nPlease forward to Insurance Company for reimbursement.',
    });
    setShowMitigationInvoice(true);
  };

  // Prices from Supabase `price_sheet` (cached; prefer item_key__region)
  const getSellPrice = (
    itemKey: string,
    fallback = 0,
    region?: PricingRegion
  ) => {
    if (!itemKey) return fallback;
    const r: PricingRegion = region || activePricingRegion || 'central';
    const kRegion = `${itemKey}__${r}`;
    const kCentral = `${itemKey}__central`;
    const vRegion = priceSheet[kRegion];
    if (vRegion != null && Number(vRegion) > 0) return Number(vRegion);
    const vCentral = priceSheet[kCentral];
    if (vCentral != null && Number(vCentral) > 0) return Number(vCentral);
    // Legacy phx alias
    const vPhx = priceSheet[`${itemKey}__phx`];
    if (vPhx != null && Number(vPhx) > 0) return Number(vPhx);
    // Legacy single-region rows (plain key)
    const vPlain = priceSheet[itemKey];
    if (vPlain != null && Number(vPlain) > 0) return Number(vPlain);
    return fallback;
  };

  const getCost = (
    itemKey: string,
    fallback = 0,
    region?: PricingRegion
  ): number => {
    if (!itemKey) return fallback;
    const r: PricingRegion = region || activePricingRegion || 'central';
    // Regional → central → all-market materials → plain key → fallback
    // Treat missing/0 as unknown (do not pretend free)
    const candidates = [
      `${itemKey}__${r}`,
      `${itemKey}__central`,
      `${itemKey}__all`,
      itemKey,
    ];
    for (const k of candidates) {
      const v = costSheet[k];
      if (v != null && Number.isFinite(Number(v)) && Number(v) > 0) {
        return Number(v);
      }
    }
    return fallback;
  };

  /**
   * Default crew labor $/sq.
   * Prefers cost_sheet base_shingle for active region; else 100 central / 110 southern+northern.
   */
  const defaultLaborPerSq = (): number => {
    const r = activePricingRegion || 'central';
    const fromSheet = getCost('base_shingle', 0, r);
    if (fromSheet > 0) return fromSheet;
    if (r === 'southern' || r === 'northern') return 110;
    return 100;
  };

  // Dev: verify regional sell + labor (remove when stable)
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development' || !pricesReady) return;
    const r = activePricingRegion || 'central';
    // eslint-disable-next-line no-console
    console.log('[Summit price debug]', {
      region: r,
      city: liveLeadForRegion?.clientCity || clientCity || '',
      state: liveLeadForRegion?.clientState || clientState || '',
      zip: liveLeadForRegion?.clientZip || clientZip || '',
      cambridge: getSellPrice('cambridge', 0),
      dynasty: getSellPrice('dynasty', 0),
      labor: defaultLaborPerSq(),
      base_shingle: getCost('base_shingle', 0, r),
      priceKeys: Object.keys(priceSheet).filter(
        (k) => k.includes('dynasty') || k.includes('cambridge')
      ),
      costKeys: Object.keys(costSheet).filter(
        (k) => k.includes('base_shingle') || k.includes('labor')
      ),
    });
  }, [
    pricesReady,
    costsReady,
    activePricingRegion,
    liveLeadForRegion?.clientCity,
    liveLeadForRegion?.clientState,
    liveLeadForRegion?.clientZip,
    clientCity,
    clientState,
    clientZip,
    priceSheet,
    costSheet,
  ]);

  const getPitchMultiplier = (pitchValue: string) => {
    return PITCH_MULTIPLIERS[pitchValue] || 1.0;
  };

  const calculateEstimatorPrice = () => {
    const sq = parseFloat(squares) || 0;
    const mbSq = parseFloat(modifiedBitumenSquares) || 0;
    const ly = parseInt(layers) || 1;
    const ws = parseFloat(waste) || 0;
    const pt = pitch || '4/12';
    const flf = parseFloat(fasciaLF) || 0;
    const dsh = parseFloat(deckingSheets) || 0;
    const panels = parseFloat(solarPanels) || 0;
    const hvac = parseFloat(hvacUnits) || 0;
    const sky = parseFloat(skylights) || 0;
    const ridge = parseFloat(ridgeVentLF) || 0;
    const pitchMultiplier = getPitchMultiplier(pt);
    const baseRoofArea = sq * (1 + ws);
    const roofAreaSqFt = sq * 100 * pitchMultiplier * (1 + ws);
    // Prefer price_sheet keys matching shingle type (cambridge / dynasty / armourshake)
    const basePerSq = selectedShingle
      ? getSellPrice(selectedShingle, getSellPrice('dynasty', 0))
      : getSellPrice('dynasty', 0);
    // Extra layer: central $20/sq · southern/northern $25/sq per layer above 1
    const layerRate = getSellPrice(
      'remove_layer',
      activePricingRegion === 'central' ? 20 : 25
    );
    const layerAdder = ly > 1 ? (ly - 1) * layerRate : 0;
    // Steep (all markets): 8-9 → $100 · 10-11 → $175 · 12 → $250 per sq
    let pitchAdder = 0;
    if (pt === '8/12' || pt === '9/12') {
      pitchAdder = getSellPrice('steep_8_9', 100);
    } else if (pt === '10/12' || pt === '11/12') {
      pitchAdder = getSellPrice('steep_9_11', 175);
    } else if (pt === '12/12') {
      pitchAdder = getSellPrice('steep_11_12', 250);
    }
    let underlaymentAdder = 0;
    const isLowSlope = ['2/12', '3/12'].includes(pt);
    if (
      selectedUnderlayment &&
      (selectedUnderlayment === 'high-temp' ||
        selectedUnderlayment === 'sa-high-temp' ||
        isLowSlope)
    ) {
      underlaymentAdder = sq * 8;
      if (isLowSlope) underlaymentAdder += sq * 8;
    }
    let fasciaAdder = 0;
    let shingleMoldAdder = 0;
    if (flf > 10 && (fasciaMode || fasciaType)) {
      const fasciaRate = getSellPrice('fascia', activePricingRegion === 'central' ? 15 : 18);
      const freeFasciaLF = flf - 10; // 10' free
      fasciaAdder = freeFasciaLF * fasciaRate;
      // Shingle mold tracks free LF after 10' (comes with fascia, extra sell)
      const moldRate = getSellPrice('shingle_mold', activePricingRegion === 'central' ? 5 : 6);
      shingleMoldAdder = freeFasciaLF * moldRate;
    }
    let deckingAdder = 0;
    let sheetsNeeded = 0;
    const osbSheetRate = getSellPrice('osb', 80);
    const cdxSheetRate = osbSheetRate; // OSB and CDX sell the same by market
    if (deckingMode === 'full') {
      sheetsNeeded = Math.ceil(roofAreaSqFt / 32);
      deckingAdder = sheetsNeeded * osbSheetRate;
    } else if (deckingMode === 'repair') {
      const osbN = parseFloat(deckingOsbSheets) || 0;
      const cdxN = parseFloat(deckingCdxSheets) || 0;
      // 2 sheets included free on repairs (prefer OSB free first)
      let freeLeft = 2;
      const osbBill = Math.max(0, osbN - freeLeft);
      freeLeft = Math.max(0, freeLeft - osbN);
      const cdxBill = Math.max(0, cdxN - freeLeft);
      deckingAdder = osbBill * osbSheetRate + cdxBill * cdxSheetRate;
    }
    
    // Flat system adders (per sq of main flat area)
    const flatSq = mbSq > 0 ? mbSq : sq;
    let flatExtraAdder = 0;
    if (flatSystem === 'foam' || selectedShingle === 'full_foam' || selectedShingle === 'foam_overlay') {
      const iso48 = parseFloat(foamIso48) || 0;
      const iso44 = parseFloat(foamIso44) || 0;
      const iso48Rate = getSellPrice('iso_4x8', getSellPrice('iso_board', 0));
      const iso44Rate = getSellPrice('iso_4x4', getSellPrice('iso_board', 0) * 0.5);
      if (iso48 > 0) flatExtraAdder += iso48 * iso48Rate;
      if (iso44 > 0) flatExtraAdder += iso44 * iso44Rate;
      if (foamGranules) flatExtraAdder += flatSq * getSellPrice('granules', 0);
      if (foamExtraSpf) flatExtraAdder += flatSq * getSellPrice('extra_spf', 0);
      if (foamScarify) flatExtraAdder += flatSq * getSellPrice('scarify', 0);
    }
    // Additional coat: coating, foam overlay, BUR, full foam
    const additionalCoatApply =
      flatSystem === 'coating' ||
      flatSystem === 'bur' ||
      flatSystem === 'foam' ||
      selectedShingle === 'elastomeric' ||
      selectedShingle === 'silicone' ||
      selectedShingle === 'urethane' ||
      selectedShingle === 'bur' ||
      selectedShingle === 'full_foam' ||
      selectedShingle === 'foam_overlay';
    // Pressure wash: coating + foam overlay only
    const pressureWashApply =
      flatSystem === 'coating' ||
      (flatSystem === 'foam' && foamKind === 'overlay') ||
      selectedShingle === 'elastomeric' ||
      selectedShingle === 'silicone' ||
      selectedShingle === 'urethane' ||
      selectedShingle === 'foam_overlay';
    if (additionalCoatApply && coatingExtraPass) {
      flatExtraAdder += flatSq * getSellPrice('extra_pass', 0);
    }
    if (pressureWashApply && coatingPressureWash) {
      flatExtraAdder += flatSq * getSellPrice('pressure_wash', 0);
    }

    const solarAdder = panels * 250;
    const hvacAdder = hvac * getSellPrice('hvac', activePricingRegion === 'central' ? 1250 : 1600);
    const skylightAdder = sky * getSellPrice('skylight', activePricingRegion === 'central' ? 500 : 550);
    const ridgeAdder = ridge * getSellPrice('ridge_vent', 12);
    const gLF = parseFloat(gutterLF) || 0;
    let gutterAdder = 0;
    if (gutterMode === 'dr' && gLF > 0) {
      gutterAdder = gLF * getSellPrice('gutters_dr', activePricingRegion === 'central' ? 15 : 20);
    } else if (gutterMode === 'rr' && gLF > 0) {
      gutterAdder = gLF * getSellPrice('gutters_rr', activePricingRegion === 'central' ? 20 : 30);
    }

    // Low-slope / flat MB sell: price_sheet key, fallback $600/sq
    const mbSellKey =
      lowSlopeMode !== 'none' && lowSlopeType !== 'none'
        ? lowSlopeType
        : selectedShingle === 'mod_bitumen' ||
            selectedShingle === 'full_foam' ||
            selectedShingle === 'coating' ||
            selectedShingle === 'elastomeric' ||
            selectedShingle === 'silicone' ||
            selectedShingle === 'urethane' ||
            selectedShingle === 'foam_overlay' ||
            selectedShingle === 'bur'
          ? selectedShingle
          : 'mod_bitumen';
    const mbSellRate = getSellPrice(mbSellKey, getSellPrice('mod_bitumen', 600));
    const mbAdder = mbSq > 0 ? Math.round(mbSq * mbSellRate) : 0;

    const baseRoofPrice = Math.round(
      baseRoofArea * (basePerSq + layerAdder + pitchAdder) + underlaymentAdder
    );
    const internalCost =
      baseRoofPrice +
      fasciaAdder +
      shingleMoldAdder +
      deckingAdder +
      solarAdder +
      hvacAdder +
      skylightAdder +
      ridgeAdder +
      gutterAdder +
      flatExtraAdder +
      mbAdder;
    // Wait for price_sheet (or cache) before treating estimate as
    const hasRealData =
      (sq > 0 || mbSq > 0) &&
      selectedShingle !== '' &&
      pricesReady &&
      (basePerSq > 0 || mbSq > 0);
    const total = hasRealData ? Math.round(internalCost + 3500) : 0;

    return {
      total,
      baseRoofPrice,
      fasciaCost: fasciaAdder,
      shingleMoldCost: shingleMoldAdder,
      deckingCost: deckingAdder,
      solarCost: solarAdder,
      hvacCost: hvacAdder,
      skylightCost: skylightAdder,
      ridgeCost: ridgeAdder,
      gutterCost: gutterAdder,
      flatExtraCost: flatExtraAdder,
      mbCost: mbAdder,
      sheetsNeeded,
    };
  };

  const {
    total: estimatorCalculatedTotal,
    fasciaCost,
    deckingCost,
    sheetsNeeded,
  } = calculateEstimatorPrice();

  // Keep refs current for effects that must not re-run on every related state change
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    sectionKindRef.current = sectionKind;
  }, [sectionKind]);

  // Bounce invalid estimator sessions (no lead)
  useEffect(() => {
    if (!sessionReady) return;
    if (
      isEditingLead &&
      profileTab === 'estimator' &&
      estimatorSourceLeadId == null &&
      currentLeadId == null
    ) {
      setShowProfessionalEstimate(false);
      setProfileTab('overview');
      setIsEditingLead(false);
      setActiveTab('home');
    }
  }, [
    sessionReady,
    isEditingLead,
    profileTab,
    estimatorSourceLeadId,
    currentLeadId,
  ]);

  useEffect(() => {
    negotiatedPriceRef.current = negotiatedPrice;
  }, [negotiatedPrice]);

  useEffect(() => {
    originalTotalForBufferRef.current = originalTotalForBuffer;
  }, [originalTotalForBuffer]);

  /**
   * Client-only bootstrap: read localStorage AFTER mount so SSR HTML matches
   * the first client render (avoids header/nav hydration mismatches).
   */
  useEffect(() => {
    try {
      setIsLoggedIn(readStoredBool('summitLoggedIn', false));
      setActiveTab(readStoredTab());
      setCurrentLeadId(readStoredLeadId());
      setIsEditingLead(readStoredBool('summitEditingLead', false));

      const savedEmail = localStorage.getItem('summitUserEmail');
      if (savedEmail) setEmail(savedEmail);

      try {
        const up = localStorage.getItem('summitUserProfile');
        if (up) {
          const p = JSON.parse(up) as {
            name?: string;
            title?: string;
            company?: string;
            phone?: string;
            email?: string;
          };
          if (p.name) setUserName(p.name);
          if (p.title) setUserTitle(p.title);
          if (p.company) setUserCompany(p.company);
          if (p.phone) setUserPhone(displayPhoneUS(p.phone));
          if (p.email) setUserEmail(p.email);
        }
      } catch {
        /* ignore */
      }

      const storedTheme = readStoredThemePref();
      setThemePref(storedTheme);
      const mode = resolveThemeMode(storedTheme);
      setThemeMode(mode);
      applyThemeMode(mode);

      const savedLeads = localStorage.getItem('summitLeads');
      const savedTrash = localStorage.getItem('summitTrash');
      // Cloud is source of truth when Supabase is configured — skip stale local leads
      if (!supabaseEnabled) {
        if (savedLeads) {
          try {
            const parsed = JSON.parse(savedLeads) as Array<
              Partial<Lead> & { clientJobNumber?: string }
            >;
            setLeads(parsed.map(normalizeLead));
          } catch {
            /* ignore */
          }
        }
      }

      // App trash is always local (leads + media soft-deletes)
      if (savedTrash) {
        try {
          const parsed = JSON.parse(savedTrash);
          const migrated: AppTrashItem[] = (Array.isArray(parsed) ? parsed : [])
            .map((item: unknown): AppTrashItem | null => {
              if (!item || typeof item !== 'object') return null;
              const r = item as Record<string, unknown>;

              if (r.kind === 'lead' && r.lead) {
                return {
                  id: String(
                    r.id ||
                      `lead-${(r.lead as Lead).id}-${r.deletedAt || Date.now()}`
                  ),
                  kind: 'lead' as const,
                  deletedAt: String(
                    r.deletedAt || new Date().toLocaleString()
                  ),
                  lead: normalizeLead(
                    r.lead as Partial<Lead> & { clientJobNumber?: string }
                  ),
                };
              }

              if (r.kind === 'photo' && r.photo) {
                return {
                  id: String(
                    r.id ||
                      `photo-${(r.photo as LeadPhoto).id}-${r.deletedAt || Date.now()}`
                  ),
                  kind: 'photo' as const,
                  deletedAt: String(
                    r.deletedAt || new Date().toLocaleString()
                  ),
                  leadId: Number(r.leadId) || 0,
                  leadLabel: String(r.leadLabel || 'Lead'),
                  photo: r.photo as LeadPhoto,
                };
              }

              if (
                (r.kind === 'document' || r.kind === 'measurement') &&
                r.document
              ) {
                return {
                  id: String(
                    r.id ||
                      `doc-${(r.document as LeadDocument).id}-${r.deletedAt || Date.now()}`
                  ),
                  kind: r.kind as 'document' | 'measurement',
                  deletedAt: String(
                    r.deletedAt || new Date().toLocaleString()
                  ),
                  leadId: Number(r.leadId) || 0,
                  leadLabel: String(r.leadLabel || 'Lead'),
                  document: r.document as LeadDocument,
                };
              }

              if (r.kind === 'roofMeasurement' && r.measurement) {
                return {
                  id: String(
                    r.id ||
                      `roof-${(r.measurement as RoofMeasurement).id}-${r.deletedAt || Date.now()}`
                  ),
                  kind: 'roofMeasurement' as const,
                  deletedAt: String(
                    r.deletedAt || new Date().toLocaleString()
                  ),
                  leadId: Number(r.leadId) || 0,
                  leadLabel: String(r.leadLabel || 'Lead'),
                  measurement: r.measurement as RoofMeasurement,
                };
              }

              if (r.kind === 'estimate' && r.estimate) {
                return {
                  id: String(
                    r.id ||
                      `est-${(r.estimate as Estimate).id}-${r.deletedAt || Date.now()}`
                  ),
                  kind: 'estimate' as const,
                  deletedAt: String(
                    r.deletedAt || new Date().toLocaleString()
                  ),
                  leadId: Number(r.leadId) || 0,
                  leadLabel: String(r.leadLabel || 'Lead'),
                  estimate: r.estimate as Estimate,
                };
              }

              if (r.kind === 'note' && r.note) {
                return {
                  id: String(r.id || `note-${r.deletedAt || Date.now()}`),
                  kind: 'note' as const,
                  deletedAt: String(
                    r.deletedAt || new Date().toLocaleString()
                  ),
                  leadId: Number(r.leadId) || 0,
                  leadLabel: String(r.leadLabel || 'Lead'),
                  note: r.note as LeadNote,
                };
              }

              // Legacy bare lead object
              if (
                r.id != null &&
                (r.clientFirstName != null ||
                  r.jobNumber != null ||
                  r.category != null) &&
                !r.kind
              ) {
                return {
                  id: String(`lead-${r.id}-${Date.now()}`),
                  kind: 'lead' as const,
                  deletedAt: String(
                    r.deletedAt || new Date().toLocaleString()
                  ),
                  lead: normalizeLead(
                    r as Partial<Lead> & { clientJobNumber?: string }
                  ),
                };
              }

              return null; // drop garbage instead of crashing
            })
            .filter(Boolean) as AppTrashItem[];

          setTrash(migrated);
        } catch (e) {
          console.error(
            'Failed to load summitTrash — keeping current trash',
            e
          );
          // Do NOT setTrash([]) here — that would wipe everything
        }
      }

      // Supabase is source of truth when configured (leads + estimates)
      if (supabaseEnabled && supabase) {
        void (async () => {
          try {
            const { data: leadRows, error: leadErr } = await supabase
              .from('leads')
              .select('*')
              .order('created_at', { ascending: false });

            if (leadErr) {
              console.error('Supabase leads fetch error:', leadErr);
              // Offline fallback: use local cache only if cloud fetch fails
              if (savedLeads) {
                try {
                  const parsed = JSON.parse(savedLeads) as Array<
                    Partial<Lead> & { clientJobNumber?: string }
                  >;
                  setLeads(parsed.map(normalizeLead));
                } catch {
                  /* ignore */
                }
              }
              return;
            }
            if (!leadRows || leadRows.length === 0) {
              setLeads([]);
              try {
                localStorage.setItem('summitLeads', JSON.stringify([]));
              } catch {
                /* ignore */
              }
              return;
            }

            const fromDb = leadRows.map((row) =>
              mapDbLeadToApp(row as Record<string, unknown>)
            );

            const { data: estRows, error: estErr } = await supabase
              .from('estimates')
              .select('*')
              .order('created_at', { ascending: false });

            if (estErr) {
              console.error('Supabase estimates fetch error:', estErr);
            } else if (estRows && estRows.length > 0) {
              const byLead: Record<string, Estimate[]> = {};
              for (const row of estRows) {
                const r = row as Record<string, unknown>;
                const leadKey = r.lead_id != null ? String(r.lead_id) : '';
                if (!leadKey) continue;
                const rawData = (r.data && typeof r.data === 'object'
                  ? r.data
                  : r) as Partial<Estimate> & { selectedShingle?: string };
                const est: Estimate = {
                  id:
                    typeof rawData.id === 'number'
                      ? rawData.id
                      : stableLeadIdFromDb(r.id),
                  date: String(rawData.date || ''),
                  clientFirstName: String(rawData.clientFirstName || ''),
                  clientLastName: String(rawData.clientLastName || ''),
                  clientAddress: String(rawData.clientAddress || ''),
                  clientCity: String(rawData.clientCity || ''),
                  clientState: String(rawData.clientState || ''),
                  clientZip: String(rawData.clientZip || ''),
                  clientPhone: String(rawData.clientPhone || ''),
                  clientEmail: String(rawData.clientEmail || ''),
                  clientJobNumber: String(rawData.clientJobNumber || ''),
                  squares: String(rawData.squares || ''),
                  layers: String(rawData.layers || ''),
                  waste: String(rawData.waste || ''),
                  pitch: String(rawData.pitch || ''),
                  stories: String(rawData.stories || ''),
                  fasciaLF: String(rawData.fasciaLF || ''),
                  deckingSheets: String(rawData.deckingSheets || ''),
                  deckingOsbSheets: String(rawData.deckingOsbSheets || ''),
                  deckingCdxSheets: String(rawData.deckingCdxSheets || ''),
                  solarPanels: String(rawData.solarPanels || ''),
                  hvacUnits: String(rawData.hvacUnits || ''),
                  skylights: String(rawData.skylights || ''),
                  ridgeVentLF: String(rawData.ridgeVentLF || ''),
                  gutterMode:
                    rawData.gutterMode === 'dr' || rawData.gutterMode === 'rr'
                      ? rawData.gutterMode
                      : 'none',
                  gutterLF: String(rawData.gutterLF || ''),
                  selectedShingle:
                    (rawData.selectedShingle as ShingleType) ||
                    (String(r.material || '') as ShingleType) ||
                    '',
                  cambridgeColor: String(rawData.cambridgeColor || ''),
                  dynastyColor: String(rawData.dynastyColor || ''),
                  armourshakeColor: String(rawData.armourshakeColor || ''),
                  selectedUnderlayment:
                    (rawData.selectedUnderlayment as Underlayment) || '',
                  fasciaMode: (rawData.fasciaMode as FasciaMode) || '',
                  deckingMode: (rawData.deckingMode as DeckingMode) || '',
                  fasciaType: (rawData.fasciaType as FasciaType) || '',
                  modifiedBitumenSquares: String(
                    rawData.modifiedBitumenSquares || ''
                  ),
                  modifiedBitumenColor: String(
                    rawData.modifiedBitumenColor || ''
                  ),
                  dripEdgeColor: String(rawData.dripEdgeColor || ''),
                  notes: String(rawData.notes || ''),
                  total: Number(rawData.total) || 0,
                  negotiatedPrice: Number(rawData.negotiatedPrice) || 0,
                  originalTotalForBuffer:
                    Number(rawData.originalTotalForBuffer) || 0,
                  measurementId: rawData.measurementId,
                  supabaseId: r.id != null ? String(r.id) : undefined,
                };
                if (!byLead[leadKey]) byLead[leadKey] = [];
                byLead[leadKey].push(est);
              }
              for (const lead of fromDb) {
                const key = lead.supabaseId || String(lead.id);
                if (byLead[key]?.length) {
                  lead.estimates = byLead[key];
                }
              }
            }

            setLeads(fromDb);
            try {
              localStorage.setItem('summitLeads', JSON.stringify(fromDb));
            } catch {
              /* ignore quota */
            }
            console.log(
              'Loaded',
              fromDb.length,
              'leads and estimates from Supabase'
            );
          } catch (err) {
            console.error('Supabase bootstrap error:', err);
          }
        })();
      }

      // --- price_sheet + cost_sheet: Supabase is source of truth ---
      try {
        const cached = localStorage.getItem('summitPriceSheet');
        if (cached) {
          const parsed = JSON.parse(cached) as Record<string, number>;
          if (parsed && typeof parsed === 'object') {
            setPriceSheet(parsed);
            setPricesReady(true);
          }
        }
      } catch {
        /* ignore */
      }
      try {
        const cachedCost = localStorage.getItem('summitCostSheet');
        if (cachedCost) {
          const parsed = JSON.parse(cachedCost) as Record<string, number>;
          if (parsed && typeof parsed === 'object') {
            setCostSheet(parsed);
            setCostsReady(true);
          }
        }
      } catch {
        /* ignore */
      }

      if (supabaseEnabled && supabase) {
        void supabase
          .from('price_sheet')
          .select('item_key, price, region, active')
          .then(({ data, error }) => {
            if (error) {
              console.error(
                'price_sheet fetch error:',
                JSON.stringify(error, null, 2)
              );
              setPricesReady(true);
              return;
            }
            // Filter active in JS (column type / RLS can be picky with .eq)
            const rows = (data || []).filter(
              (row: { active?: boolean | null }) => row.active !== false
            );
            if (rows.length > 0) {
              const map: Record<string, number> = {};
              rows.forEach(
                (row: {
                  item_key?: string;
                  price?: number;
                  region?: string;
                }) => {
                  if (row.item_key == null || row.price == null) return;
                  const price = Number(row.price) || 0;
                  const reg = normalizePricingRegion(row.region);
                  const key = String(row.item_key);
                  map[`${key}__${reg}`] = price;
                  // Also store legacy aliases so older DB values (phx/tuc/north) still resolve
                  const rawReg = String(row.region || 'central')
                    .toLowerCase()
                    .trim();
                  if (rawReg && rawReg !== reg) {
                    map[`${key}__${rawReg}`] = price;
                  }
                  // Plain key = Central (or first-seen) for legacy getSellPrice callers
                  if (reg === 'central' || map[key] == null) {
                    map[key] = price;
                  }
                }
              );
              setPriceSheet(map);
              try {
                localStorage.setItem('summitPriceSheet', JSON.stringify(map));
              } catch {
                /* ignore */
              }
              setPricesReady(true);
              console.log(
                'Loaded',
                rows.length,
                'prices from Supabase price_sheet (regional)'
              );
            } else {
              setPricesReady(true);
            }
          });

        void supabase
          .from('cost_sheet')
          .select('item_key, cost, region, active')
          .then(({ data, error }) => {
            if (error) {
              console.error(
                'cost_sheet fetch error:',
                JSON.stringify(error, null, 2)
              );
              setCostsReady(true);
              return;
            }
            const rows = (data || []).filter(
              (row: { active?: boolean | null }) => row.active !== false
            );
            const map: Record<string, number> = {};
            rows.forEach(
              (row: {
                item_key?: string;
                cost?: number;
                region?: string;
              }) => {
                if (row.item_key == null || row.cost == null) return;
                const cost = Number(row.cost);
                if (!Number.isFinite(cost)) return;
                const key = String(row.item_key);
                const rawReg = String(row.region ?? 'all')
                  .toLowerCase()
                  .trim();
                // region all / blank → plain key (shared materials) + __all
                if (!rawReg || rawReg === 'all' || rawReg === '*') {
                  map[key] = cost;
                  map[`${key}__all`] = cost;
                  return;
                }
                const reg = normalizePricingRegion(rawReg);
                map[`${key}__${reg}`] = cost;
                if (rawReg && rawReg !== reg) {
                  map[`${key}__${rawReg}`] = cost;
                }
                // Prefer central as plain key; else first-seen only
                if (reg === 'central' || map[key] == null) {
                  map[key] = cost;
                }
              }
            );
            // Ensure __all materials always available as plain keys
            Object.keys(map).forEach((k) => {
              if (k.endsWith('__all')) {
                const plain = k.slice(0, -5);
                if (map[plain] == null) map[plain] = map[k];
              }
            });
            setCostSheet(map);
            try {
              localStorage.setItem('summitCostSheet', JSON.stringify(map));
            } catch {
              /* ignore */
            }
            setCostsReady(true);
            console.log(
              'Loaded',
              rows.length,
              'costs from Supabase cost_sheet (regional + all)'
            );
          });

        // mitigation_price_sheet
        void supabase
          .from('mitigation_price_sheet')
          .select(
            'item_key,label,category,unit,insurance_rate,cash_retail,active,sort_order'
          )
          .eq('active', true)
          .order('sort_order')
          .then(({ data: mitRows, error: mitErr }) => {
            if (mitErr) {
              console.warn(
                'mitigation_price_sheet load failed',
                JSON.stringify(mitErr, null, 2)
              );
              setMitigationPricesReady(true);
              return;
            }
            if (Array.isArray(mitRows)) {
              setMitigationPrices(
                mitRows.map(
                  (r: {
                    item_key?: string;
                    label?: string;
                    category?: string;
                    unit?: string;
                    insurance_rate?: number | null;
                    cash_retail?: number | null;
                  }) => ({
                    item_key: String(r.item_key || ''),
                    label: String(r.label || r.item_key || ''),
                    category: String(r.category || ''),
                    unit: String(r.unit || 'each'),
                    insurance_rate:
                      r.insurance_rate == null
                        ? null
                        : Number(r.insurance_rate),
                    cash_retail:
                      r.cash_retail == null ? null : Number(r.cash_retail),
                  })
                )
              );
              console.log(
                'Loaded',
                mitRows.length,
                'mitigation prices from Supabase'
              );
            }
            setMitigationPricesReady(true);
          });
      } else {
        setPricesReady(true);
        setCostsReady(true);
        setMitigationPricesReady(true);
      }

      setEstimateDate(
        new Date().toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        })
      );
    } catch {
      // ignore corrupt storage
    } finally {
      setSessionReady(true);
    }
  }, [supabase, supabaseEnabled]);

  // Persist navigation only after bootstrap (don't overwrite stored tab with default)
  useEffect(() => {
    if (!sessionReady) return;
    try {
      localStorage.setItem('summitActiveTab', activeTab);
    } catch {
      /* ignore */
    }
  }, [activeTab, sessionReady]);

  useEffect(() => {
    if (!sessionReady) return;
    try {
      localStorage.setItem(
        'summitUserProfile',
        JSON.stringify({
          name: userName,
          title: userTitle,
          company: userCompany,
          phone: userPhone,
          email: userEmail,
        })
      );
    } catch {
      /* ignore */
    }
  }, [sessionReady, userName, userTitle, userCompany, userPhone, userEmail]);

  // Appearance: persist preference + apply day/night (auto rechecks while open)
  useEffect(() => {
    if (!sessionReady) return;
    try {
      localStorage.setItem('summitThemePref', themePref);
    } catch {
      /* ignore */
    }
    const applyNow = () => {
      const mode = resolveThemeMode(themePref);
      setThemeMode(mode);
      applyThemeMode(mode);
    };
    applyNow();
    if (themePref !== 'auto') return;
    const id = window.setInterval(applyNow, 60_000);
    const onVis = () => {
      if (document.visibilityState === 'visible') applyNow();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [sessionReady, themePref]);

  // Google Calendar connection status + OAuth return (?gcal=connected)
  useEffect(() => {
    if (!sessionReady) return;
    void refreshGcalStatus();
    try {
      const last = localStorage.getItem('summitGcalLastSync');
      if (last) setGcalLastSync(last);
    } catch {
      /* ignore */
    }
    try {
      const params = new URLSearchParams(window.location.search);
      const gcal = params.get('gcal');
      if (!gcal) return;
      if (gcal === 'connected') {
        showToast('Google Calendar connected');
        void refreshGcalStatus();
        const tab = params.get('tab');
        if (tab === 'settings') handleTabChange('settings');
      } else if (gcal === 'error') {
        const reason = params.get('reason') || 'unknown';
        showToast(
          reason.includes('not configured') || reason.includes('access_denied')
            ? `Calendar: ${reason}`
            : 'Google Calendar connection failed'
        );
      }
      // Clean query so refresh doesn't re-toast
      const url = new URL(window.location.href);
      url.searchParams.delete('gcal');
      url.searchParams.delete('reason');
      url.searchParams.delete('tab');
      window.history.replaceState({}, '', url.pathname + url.search);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot after hydrate
  }, [sessionReady]);

  useEffect(() => {
    if (!sessionReady) return;
    try {
      if (currentLeadId != null) {
        localStorage.setItem('summitCurrentLeadId', String(currentLeadId));
      } else {
        localStorage.removeItem('summitCurrentLeadId');
      }
    } catch {
      /* ignore */
    }
  }, [currentLeadId, sessionReady]);

  useEffect(() => {
    if (!sessionReady) return;
    try {
      localStorage.setItem(
        'summitEditingLead',
        isEditingLead ? 'true' : 'false'
      );
    } catch {
      /* ignore */
    }
  }, [isEditingLead, sessionReady]);

  // Drop stale restored lead id after leads hydrate
  useEffect(() => {
    if (!sessionReady) return;
    if (currentLeadId == null || leads.length === 0) return;
    if (!leads.some((l) => l.id === currentLeadId)) {
      setCurrentLeadId(null);
      setIsEditingLead(false);
    }
  }, [leads, currentLeadId, sessionReady]);

  const handleLogin = () => {
    setIsLoggedIn(true);
    localStorage.setItem('summitLoggedIn', 'true');
    if (email.trim()) localStorage.setItem('summitUserEmail', email.trim());
  };

  const handleSignOut = () => {
    if (hasUnsavedChanges && (isEditingLead && profileTab === 'estimator')) {
      const shouldSave = confirm('Unsaved changes — Save before signing out?');
      if (shouldSave) {
        return; // Stay so user can save
      }
      resetEstimatorFields(false);
      setCurrentLeadId(null);
    }
    setSidebarOpen(false);
    setShowUserMenu(false);
    setIsLoggedIn(false);
    localStorage.removeItem('summitLoggedIn');
    localStorage.removeItem('summitActiveTab');
    localStorage.removeItem('summitCurrentLeadId');
    localStorage.removeItem('summitEditingLead');
    setActiveTab('home');
    setIsEditingLead(false);
    setEstimatorSourceLeadId(null);
    setShowProfessionalEstimate(false);
    setHasUnsavedChanges(false);
  };

  /** Explicit save for Profile settings (profile + appearance). */
  const saveUserSettings = () => {
    try {
      localStorage.setItem(
        'summitUserProfile',
        JSON.stringify({
          name: userName,
          title: userTitle,
          company: userCompany,
          phone: userPhone,
          email: userEmail,
        })
      );
      localStorage.setItem('summitThemePref', themePref);
      const mode = resolveThemeMode(themePref);
      setThemeMode(mode);
      applyThemeMode(mode);
      showToast('Settings saved');
    } catch {
      showToast('Could not save settings');
    }
  };

  // Sync display total + buffer anchor when calculated price changes.
  // Read negotiated/original via refs so we don't re-fire on every negotiation keystroke.
  useEffect(() => {
    if (estimatorCalculatedTotal <= 0) return;

    setEstimatorTotalPrice(estimatorCalculatedTotal);

    const orig = originalTotalForBufferRef.current;
    const neg = negotiatedPriceRef.current;
    if (orig === 0 || orig !== estimatorCalculatedTotal) {
      setOriginalTotalForBuffer(estimatorCalculatedTotal);
      // Only auto-match negotiated if user hasn't diverged from the previous anchor
      if (neg === 0 || neg === orig) {
        setNegotiatedPrice(estimatorCalculatedTotal);
      }
    }
  }, [estimatorCalculatedTotal]);

  const [officeCostPercent] = useState(10);
  const [commissionRate, setCommissionRate] = useState('');

  // Real costs
  const sq = parseFloat(squares) || 0;
  const ly = parseInt(layers) || 1;
  const pt = pitch || '4/12';
  const flf = parseFloat(fasciaLF) || 0;
  const dsh = parseFloat(deckingSheets) || 0;
  const ridge = parseFloat(ridgeVentLF) || 0;
  const mbSq = parseFloat(modifiedBitumenSquares) || 0;
  const hvacCount = parseFloat(hvacUnits) || 0;
  const solarCount = parseFloat(solarPanels) || 0;
  const isTwoStory = stories === '2';

  /** Mod-bit is on THIS estimate (main flat product or optional low-slope type). */
  const summitIsModBit =
    flatSystem === 'mod_bit' ||
    selectedShingle === 'mod_bitumen' ||
    (lowSlopeMode !== 'none' && lowSlopeType === 'mod_bitumen');
  // Main mod-bit job may use squares; optional low-slope uses modifiedBitumenSquares only
  const mbMaterialSq = summitIsModBit
    ? mbSq > 0
      ? mbSq
      : flatSystem === 'mod_bit' || selectedShingle === 'mod_bitumen'
        ? sq
        : 0
    : 0;

  // Material (includes MB: 1 base ply + SA cap only when mod-bit is on THIS estimate)
  let realMaterial = 0;
  if (selectedShingle === 'dynasty') realMaterial += sq * 31.33 * 3;
  if (selectedShingle === 'cambridge') realMaterial += sq * 29.67 * 3;
  if (selectedShingle === 'armourshake') realMaterial += sq * 48 * 5;
  realMaterial += ridge * 6;
  if (mbMaterialSq > 0) {
    const capCost = getCost('mb_cap_sheet', 123);
    const baseCost = getCost('mb_base_ply', 126);
    realMaterial += mbMaterialSq * capCost;
    realMaterial += mbMaterialSq * baseCost; // 1 base ply (not 2)
  }

  // Labor (includes HVAC / solar adders)
  const laborPerSq = defaultLaborPerSq();
  let realLabor = sq * laborPerSq;
  if (ly > 1) realLabor += sq * 10 * (ly - 1);
  if (['8/12', '9/12', '10/12', '11/12', '12/12'].includes(pt)) realLabor += sq * 10;
  if (isTwoStory) realLabor += sq * 10;
  const fasciaBeyondFree = Math.max(0, flf - 10);
  if (fasciaBeyondFree > 0 && fasciaType) {
    realLabor += fasciaBeyondFree * 6;
  }
  if (deckingMode === 'full') {
    const pitchMultiplier = getPitchMultiplier(pt);
    const roofAreaSqFt = sq * 100 * pitchMultiplier * (1 + (parseFloat(waste) || 0.1));
    const sheetsNeededCalc = Math.ceil(roofAreaSqFt / 32);
    const extra = Math.max(0, sheetsNeededCalc - 2);
    realLabor += extra * 20;
  } else if (deckingMode === 'repair') {
    const osbN = parseFloat(deckingOsbSheets || '0') || 0;
    const cdxN = parseFloat(deckingCdxSheets || '0') || 0;
    const totalSheets = osbN + cdxN;
    const extraSheets = Math.max(0, totalSheets - 2);
    realLabor += extraSheets * 20;
  }
  realLabor += ridge * 2;
  realLabor += hvacCount * 1500;
  realLabor += solarCount * 100;

  // Breakdown helpers for Internal tab
  const shingleMaterialCost =
    selectedShingle === 'dynasty'
      ? sq * 31.33 * 3
      : selectedShingle === 'cambridge'
        ? sq * 29.67 * 3
        : selectedShingle === 'armourshake'
          ? sq * 48 * 5
          : 0;
  const mbCapMaterial =
    mbMaterialSq > 0 ? mbMaterialSq * getCost('mb_cap_sheet', 123) : 0;
  // One base ply only (never 2 layers)
  const mbBasePlyMaterial =
    mbMaterialSq > 0 ? mbMaterialSq * getCost('mb_base_ply', 126) : 0;
  const ridgeMaterial = ridge * 6;
  const hvacLaborCost = hvacCount * 1500;
  const solarLaborCost = solarCount * 100;

  const officeCut = Math.round(estimatorTotalPrice * (officeCostPercent / 100));
  const grossProfit = negotiatedPrice - officeCut - realLabor - realMaterial;
  const yourCommission = Math.max(0, Math.round(grossProfit * (parseFloat(commissionRate) || 0) / 100));
  const bufferUsed = Math.max(0, originalTotalForBuffer - negotiatedPrice);
  const bufferRemaining = Math.max(0, NEGOTIATION_BUFFER_CAP - bufferUsed);
  const bufferUsedPct = Math.min(
    100,
    Math.round((bufferUsed / NEGOTIATION_BUFFER_CAP) * 100)
  );

  /** Client/job contact always comes from the linked lead (not typed on the estimate). */
  const resolveEstimatorClient = () => {
    const id = currentLeadId ?? estimatorSourceLeadId;
    const lead = id != null ? leads.find((l) => l.id === id) : undefined;
    if (lead) {
      const firstName = lead.clientFirstName || '';
      const lastName = lead.clientLastName || '';
      const address = lead.clientAddress || '';
      const city = lead.clientCity || '';
      const state = lead.clientState || '';
      const zip = lead.clientZip || '';
      const phone = displayPhoneUS(lead.clientPhone || '') || lead.clientPhone || '';
      const email = lead.clientEmail || '';
      const jobNumber = lead.jobNumber || '';
      return {
        firstName,
        lastName,
        address,
        city,
        state,
        zip,
        phone,
        email,
        jobNumber,
        fullName: [firstName, lastName].filter(Boolean).join(' ') || 'N/A',
        fullAddress:
          [address, city, state, zip].filter(Boolean).join(', ') || 'N/A',
        lead,
      };
    }
    // Fallback only if somehow unlinked — still prefer form state
    return {
      firstName: clientFirstName,
      lastName: clientLastName,
      address: clientAddress,
      city: clientCity,
      state: clientState,
      zip: clientZip,
      phone: clientPhone,
      email: clientEmail,
      jobNumber: clientJobNumber,
      fullName:
        [clientFirstName, clientLastName].filter(Boolean).join(' ') || 'N/A',
      fullAddress:
        [clientAddress, clientCity, clientState, clientZip]
          .filter(Boolean)
          .join(', ') || 'N/A',
      lead: null as Lead | null,
    };
  };

  const saveCurrentEstimate = () => {
    const client = resolveEstimatorClient();
    const linkId = currentLeadId ?? estimatorSourceLeadId ?? client.lead?.id ?? null;

    const currentEstimate = {
      id: Date.now(),
      date: new Date().toLocaleDateString(),
      clientFirstName: client.firstName,
      clientLastName: client.lastName,
      clientAddress: client.address,
      clientCity: client.city,
      clientState: client.state,
      clientZip: client.zip,
      clientPhone: client.phone,
      clientEmail: client.email,
      clientJobNumber: client.jobNumber,
      squares,
      layers,
      waste,
      pitch,
      stories,
      fasciaLF,
      deckingSheets,
      deckingOsbSheets,
      deckingCdxSheets,
      solarPanels,
      hvacUnits,
      skylights,
      ridgeVentLF,
      gutterMode,
      gutterLF,
      selectedShingle,
      cambridgeColor,
      dynastyColor,
      armourshakeColor,
      selectedUnderlayment,
      fasciaMode,
      deckingMode,
      fasciaType,
      modifiedBitumenSquares,
      modifiedBitumenColor,
      dripEdgeColor,
      notes,
      total: estimatorTotalPrice,
      negotiatedPrice,
      originalTotalForBuffer,
      measurementId: activeMeasurementId || undefined,
    };

    let updatedLeads = [...leads];
    if (linkId != null) {
      updatedLeads = updatedLeads.map((lead) =>
        lead.id === linkId
          ? { ...lead, estimates: [...(lead.estimates || []), currentEstimate] }
          : lead
      );
      setCurrentLeadId(linkId);
      setEstimatorSourceLeadId(linkId);
    } else {
      const newLead = createEmptyLead({
        clientFirstName: client.firstName,
        clientLastName: client.lastName,
        clientAddress: client.address,
        clientCity: client.city,
        clientState: client.state,
        clientZip: client.zip,
        clientPhone: client.phone,
        clientEmail: client.email,
        jobNumber: client.jobNumber,
        estimates: [currentEstimate],
        category: 'Lead',
      });
      updatedLeads.push(newLead);
      setCurrentLeadId(newLead.id);
      setEstimatorSourceLeadId(newLead.id);
    }
    persistLeads(updatedLeads);
    setHasUnsavedChanges(false);
    showToast('Estimate saved to lead');
  };

  const resetEstimatorFields = (keepLeadContact = false) => {
    skipUnsavedMarkRef.current = true;
    if (!keepLeadContact) {
      setClientFirstName('');
      setClientLastName('');
      setClientAddress('');
      setClientCity('');
      setClientState('');
      setClientZip('');
      setClientPhone('');
      setClientEmail('');
      setClientJobNumber('');
    }
    setSquares('');
    setLayers('');
    setWaste('');
    setPitch('');
    setStories('');
    setFasciaLF('');
    setDeckingSheets('');
    setDeckingOsbSheets('');
    setDeckingCdxSheets('');
    setSolarPanels('');
    setHvacUnits('');
    setSkylights('');
    setRidgeVentLF('');
    setGutterMode('none');
    setGutterLF('');
    setNotes('');
    setSelectedShingle('');
    setFlatSystem('');
    setCoatingKind('');
    setFoamKind('');
    setFoamIso48('');
    setFoamIso44('');
    setFoamGranules(false);
    setFoamExtraSpf(false);
    setFoamScarify(false);
    setCoatingExtraPass(false);
    setCoatingPressureWash(false);
    setProductColors({});
    setCambridgeColor('');
    setDynastyColor('');
    setArmourshakeColor('');
    setSelectedUnderlayment('');
    setFasciaMode('');
    setDeckingMode('');
    setFasciaType('');
    setModifiedBitumenSquares('');
    setModifiedBitumenColor('');
    setDripEdgeColor('');
    setNegotiatedPrice(0);
    setOriginalTotalForBuffer(0);
    setEstimatorTotalPrice(0);
    setActiveMeasurementId(null);
    setShowProfessionalEstimate(false);
    setHasUnsavedChanges(false);
  };

  /** Format squares for estimator inputs (always a clean numeric string). */
  const formatSquaresField = (n: number | undefined | null) => {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return '';
    // Keep one decimal when needed (28.5), else whole number
    const rounded = Math.round(v * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  };

  /** Map measurement waste fraction → estimator select values ("0.10"). */
  const formatWasteField = (w: number | undefined | null) => {
    const v = Number(w);
    if (!Number.isFinite(v) || v < 0) return '0.10';
    return Math.min(0.15, Math.max(0, v)).toFixed(2);
  };

  const applyMeasurementToEstimator = (m: RoofMeasurement, lead?: Lead | null) => {
    skipUnsavedMarkRef.current = true;
    if (lead) {
      setCurrentLeadId(lead.id);
      setClientFirstName(lead.clientFirstName || '');
      setClientLastName(lead.clientLastName || '');
      setClientAddress(lead.clientAddress || '');
      setClientCity(lead.clientCity || '');
      setClientState(lead.clientState || '');
      setClientZip(lead.clientZip || '');
      setClientPhone(displayPhoneUS(lead.clientPhone || ''));
      setClientEmail(lead.clientEmail || '');
      setClientJobNumber(lead.jobNumber || '');
    }

    const roofType = m.roofType || 'pitched-shingles';
    const pitchedSq = Number(m.squares) || 0;
    const flatSq = Number(m.flatSquares) || 0;

    if (roofType === 'flat-modified-bitumen') {
      // Flat only — put area in Modified Bitumen (flat) squares field
      setSquares('');
      setModifiedBitumenSquares(formatSquaresField(flatSq || pitchedSq));
      setPitch('Flat');
      setModifiedBitumenColor((c) => c || 'Thunder Black');
    } else if (roofType === 'mixed') {
      setSquares(formatSquaresField(pitchedSq));
      setModifiedBitumenSquares(formatSquaresField(flatSq));
      setPitch(m.pitch && m.pitch !== 'Flat' ? m.pitch : '6/12');
      if (flatSq > 0) setModifiedBitumenColor((c) => c || 'Thunder Black');
    } else {
      // Pitched shingles — always fill TOTAL SQUARES; flat/MB only if present
      setSquares(formatSquaresField(pitchedSq));
      setModifiedBitumenSquares(formatSquaresField(flatSq));
      setPitch(m.pitch && m.pitch !== 'Flat' ? m.pitch : '6/12');
      if (flatSq > 0) setModifiedBitumenColor((c) => c || 'Thunder Black');
    }

    setWaste(formatWasteField(m.waste));
    setLayers((prev) => prev || '1');
    if (m.ridgeLF != null && Number(m.ridgeLF) > 0) {
      setRidgeVentLF(String(Math.round(Number(m.ridgeLF) * 10) / 10));
    }
    if (m.eaveLF != null && Number(m.eaveLF) > 0) {
      setFasciaLF(String(Math.round(Number(m.eaveLF) * 10) / 10));
    }
    setActiveMeasurementId(m.id);
    setHasUnsavedChanges(false);
  };

  /** Structured + free-form geocode via server proxy (house-level). */
  const geocodeStructuredAddress = async (parts: {
    street: string;
    city?: string;
    state?: string;
    zip?: string;
  }): Promise<LatLngPoint | null> => {
    const street = (parts.street || '').trim();
    const city = (parts.city || '').trim();
    const state = (parts.state || '').trim();
    const zip = (parts.zip || '').trim();
    if (!street && !city && !zip) return null;

    const result = await geocodeAddressApi({ street, city, state, zip });
    return result?.point ?? null;
  };

  /** Wipe map/trace state so the next session never shows the previous house. */
  const clearMapSession = () => {
    geocodeReqIdRef.current += 1;
    setTracePoints([]);
    setMapCenter(null);
    setAddressGeocodeFailed(false);
    setMapSessionKey((k) => k + 1);
    setSelectedMeasurementId(null);
    setDraftSections([]);
    sectionKindRef.current = 'pitched';
    setSectionKind('pitched');
    setMeasurePitch('6/12');
    setMeasurePitchAuto(true);
    setMeasureWaste(0.1);
    setMeasureWasteAuto(true);
  };

  /** Reset tracer + map to a clean session for a new lead/address. */
  const beginNewMeasurementSession = (opts?: {
    prefillLabel?: string;
    center?: LatLngPoint | null;
    preferManual?: boolean;
  }) => {
    setTracePoints([]);
    setSelectedMeasurementId(null);
    setDraftSections([]);
    setMeasurePitch('6/12');
    setMeasurePitchAuto(true);
    setMeasureWaste(0.1);
    setMeasureWasteAuto(true);
    sectionKindRef.current = 'pitched';
    setSectionKind('pitched');
    setMeasureLabel(opts?.prefillLabel || '');
    setMapCenter(opts?.center ?? null);
    setAddressGeocodeFailed(!!opts?.preferManual || !opts?.center);
    setMapSessionKey((k) => k + 1);
    setShowTracer(true);
  };

  /**
   * Switch section type without remounting the map.
   * Kind is snapshotted at commit time so either flat-first or pitched-first
   * registers correctly regardless of later UI state.
   *
   * @param opts.clearTrace — after committing a section the map is empty; do not
   *   estimate pitch/waste from the just-cleared outline still in this render.
   */
  const prepareSectionKind = (
    kind: RoofSectionKind,
    opts?: { preferAutoPitch?: boolean; clearTrace?: boolean }
  ) => {
    // Update ref immediately so polygon-complete / save never see a stale kind
    sectionKindRef.current = kind;
    setSectionKind(kind);
    const pts =
      opts?.clearTrace || tracePoints.length < 3 ? [] : tracePoints;
    if (kind === 'flat') {
      setMeasurePitch('Flat');
      setMeasurePitchAuto(true);
      if (measureWasteAuto || opts?.clearTrace) setMeasureWaste(0.05);
      return;
    }
    // Pitched: never keep residual Flat pitch from a prior flat section
    setMeasurePitchAuto(opts?.preferAutoPitch ?? true);
    if (pts.length >= 3 && (opts?.preferAutoPitch ?? measurePitchAuto)) {
      setMeasurePitch(estimatePitchFromPolygon(pts, 'pitched-shingles'));
    } else {
      setMeasurePitch('6/12');
    }
    if (measureWasteAuto || opts?.clearTrace) {
      setMeasureWaste(
        pts.length >= 3
          ? estimateWasteFromPolygon(pts, 'pitched-shingles')
          : 0.1
      );
    }
  };

  /** Build a section from the current map outline (if valid). Kind is snapshotted. */
  const buildCurrentSection = (
    kind: RoofSectionKind = sectionKind
  ): RoofSection | null => {
    if (tracePoints.length < 3) return null;
    return buildRoofSection(tracePoints, {
      kind,
      label: kind === 'flat' ? 'Flat section' : 'Pitched section',
      pitch: kind === 'flat' ? 'Flat' : measurePitch === 'Flat' ? '6/12' : measurePitch,
      waste: measureWaste,
      autoPitch: measurePitchAuto && kind === 'pitched',
      autoWaste: measureWasteAuto,
    });
  };

  /**
   * Commit current outline as a section. Clears the map for an optional next
   * section. Order is free: flat or pitched first both work; UI prompts next step.
   */
  const addSectionToDraft = () => {
    // Snapshot kind + points before any state updates (order-safe)
    const committedKind = sectionKindRef.current;
    const section = buildCurrentSection(committedKind);
    if (!section) {
      showToast('Trace at least 3 corners before adding a section');
      return;
    }
    // Guard: section kind must match the UI selection at commit
    if (section.kind !== committedKind) {
      showToast('Section type mismatch — try again');
      return;
    }
    const nextDraft = [...draftSections, section];
    const hasPitched = nextDraft.some((s) => s.kind === 'pitched');
    const hasFlat = nextDraft.some((s) => s.kind === 'flat');

    setDraftSections(nextDraft);
    setTracePoints([]);
    setMapSessionKey((k) => k + 1);

    // Suggest complementary type if missing; clearTrace so we don't reuse the
    // just-committed outline for pitch/waste estimates in this same render.
    if (committedKind === 'flat' && !hasPitched) {
      // Flat done → ready for pitched (optional) or Save & finish
      prepareSectionKind('pitched', { clearTrace: true });
      showToast('Flat added · next: pitched section, or Save to finish');
    } else if (committedKind === 'pitched' && !hasFlat) {
      prepareSectionKind('flat', { clearTrace: true });
      showToast('Pitched added · next: flat section, or Save to finish');
    } else if (committedKind === 'flat') {
      prepareSectionKind('pitched', { clearTrace: true });
      showToast('Flat section added · add more or Save to finish');
    } else {
      prepareSectionKind('flat', { clearTrace: true });
      showToast('Pitched section added · add more or Save to finish');
    }
  };

  const removeDraftSection = (id: string) => {
    setDraftSections((prev) => prev.filter((s) => s.id !== id));
  };

  /** Open measurements on the current lead profile (or prompt). */
  const openHomeMeasurements = () => {
    setShowProfessionalEstimate(false);
    setShowMeasureAddressModal(false);
    setShowEstimatePicker(false);
    setHubReport(null);
    if (currentLeadId != null) {
      const lead = leads.find((l) => l.id === currentLeadId);
      if (lead) {
        if (!isEditingLead) loadLeadIntoForm(lead);
        setProfileTab('measurements');
        setActiveTab('leads');
        return;
      }
    }
    setActiveTab('leads');
    showToast('Open a lead to measure the roof');
  };

  /** Choose a lead before estimate / internal (profile-bound). */
  const openEstimatePicker = (mode?: EstimateWorkspace) => {
    setShowProfessionalEstimate(false);
    setShowMeasureAddressModal(false);
    if (mode) setEstimatePickerMode(mode);
    setEstimatePickerQuery('');
    setShowEstimatePicker(true);
  };

  const allEstimates = (): Array<{
    lead: Lead;
    estimate: Estimate;
    leadName: string;
  }> => {
    const items: Array<{
      lead: Lead;
      estimate: Estimate;
      leadName: string;
    }> = [];
    for (const lead of leads) {
      const name =
        [lead.clientFirstName, lead.clientLastName].filter(Boolean).join(' ') ||
        lead.clientAddress ||
        'Unassigned lead';
      for (const estimate of lead.estimates || []) {
        items.push({ lead, estimate, leadName: name });
      }
    }
    return items.sort((a, b) => {
      const ta = Number(a.estimate.id) || 0;
      const tb = Number(b.estimate.id) || 0;
      return tb - ta;
    });
  };

  /** Global estimates list (nav / home). */
  const openEstimatesHub = () => {
    setShowProfessionalEstimate(false);
    setShowMeasureAddressModal(false);
    setShowEstimatePicker(false);
    setHubReport(null);
    setIsEditingLead(false);
    setActiveTab('estimates');
  };

  /** Lead profile: open Measurements tab (address already on lead). */
  const openMeasureRoof = (leadId?: number) => {
    setShowProfessionalEstimate(false);
    setShowMeasureAddressModal(false);
    const lead =
      (leadId && leads.find((l) => l.id === leadId)) ||
      (currentLeadId && leads.find((l) => l.id === currentLeadId)) ||
      null;

    if (lead) {
      loadLeadIntoForm(lead);
      setProfileTab('measurements');
      setShowTracer(false);
      clearMapSession();
      setSelectedMeasurementId(
        lead.measurements?.length
          ? lead.measurements[lead.measurements.length - 1].id
          : null
      );
      setActiveTab('leads');
      setIsEditingLead(true);

      // Prefetch geocode so New Measurement centers immediately
      const street = lead.clientAddress || '';
      const city = lead.clientCity || '';
      const state = lead.clientState || '';
      const zip = lead.clientZip || '';
      if (street || city || zip) {
        const reqId = ++geocodeReqIdRef.current;
        void geocodeStructuredAddress({ street, city, state, zip }).then((pt) => {
          if (reqId !== geocodeReqIdRef.current) return; // stale lead/address
          if (pt) {
            setMapCenter(pt);
            setAddressGeocodeFailed(false);
          } else {
            setAddressGeocodeFailed(true);
          }
        });
      }
      return;
    }

    openHomeMeasurements();
  };

  const submitMeasureAddress = async () => {
    const street = measureAddrStreet.trim();
    if (!street) {
      showToast('Enter a street address');
      return;
    }
    const city = measureAddrCity.trim();
    const state = measureAddrState.trim();
    const zip = measureAddrZip.trim();

    // Always create/open lead from address — never block on geocode
    const newLead = createEmptyLead({
      category: 'Lead',
      clientAddress: street,
      clientCity: city,
      clientState: state,
      clientZip: zip,
    });
    const updated = [newLead, ...leads];
    persistLeads(updated);
    loadLeadIntoForm(newLead);

    // Wipe previous house/trace; keep tracer closed until geocode finishes
    clearMapSession();
    setShowTracer(false);

    const reqId = ++geocodeReqIdRef.current;
    setGeocoding(true);
    const center = await geocodeStructuredAddress({
      street,
      city,
      state,
      zip,
    });
    setGeocoding(false);
    if (reqId !== geocodeReqIdRef.current) return;

    beginNewMeasurementSession({
      prefillLabel: street,
      center,
      preferManual: !center,
    });
    setProfileTab('measurements');
    setActiveTab('leads');
    setIsEditingLead(true);
    setShowMeasureAddressModal(false);
    showToast(
      center
        ? 'Map centered on address — trace the roof'
        : 'Address saved — map not found; use street map or manual area'
    );
  };

  const startNewMeasurementOnLead = async () => {
    const street = clientAddress.trim();
    const city = clientCity.trim();
    const state = clientState.trim();
    const zip = clientZip.trim();

    // Clear previous session first — never keep last house pin/trace
    clearMapSession();
    setShowTracer(false); // don't mount map on default Phoenix while geocoding
    setMeasurePitch('6/12');
    setMeasurePitchAuto(true);
    setMeasureWaste(0.1);
    setMeasureLabel(street || '');

    if (!street && !city && !zip) {
      beginNewMeasurementSession({
        prefillLabel: '',
        center: null,
        preferManual: true,
      });
      showToast('Add a property address above, or enter area manually');
      return;
    }

    const reqId = ++geocodeReqIdRef.current;
    setGeocoding(true);
    // Always re-geocode this lead's current address (never reuse prior house)
    const center = await geocodeStructuredAddress({
      street: street || city,
      city,
      state,
      zip,
    });
    setGeocoding(false);
    if (reqId !== geocodeReqIdRef.current) return;

    beginNewMeasurementSession({
      prefillLabel: street || 'Roof',
      center,
      preferManual: !center,
    });
    showToast(
      center
        ? 'Map centered on property — click corners to trace'
        : 'Could not locate address — use street map or manual area'
    );
  };

  /**
   * Single Save: combines all draft sections + optional in-progress outline
   * into one report (pitched + flat squares on the same measurement).
   */
  const saveRoofMeasurement = (): RoofMeasurement | null => {
    if (!currentLeadId) {
      showToast('Open a lead first');
      return null;
    }

    // Snapshot kind at save so flat-first / pitched-first both register correctly
    const current = buildCurrentSection(sectionKindRef.current);
    const sections = current
      ? [...draftSections, current]
      : [...draftSections];

    if (sections.length === 0) {
      showToast('Add at least one section (3+ corners), then Save');
      return null;
    }

    const measurement = aggregateSectionsToMeasurement(sections, {
      label: measureLabel.trim() || clientAddress || 'Roof',
      center: mapCenter || undefined,
    });

    const withAddress = leads.map((lead) =>
      lead.id === currentLeadId
        ? {
            ...lead,
            clientAddress: clientAddress || lead.clientAddress,
            clientCity: clientCity || lead.clientCity,
            clientState: clientState || lead.clientState,
            clientZip: clientZip || lead.clientZip,
            measurements: [...(lead.measurements || []), measurement],
          }
        : lead
    );
    persistLeads(withAddress);
    setSelectedMeasurementId(measurement.id);
    setShowTracer(false);
    setTracePoints([]);
    setDraftSections([]);
    sectionKindRef.current = 'pitched';
    setSectionKind('pitched');

    const pitched = measurement.squares || 0;
    const flat = measurement.flatSquares || 0;
    showToast(
      sections.length > 1
        ? `Saved report · ${sections.length} sections · ${pitched} pitched + ${flat} flat sq`
        : flat > 0 && pitched <= 0
          ? `Saved · ${flat} flat squares`
          : `Saved · ${pitched} pitched squares`
    );
    return measurement;
  };

  const recenterMapOnAddress = async () => {
    const street = clientAddress.trim();
    const city = clientCity.trim();
    const state = clientState.trim();
    const zip = clientZip.trim();
    if (!street && !city && !zip) {
      showToast('Enter an address first');
      return;
    }
    const reqId = ++geocodeReqIdRef.current;
    setGeocoding(true);
    const center = await geocodeStructuredAddress({
      street: street || city,
      city,
      state,
      zip,
    });
    setGeocoding(false);
    if (reqId !== geocodeReqIdRef.current) return;
    if (center) {
      setMapCenter(center);
      setAddressGeocodeFailed(false);
      setMapSessionKey((k) => k + 1);
      showToast('Map centered on address');
    } else {
      setAddressGeocodeFailed(true);
      showToast('Could not find that address');
    }
  };

  const deleteRoofMeasurement = (measurementId: string) => {
    if (!currentLeadId) return;
    if (!confirm('Move this measurement to trash?')) return;
    const lead = leads.find((l) => l.id === currentLeadId);
    const measurement = lead?.measurements?.find((m) => m.id === measurementId);
    if (!lead || !measurement) return;
    const updated = leads.map((l) =>
      l.id === currentLeadId
        ? {
            ...l,
            measurements: (l.measurements || []).filter(
              (m) => m.id !== measurementId
            ),
          }
        : l
    );
    persistLeads(updated);
    persistTrash([
      {
        id: `${Date.now()}-roof-${measurementId}`,
        kind: 'roofMeasurement',
        deletedAt: new Date().toLocaleString(),
        leadId: currentLeadId,
        leadLabel: leadLabelFor(lead),
        measurement,
      },
      ...trash,
    ]);
    if (selectedMeasurementId === measurementId) setSelectedMeasurementId(null);
    if (activeMeasurementId === measurementId) setActiveMeasurementId(null);
    
  showToast('Moved to trash');
  };

  /** Soft-delete a single estimate → app trash */
  const removeLeadEstimate = (estimateId: number) => {
    if (!currentLeadId) return;
    if (!confirm('Move this estimate to trash?')) return;
    const lead = leads.find((l) => l.id === currentLeadId);
    if (!lead) return;
    const estimate = (lead.estimates || []).find((e) => e.id === estimateId);
    if (!estimate) return;

    const updated = leads.map((l) =>
      l.id === currentLeadId
        ? { ...l, estimates: (l.estimates || []).filter((e) => e.id !== estimateId) }
        : l
    );
    persistLeads(updated);

    persistTrash([
      {
        id: `${Date.now()}-est`,
        kind: 'estimate',
        deletedAt: new Date().toLocaleString(),
        leadId: currentLeadId,
        leadLabel: leadLabelFor(lead),
        estimate,
      },
      ...trash,
    ]);
    showToast('Estimate moved to trash');
  };

  /** Soft-delete a single note by index → app trash (LeadNote has no stable id). */
  const removeLeadNote = (noteIndex: number) => {
    if (!currentLeadId) return;
    if (!confirm('Move this note to trash?')) return;
    const lead = leads.find((l) => l.id === currentLeadId);
    if (!lead) return;
    const notes = lead.notes || [];
    if (noteIndex < 0 || noteIndex >= notes.length) return;
    const note = notes[noteIndex];

    const updated = leads.map((l) =>
      l.id === currentLeadId
        ? { ...l, notes: notes.filter((_, i) => i !== noteIndex) }
        : l
    );
    persistLeads(updated);

    persistTrash([
      {
        id: `${Date.now()}-note`,
        kind: 'note',
        deletedAt: new Date().toLocaleString(),
        leadId: currentLeadId,
        leadLabel: leadLabelFor(lead),
        note,
      },
      ...trash,
    ]);
    showToast('Note moved to trash');
  };

  /** Open estimate (or internal) workspace inside a lead profile. */
  const enterLeadEstimator = (
    leadId: number,
    workspace: EstimateWorkspace = 'estimate',
    opts?: { flow?: 'pick' | 'estimate' }
  ) => {
    setShowEstimatePicker(false);
    setShowProfessionalEstimate(false);
    setShowMeasureAddressModal(false);
    setHubReport(null);
    setEstimatorSourceLeadId(leadId);
    setCurrentLeadId(leadId);
    setIsEditingLead(true);
    setActiveTab('leads');
    setEstimateFlow(opts?.flow ?? 'pick');
    setProfileTab('estimator');
    setEstimateWorkspace(workspace);
  };

  /**
   * Start a new estimate — always inside lead profile with that lead's contact.
   */
  const startNewEstimate = (opts?: {
    fromLeadId?: number | null;
    workspace?: EstimateWorkspace;
  }) => {
    setShowProfessionalEstimate(false);
    setShowMeasureAddressModal(false);

    const workspace = opts?.workspace ?? estimatePickerMode;
    const fromId: number | null =
      opts?.fromLeadId ??
      (isEditingLead && currentLeadId != null ? currentLeadId : null) ??
      currentLeadId;

    if (fromId == null) {
      openEstimatePicker(workspace);
      return;
    }

    // Persist open profile edits before switching into estimator
    if (currentLeadId != null && isEditingLead) {
      saveLeadDraft({ silent: true });
    }

    const stored = leads.find((l) => l.id === fromId);
    if (!stored) {
      showToast('Lead not found');
      return;
    }

    // Full lead form state (contact, address, insurance, etc.)
    applyLeadFields(stored);
    // Prefer live form overrides when starting from the open profile
    const resolvedLead: Lead = {
      ...stored,
      ...(isEditingLead && currentLeadId === fromId ? buildLeadFormPatch() : {}),
      id: fromId,
      measurements: stored.measurements || [],
    };

    const name =
      [resolvedLead.clientFirstName, resolvedLead.clientLastName]
        .filter(Boolean)
        .join(' ') || 'lead';

    const fillLeadContact = () => {
      setClientFirstName(resolvedLead.clientFirstName || '');
      setClientLastName(resolvedLead.clientLastName || '');
      setClientAddress(resolvedLead.clientAddress || '');
      setClientCity(resolvedLead.clientCity || '');
      setClientState(resolvedLead.clientState || '');
      setClientZip(resolvedLead.clientZip || '');
      setClientPhone(displayPhoneUS(resolvedLead.clientPhone || ''));
      setClientEmail(resolvedLead.clientEmail || '');
      setClientJobNumber(resolvedLead.jobNumber || '');
    };

    const measurements = resolvedLead.measurements || [];
    let appliedMeasurement = false;
    if (measurements.length > 0 && workspace === 'estimate') {
      const useIt = confirm(
        'This lead has a roof measurement. Apply it to the new estimate?\n\nOK = apply · Cancel = blank estimate (keep lead contact)'
      );
      if (useIt) {
        resetEstimatorFields(true);
        fillLeadContact();
        const latest = measurements[measurements.length - 1];
        applyMeasurementToEstimator(latest, resolvedLead);
        appliedMeasurement = true;
        const pitched = Number(latest.squares) || 0;
        const flat = Number(latest.flatSquares) || 0;
        showToast(
          flat > 0 && pitched > 0
            ? `Estimate for ${name} · ${pitched} pitched + ${flat} flat sq`
            : flat > 0
              ? `Estimate for ${name} · ${flat} flat squares`
              : `Estimate for ${name} · ${pitched || 0} pitched squares`
        );
      }
    }

    if (!appliedMeasurement) {
      resetEstimatorFields(true);
      fillLeadContact();
      showToast(
        workspace === 'internal'
          ? `Internal for ${name}`
          : `New estimate for ${name}`
      );
    }

    enterLeadEstimator(fromId, workspace);
  };

  const handleTabChange = (newTab: AppTab) => {
    // Leaving in-profile estimate with dirty changes
    if (
      hasUnsavedChanges &&
      isEditingLead &&
      profileTab === 'estimator' &&
      !(newTab === 'leads' && isEditingLead)
    ) {
      const stayToSave = confirm(
        'Unsaved estimate changes.\n\nOK = stay and save · Cancel = discard and leave'
      );
      if (stayToSave) return;
      const keepContact = estimatorSourceLeadId != null || currentLeadId != null;
      resetEstimatorFields(keepContact);
      setHasUnsavedChanges(false);
      if (!keepContact) setCurrentLeadId(null);
    }

    // Draft-save open lead when navigating away from profile
    if (
      isEditingLead &&
      currentLeadId != null &&
      activeTab === 'leads' &&
      newTab !== 'leads'
    ) {
      saveLeadDraft({ silent: true });
    }

    setShowProfessionalEstimate(false);
    setShowUserMenu(false);
    setHeaderSearch('');

    if (newTab !== 'leads') {
      setIsEditingLead(false);
      setProfileTab('overview');
      if (profileTab === 'estimator') setEstimateWorkspace('estimate');
    }
    if (newTab !== 'leads') {
      setEstimatorSourceLeadId(null);
    }
    setActiveTab(newTab);
  };

  const loadEstimate = (estimate: Estimate, opts?: { leadId?: number }) => {
    skipUnsavedMarkRef.current = true;
    // Roof / product fields from the saved estimate
    setSquares(estimate.squares || '');
    setLayers(estimate.layers || '');
    setWaste(estimate.waste || '');
    setPitch(estimate.pitch || '');
    setStories((estimate.stories as '1' | '2' | '') || '');
    setFasciaLF(estimate.fasciaLF || '');
    setDeckingSheets(estimate.deckingSheets || '');
    setDeckingOsbSheets(estimate.deckingOsbSheets || '');
    setDeckingCdxSheets(estimate.deckingCdxSheets || '');
    setSolarPanels(estimate.solarPanels || '');
    setHvacUnits(estimate.hvacUnits || '');
    setSkylights(estimate.skylights || '');
    setRidgeVentLF(estimate.ridgeVentLF || '');
    setGutterMode(
      estimate.gutterMode === 'dr' || estimate.gutterMode === 'rr'
        ? estimate.gutterMode
        : 'none'
    );
    setGutterLF(estimate.gutterLF || '');
    const product = String(estimate.selectedShingle || '');
    setSelectedShingle((product as ShingleType) || '');
    // Infer roof system + flat tree from saved product
    if (
      product.startsWith('tile') ||
      product === 'sa_underlayment' ||
      product === 'sa-high-temp'
    ) {
      setRoofSystem('tile');
      setFlatSystem('');
      setCoatingKind('');
      setFoamKind('');
    } else if (
      [
        'coating',
        'elastomeric',
        'silicone',
        'urethane',
        'full_foam',
        'foam_overlay',
        'mod_bitumen',
        'bur',
      ].includes(product)
    ) {
      setRoofSystem('flat');
      if (product === 'mod_bitumen') {
        setFlatSystem('mod_bit');
        setCoatingKind('');
        setFoamKind('');
      } else if (product === 'bur') {
        setFlatSystem('bur');
        setCoatingKind('');
        setFoamKind('');
      } else if (product === 'full_foam') {
        setFlatSystem('foam');
        setFoamKind('full');
        setCoatingKind('');
      } else if (product === 'foam_overlay') {
        setFlatSystem('foam');
        setFoamKind('overlay');
        setCoatingKind('');
      } else if (
        product === 'elastomeric' ||
        product === 'silicone' ||
        product === 'urethane' ||
        product === 'coating'
      ) {
        setFlatSystem('coating');
        setCoatingKind(
          product === 'coating' ? 'elastomeric' : (product as CoatingKind)
        );
        setFoamKind('');
      }
    } else {
      setRoofSystem('shingle');
      setFlatSystem('');
      setCoatingKind('');
      setFoamKind('');
    }
    setCambridgeColor(estimate.cambridgeColor || '');
    setDynastyColor(estimate.dynastyColor || '');
    setArmourshakeColor(estimate.armourshakeColor || '');
    setSelectedUnderlayment(estimate.selectedUnderlayment || '');
    setFasciaMode(estimate.fasciaMode || '');
    setDeckingMode(estimate.deckingMode || '');
    setFasciaType(estimate.fasciaType || '');
    setModifiedBitumenSquares(estimate.modifiedBitumenSquares || '');
    setModifiedBitumenColor(estimate.modifiedBitumenColor || '');
    setDripEdgeColor(estimate.dripEdgeColor || '');
    setNotes(estimate.notes || '');
    setEstimatorTotalPrice(estimate.negotiatedPrice || estimate.total || 0);
    setNegotiatedPrice(estimate.negotiatedPrice || estimate.total || 0);
    setOriginalTotalForBuffer(estimate.originalTotalForBuffer || estimate.total || 0);
    setHasUnsavedChanges(false);
    setShowEstimatePicker(false);
    // Contact always from the live lead, never the estimate snapshot
    const linkId = opts?.leadId ?? currentLeadId;
    if (linkId != null) {
      const lead = leads.find((l) => l.id === linkId);
      if (lead) applyLeadFields(lead);
      enterLeadEstimator(linkId, 'estimate', { flow: 'estimate' });
    } else {
      // Unlinked legacy estimate — show snapshot only as last resort
      setClientFirstName(estimate.clientFirstName || '');
      setClientLastName(estimate.clientLastName || '');
      setClientAddress(estimate.clientAddress || '');
      setClientCity(estimate.clientCity || '');
      setClientState(estimate.clientState || '');
      setClientZip(estimate.clientZip || '');
      setClientPhone(displayPhoneUS(estimate.clientPhone || ''));
      setClientEmail(estimate.clientEmail || '');
      setClientJobNumber(estimate.clientJobNumber || '');
      setIsEditingLead(true);
      setEstimateFlow('estimate');
      setProfileTab('estimator');
      setEstimateWorkspace('estimate');
    }
    showToast('Estimate loaded');
  };

  // Close header menus / sidebar profile / mobile drawer when clicking outside or Escape
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest?.('[data-header-menu]')) {
        setShowUserMenu(false);
      }
      if (!el.closest?.('[data-sidebar-profile]')) {
        setSidebarProfileOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowUserMenu(false);
        setSidebarProfileOpen(false);
        setSidebarOpen(false);
        setHeaderSearch('');
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // Lock body scroll while mobile sidebar is open
  useEffect(() => {
    if (!sidebarOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [sidebarOpen]);

  // Mark estimator dirty when the user edits fields (skip after reset / load).
  // activeTab is read via ref so switching tabs does not itself mark dirty.
  useEffect(() => {
    if (skipUnsavedMarkRef.current) {
      skipUnsavedMarkRef.current = false;
      return;
    }
    // Dirty only while editing estimate roof/product fields (contact is lead-owned)
    if (!(isEditingLead && profileTab === 'estimator')) return;
    setHasUnsavedChanges(true);
  }, [
    isEditingLead,
    profileTab,
    squares,
    layers,
    waste,
    pitch,
    stories,
    fasciaLF,
    deckingSheets,
    deckingOsbSheets,
    deckingCdxSheets,
    solarPanels,
    hvacUnits,
    skylights,
    ridgeVentLF,
    gutterMode,
    gutterLF,
    notes,
    selectedShingle,
    flatSystem,
    coatingKind,
    foamKind,
    foamIso48,
    foamIso44,
    foamGranules,
    foamExtraSpf,
    foamScarify,
    coatingExtraPass,
    coatingPressureWash,
    cambridgeColor,
    dynastyColor,
    armourshakeColor,
    selectedUnderlayment,
    fasciaMode,
    deckingMode,
    fasciaType,
    modifiedBitumenSquares,
    modifiedBitumenColor,
    dripEdgeColor,
    negotiatedPrice,
  ]);

  const showToast = (message: string) => {
    setToastMessage(message);
    window.setTimeout(() => setToastMessage(null), 2500);
  };

  const persistLeads = (updated: Lead[]) => {
    setLeads(updated);
    try {
      localStorage.setItem('summitLeads', JSON.stringify(updated));
    } catch {
      /* ignore quota */
    }

    // Best-effort cloud write: leads (+ new estimates only)
    if (supabaseEnabled && supabase) {
      void (async () => {
        for (const lead of updated) {
          try {
            const payload = mapAppLeadToDb(lead);
            let cloudLeadId = lead.supabaseId?.trim() || '';

            if (cloudLeadId) {
              const { error } = await supabase
                .from('leads')
                .update(payload)
                .eq('id', cloudLeadId);
              if (error) console.error('Supabase lead update error:', error);
            } else {
              const { data, error } = await supabase
                .from('leads')
                .insert(payload)
                .select('id')
                .single();
              if (error) {
                console.error('Supabase lead insert error:', error);
                continue;
              }
              if (data?.id) {
                cloudLeadId = String(data.id);
                setLeads((prev) => {
                  const next = prev.map((l) =>
                    l.id === lead.id && !l.supabaseId
                      ? { ...l, supabaseId: cloudLeadId }
                      : l
                  );
                  try {
                    localStorage.setItem('summitLeads', JSON.stringify(next));
                  } catch {
                    /* ignore */
                  }
                  return next;
                });
              }
            }

            if (!cloudLeadId || !Array.isArray(lead.estimates)) continue;

            // Only insert estimates that have not been synced yet
            for (const est of lead.estimates) {
              if (est.supabaseId) continue;
              try {
                const estPayload = {
                  lead_id: cloudLeadId,
                  type: 'roof',
                  material: est.selectedShingle || null,
                  rate: null as number | null,
                  labor: null as number | null,
                  status: 'saved',
                  data: est,
                  updated_at: new Date().toISOString(),
                };
                const { data: estRow, error: estErr } = await supabase
                  .from('estimates')
                  .insert(estPayload)
                  .select('id')
                  .single();
                if (estErr) {
                  console.error('Supabase estimate insert error:', estErr);
                  continue;
                }
                if (estRow?.id) {
                  const estCloudId = String(estRow.id);
                  setLeads((prev) => {
                    const next = prev.map((l) => {
                      if (l.id !== lead.id) return l;
                      return {
                        ...l,
                        supabaseId: l.supabaseId || cloudLeadId,
                        estimates: (l.estimates || []).map((e) =>
                          e.id === est.id && !e.supabaseId
                            ? { ...e, supabaseId: estCloudId }
                            : e
                        ),
                      };
                    });
                    try {
                      localStorage.setItem('summitLeads', JSON.stringify(next));
                    } catch {
                      /* ignore */
                    }
                    return next;
                  });
                }
              } catch (e) {
                console.error('Estimate sync error:', e);
              }
            }
          } catch (err) {
            console.error('Supabase persist error:', err);
          }
        }
      })();
    }
  };

  const refreshGcalStatus = async () => {
    // Prefer browser GIS session (Client ID only — no secret required)
    try {
      const {
        isBrowserGcalConfigured,
        readBrowserGcalSession,
        loadGoogleIdentityScript,
      } = await import('@/lib/gcal-browser');
      setGcalConfigured(isBrowserGcalConfigured());
      void loadGoogleIdentityScript().catch(() => undefined);
      const session = readBrowserGcalSession();
      if (session) {
        setGcalConnected(true);
        setGcalEmail(session.email ?? null);
        setGcalName(null);
        return;
      }
    } catch {
      /* ignore */
    }

    // Fallback: server OAuth cookie session
    try {
      const res = await fetch('/api/google/calendar/status', {
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        configured?: boolean;
        connected?: boolean;
        email?: string | null;
        name?: string | null;
      };
      setGcalConfigured((c) => c || Boolean(data.configured));
      setGcalConnected(Boolean(data.connected));
      setGcalEmail(data.email ?? null);
      setGcalName(data.name ?? null);
    } catch {
      /* offline / unconfigured */
    }
  };

  const loadGoogleEvents = async (opts?: { silent?: boolean }) => {
    try {
      const { readBrowserGcalSession, listUpcomingGoogleEvents } = await import(
        '@/lib/gcal-browser'
      );
      const session = readBrowserGcalSession();
      if (!session?.accessToken) {
        if (!opts?.silent) {
          showToast('Connect Google Calendar first');
        }
        return;
      }
      setGoogleEventsLoading(true);
      const items = await listUpcomingGoogleEvents(session.accessToken, {
        maxResults: 25,
      });
      setGoogleCalendarEvents(items);
      if (!opts?.silent) {
        showToast(
          items.length === 0
            ? 'No upcoming Google events'
            : `Loaded ${items.length} Google event${items.length === 1 ? '' : 's'}`
        );
      }
    } catch (e) {
      if (!opts?.silent) {
        showToast(
          e instanceof Error ? e.message : 'Could not load Google events'
        );
      }
      if (
        e instanceof Error &&
        /expired|401|reconnect/i.test(e.message)
      ) {
        setGcalConnected(false);
        setGoogleCalendarEvents([]);
      }
    } finally {
      setGoogleEventsLoading(false);
    }
  };

  const connectGoogleCalendar = async () => {
    setGcalBusy(true);
    try {
      const { connectGoogleCalendarBrowser } = await import('@/lib/gcal-browser');
      const session = await connectGoogleCalendarBrowser();
      setGcalConfigured(true);
      setGcalConnected(true);
      setGcalEmail(session.email ?? null);
      setGcalName(null);
      showToast('Google Calendar connected');
      void loadGoogleEvents({ silent: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Connection failed';
      // Fall back to server OAuth redirect if browser GIS fails and secret is set
      if (msg.includes('Missing NEXT_PUBLIC')) {
        showToast(msg);
      } else {
        try {
          const res = await fetch('/api/google/calendar/status', {
            cache: 'no-store',
          });
          const data = (await res.json()) as { configured?: boolean };
          if (data.configured) {
            window.location.href = '/api/google/calendar/auth';
            return;
          }
        } catch {
          /* ignore */
        }
        showToast(msg);
      }
    } finally {
      setGcalBusy(false);
    }
  };

  const disconnectGoogleCalendar = async () => {
    setGcalBusy(true);
    try {
      const { disconnectGoogleCalendarBrowser } = await import(
        '@/lib/gcal-browser'
      );
      disconnectGoogleCalendarBrowser();
      await fetch('/api/google/calendar/disconnect', { method: 'POST' }).catch(
        () => undefined
      );
      setGcalConnected(false);
      setGcalEmail(null);
      setGcalName(null);
      setGoogleCalendarEvents([]);
      showToast('Google Calendar disconnected');
    } catch {
      showToast('Could not disconnect');
    } finally {
      setGcalBusy(false);
    }
  };

  /** Push open jobs/leads to the connected Google Calendar (all-day follow-ups). */
  const syncLeadsToGoogleCalendar = async (opts?: {
    leadIds?: number[];
    silent?: boolean;
  }) => {
    if (!gcalConnected) {
      if (!opts?.silent) showToast('Connect Google Calendar in Settings first');
      return;
    }
    setGcalBusy(true);
    try {
      const source = opts?.leadIds
        ? leads.filter((l) => opts.leadIds!.includes(l.id))
        : leads;
      // Merge open profile form so follow-up date / contact edits sync immediately
      const payload = source.map((l) => {
        const live =
          isEditingLead && currentLeadId === l.id
            ? { ...l, ...buildLeadFormPatch() }
            : l;
        return {
          id: live.id,
          clientFirstName: live.clientFirstName,
          clientLastName: live.clientLastName,
          clientAddress: live.clientAddress,
          clientCity: live.clientCity,
          clientState: live.clientState,
          clientZip: live.clientZip,
          clientPhone: live.clientPhone,
          clientEmail: live.clientEmail,
          jobNumber: live.jobNumber,
          category: live.category,
          date: live.date,
          followUpDate: live.followUpDate,
          notes: live.notes,
          calendarEventId: live.calendarEventId,
        };
      });

      let results: Array<{
        leadId: number;
        eventId?: string;
        htmlLink?: string;
        startDate?: string;
        error?: string;
      }> = [];
      let synced = 0;

      // Prefer browser GIS token (popup OAuth)
      const {
        readBrowserGcalSession,
        syncLeadsWithBrowserToken,
        clearBrowserGcalSession,
      } = await import('@/lib/gcal-browser');
      const browserSession = readBrowserGcalSession();

      if (browserSession?.accessToken) {
        const out = await syncLeadsWithBrowserToken(
          browserSession.accessToken,
          payload,
          { skipClosed: true }
        );
        results = out.results;
        synced = out.synced;
        // Token expired / revoked
        if (
          results.some((r) =>
            (r.error || '').toLowerCase().includes('401')
          ) ||
          (results.length > 0 &&
            results.every(
              (r) => r.error && !r.eventId && r.error !== 'skipped_closed'
            ))
        ) {
          const authErr = results.find((r) =>
            /invalid|unauth|401|expired/i.test(r.error || '')
          );
          if (authErr) {
            clearBrowserGcalSession();
            setGcalConnected(false);
            showToast('Calendar session expired — connect again');
            return;
          }
        }
      } else {
        // Server cookie OAuth fallback
        const res = await fetch('/api/google/calendar/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leads: payload, skipClosed: true }),
        });
        const data = (await res.json()) as {
          error?: string;
          synced?: number;
          results?: typeof results;
        };
        if (!res.ok) {
          showToast(data.error || 'Calendar sync failed');
          if (res.status === 401) setGcalConnected(false);
          return;
        }
        results = data.results || [];
        synced = data.synced ?? results.filter((r) => r.eventId).length;
      }

      const byId = new Map(
        results.filter((r) => r.eventId).map((r) => [r.leadId, r] as const)
      );
      const syncedAt = new Date().toISOString();
      const updated = leads.map((lead) => {
        const hit = byId.get(lead.id);
        if (!hit?.eventId) return lead;
        return {
          ...lead,
          calendarEventId: hit.eventId,
          calendarHtmlLink: hit.htmlLink || lead.calendarHtmlLink,
          calendarSyncedAt: syncedAt,
          followUpDate: hit.startDate || lead.followUpDate,
        };
      });
      persistLeads(updated);
      setGcalLastSync(syncedAt);
      try {
        localStorage.setItem('summitGcalLastSync', syncedAt);
      } catch {
        /* ignore */
      }
      if (!opts?.silent) {
        const n = synced || byId.size;
        showToast(
          n === 0
            ? 'No jobs synced (all closed or empty)'
            : `Synced ${n} job${n === 1 ? '' : 's'} to Google Calendar`
        );
      }
    } catch (e) {
      if (!opts?.silent) {
        showToast(
          e instanceof Error ? e.message : 'Calendar sync failed'
        );
      }
    } finally {
      setGcalBusy(false);
    }
  };

  const applyLeadFields = (lead: Lead) => {
    setClientFirstName(lead.clientFirstName || '');
    setClientLastName(lead.clientLastName || '');
    setClientAddress(lead.clientAddress || '');
    setClientCity(lead.clientCity || '');
    setClientState(lead.clientState || '');
    setClientZip(lead.clientZip || '');
    setClientPhone(displayPhoneUS(lead.clientPhone || ''));
    setClientEmail(lead.clientEmail || '');
    setAdditionalContacts(
      normalizeAdditionalContacts(lead.additionalContacts).map((c) => ({
        ...c,
        phone: c.phone ? displayPhoneUS(c.phone) || c.phone : '',
      }))
    );
    setFinancialWorksheet(resolveFinancialWorksheet(lead));
    setClientJobNumber(lead.jobNumber || '');
    setLeadCompany(lead.company || '');
    setMailingSameAsBilling(lead.mailingSameAsBilling ?? true);
    setBillingAddress(lead.billingAddress || '');
    setBillingCity(lead.billingCity || '');
    setBillingState(lead.billingState || '');
    setBillingZip(lead.billingZip || '');
    setJobCategory(lead.jobCategory || 'Residential');
    setHasHOA(lead.hasHOA ?? false);
    setHoaInfo(lead.hoaInfo || '');
    setLeadSource(lead.leadSource || 'Self Generated');
    setReferralName(lead.referralName || '');
    setInsuranceCompany(lead.insuranceCompany || '');
    setDamageLocation(lead.damageLocation || '');
    setDateOfLoss(lead.dateOfLoss || '');
    setClaimFiled(lead.claimFiled ?? false);
    setAdjusterName(lead.adjusterName || '');
    setAdjusterPhone(displayPhoneUS(lead.adjusterPhone || ''));
    setAdjusterEmail(lead.adjusterEmail || '');
    setMetAdjuster(lead.metAdjuster ?? false);
    setClaimNumber(lead.claimNumber || '');
    setPolicyNumber(lead.policyNumber || '');
    setFollowUpDate(lead.followUpDate || '');
    setLeadCategory(normalizePipelineStage(lead.category));
    setTakeoffForm(
      lead.takeoff && typeof lead.takeoff === 'object'
        ? { ...emptyTakeoff(), ...lead.takeoff }
        : emptyTakeoff()
    );
    setLeadNoteDraft('');
    setCurrentLeadId(lead.id);
    setLightboxPhoto(null);
  };

  const loadLeadIntoForm = (lead: Lead) => {
    applyLeadFields(lead);
    setProfileTab('overview');
    setIsEditingLead(true);
    setActiveTab('leads');
  };

  const openLeadProfile = (leadId: number, leadOverride?: Lead) => {
    const lead = leadOverride ?? leads.find((l) => l.id === leadId);
    if (!lead) return;
    loadLeadIntoForm(lead);
  };

  // After refresh: rehydrate open lead profile fields once leads load
  const profileRestoredRef = useRef(false);
  useEffect(() => {
    if (profileRestoredRef.current) return;
    if (leads.length === 0) return;
    profileRestoredRef.current = true;
    if (!isEditingLead || currentLeadId == null) return;
    const lead = leads.find((l) => l.id === currentLeadId);
    if (!lead) {
      setIsEditingLead(false);
      setCurrentLeadId(null);
      return;
    }
    skipUnsavedMarkRef.current = true;
    applyLeadFields(lead);
  }, [leads, isEditingLead, currentLeadId]);

  const closeLeadProfile = () => {
    // Auto draft-save so closing the profile never drops in-progress edits
    if (currentLeadId != null) {
      saveLeadDraft({ silent: true });
    }
    setIsEditingLead(false);
    setLightboxPhoto(null);
    setProfileTab('overview');
  };

  /** Next job number: PREFIX-YEAR#### e.g. S-20260001 (prefix from app_settings) */
  const generateJobNumber = async (): Promise<string> => {
    const year = new Date().getFullYear();
    let prefix = 'S';
    try {
      if (supabaseEnabled && supabase) {
        const { data: pref } = await supabase
          .from('app_settings')
          .select('value')
          .eq('key', 'job_number_prefix')
          .maybeSingle();
        if (pref?.value != null) {
          const v = pref.value;
          prefix =
            typeof v === 'string'
              ? v.replace(/"/g, '').trim() || 'S'
              : String(v);
        }
      }
    } catch {
      /* ignore — use default prefix */
    }

    // Match S-20260001 or legacy S-2026-0001
    const seqFromJob = (job: string) => {
      const compact = job.match(
        new RegExp(`^${prefix}-${year}(\\d+)$`)
      );
      if (compact) return parseInt(compact[1], 10);
      const legacy = job.match(
        new RegExp(`^${prefix}-${year}-(\\d+)$`)
      );
      if (legacy) return parseInt(legacy[1], 10);
      return 0;
    };

    let seq = 1;
    try {
      if (supabaseEnabled && supabase) {
        const { data: rows } = await supabase
          .from('leads')
          .select('job_number')
          .like('job_number', `${prefix}-${year}%`);
        if (rows && rows.length > 0) {
          const nums = rows
            .map((r: { job_number?: string }) =>
              seqFromJob(String(r.job_number || ''))
            )
            .filter((n: number) => n > 0);
          if (nums.length) seq = Math.max(...nums) + 1;
        }
      } else {
        // Offline: derive from local leads
        const nums = leads
          .map((l) => seqFromJob(String(l.jobNumber || '')))
          .filter((n) => n > 0);
        if (nums.length) seq = Math.max(...nums) + 1;
      }
    } catch {
      /* ignore */
    }

    return `${prefix}-${year}${String(seq).padStart(4, '0')}`;
  };

  const addNewLead = () => {
    void (async () => {
      const jobNumber = await generateJobNumber();
      const newLead = createEmptyLead({
        category: 'Lead',
        clientFirstName: '',
        clientLastName: '',
        jobNumber,
      });
      const updated = [newLead, ...leads];
      persistLeads(updated);
      showToast(`New lead ${jobNumber} — opening profile`);
      setLeadsView('active');
      setLeadsSearch('');
      window.setTimeout(() => {
        openLeadProfile(newLead.id, newLead);
      }, 80);
    })();
  };

  const createNewLead = addNewLead;

  const persistTrash = (next: AppTrashItem[]) => {
    // Never accidentally wipe on bad data
    const safe = Array.isArray(next) ? next.filter(Boolean) : [];
    setTrash(safe);
    try {
      localStorage.setItem('summitTrash', JSON.stringify(safe));
    } catch (e) {
      console.error('persistTrash failed', e);
    }
  };

  const moveToTrash = (leadId: number) => {
    const leadToMove = leads.find((l) => l.id === leadId);
    if (!leadToMove) return;
    const label =
      [leadToMove.clientFirstName, leadToMove.clientLastName]
        .filter(Boolean)
        .join(' ') || 'this lead';
    if (!confirm(`Move “${label}” to trash?`)) {
      return;
    }
    const newLeads = leads.filter((l) => l.id !== leadId);
    const item: AppTrashItem = {
      id: `lead-${leadId}-${Date.now()}`,
      kind: 'lead',
      deletedAt: new Date().toLocaleString(),
      lead: leadToMove,
    };
    const newTrash = [item, ...trash];
    setLeads(newLeads);
    persistTrash(newTrash);
    try {
      localStorage.setItem('summitLeads', JSON.stringify(newLeads));
    } catch {
      /* ignore */
    }
    if (currentLeadId === leadId) {
      setIsEditingLead(false);
      setCurrentLeadId(null);
      setLightboxPhoto(null);
    }

    if (supabaseEnabled && supabase) {
      const cloudId = leadToMove.supabaseId?.trim();
      if (cloudId) {
        void (async () => {
          try {
            const { error: estErr } = await supabase
              .from('estimates')
              .delete()
              .eq('lead_id', cloudId);
            if (estErr) console.error('Supabase estimates delete error:', estErr);
            const { error } = await supabase
              .from('leads')
              .delete()
              .eq('id', cloudId);
            if (error) console.error('Supabase lead delete error:', error);
          } catch (err) {
            console.error('Supabase trash error:', err);
          }
        })();
      }
    }

    showToast('Lead moved to trash');
  };

  const restoreFromTrash = (trashId: string) => {
    const item = trash.find((t) => t.id === trashId);
    if (!item) return;
    const newTrash = trash.filter((t) => t.id !== trashId);

    if (item.kind === 'lead') {
      const leadId = item.lead.id;
      const restored: Lead = {
        ...item.lead,
        supabaseId: undefined,
        estimates: (item.lead.estimates || []).map((e) => ({
          ...e,
          supabaseId: undefined,
        })),
      };
      const newLeads = [...leads, restored];
      persistTrash(newTrash);
      setLeads(newLeads);
      try {
        localStorage.setItem('summitLeads', JSON.stringify(newLeads));
      } catch {
        /* ignore */
      }

      if (supabaseEnabled && supabase) {
        void (async () => {
          try {
            const payload = mapAppLeadToDb(restored);
            const { data, error } = await supabase
              .from('leads')
              .insert(payload)
              .select('id')
              .single();
            if (error) {
              console.error('Supabase restore error:', error);
              return;
            }
            if (!data?.id) return;
            const cloudLeadId = String(data.id);
            const estList = restored.estimates || [];
            const estIdMap = new Map<number, string>();
            for (const est of estList) {
              const estPayload = {
                lead_id: cloudLeadId,
                type: 'roof',
                material: est.selectedShingle || null,
                rate: null as number | null,
                labor: null as number | null,
                status: 'saved',
                data: est,
                updated_at: new Date().toISOString(),
              };
              const { data: estRow, error: estErr } = await supabase
                .from('estimates')
                .insert(estPayload)
                .select('id')
                .single();
              if (estErr) {
                console.error('Supabase estimate restore error:', estErr);
              } else if (estRow?.id) {
                estIdMap.set(est.id, String(estRow.id));
              }
            }
            setLeads((prev) => {
              const next = prev.map((l) => {
                if (l.id !== leadId) return l;
                return {
                  ...l,
                  supabaseId: cloudLeadId,
                  estimates: (l.estimates || []).map((e) =>
                    estIdMap.has(e.id)
                      ? { ...e, supabaseId: estIdMap.get(e.id) }
                      : e
                  ),
                };
              });
              try {
                localStorage.setItem('summitLeads', JSON.stringify(next));
              } catch {
                /* ignore */
              }
              return next;
            });
          } catch (err) {
            console.error('Supabase restore error:', err);
          }
        })();
      }
      showToast('Lead restored');
      return;
    }

    // Media / map measurement restore onto lead
    const leadId = item.leadId;
    const lead = leads.find((l) => l.id === leadId);
    if (!lead) {
      showToast('Original lead not found — restore failed');
      return;
    }
    let nextLead: Lead = lead;
    if (item.kind === 'photo') {
      nextLead = {
        ...lead,
        photos: [...(lead.photos || []), item.photo],
      };
    } else if (item.kind === 'roofMeasurement') {
      nextLead = {
        ...lead,
        measurements: [...(lead.measurements || []), item.measurement],
      };
    } else if (item.kind === 'estimate') {
      nextLead = {
        ...lead,
        estimates: [...(lead.estimates || []), item.estimate],
      };
    } else if (item.kind === 'note') {
      nextLead = {
        ...lead,
        notes: [...(lead.notes || []), item.note],
      };
    } else {
      nextLead = {
        ...lead,
        documents: [...(lead.documents || []), item.document],
      };
      if (item.kind === 'measurement') {
        nextLead = {
          ...nextLead,
          measurementReports: [
            ...(lead.measurementReports || []),
            item.document,
          ],
        };
      }
    }
    const newLeads = leads.map((l) => (l.id === leadId ? nextLead : l));
    setLeads(newLeads);
    persistTrash(newTrash);
    try {
      localStorage.setItem('summitLeads', JSON.stringify(newLeads));
    } catch {
      /* ignore */
    }
    showToast('Restored');
  };

  const permanentlyDelete = (trashId: string) => {
    if (!confirm('Permanently delete? This cannot be undone.')) return;
    const doomed = trash.find((t) => t.id === trashId);
    const newTrash = trash.filter((t) => t.id !== trashId);
    persistTrash(newTrash);

    if (doomed?.kind === 'lead') {
      const cloudId = doomed.lead.supabaseId?.trim();
      if (supabaseEnabled && supabase && cloudId) {
        void (async () => {
          try {
            await supabase.from('estimates').delete().eq('lead_id', cloudId);
            await supabase.from('leads').delete().eq('id', cloudId);
          } catch (err) {
            console.error('Supabase permanent delete error:', err);
          }
        })();
      }
      showToast('Lead permanently deleted');
      return;
    }

    if (supabaseEnabled && supabase && doomed) {
      try {
        if (doomed.kind === 'photo' && doomed.photo.url) {
          const marker = '/lead-photos/';
          const idx = doomed.photo.url.indexOf(marker);
          if (idx >= 0) {
            const objectPath = decodeURIComponent(
              doomed.photo.url.slice(idx + marker.length).split('?')[0]
            );
            void supabase.storage.from('lead-photos').remove([objectPath]);
          }
        } else if (
          (doomed.kind === 'document' || doomed.kind === 'measurement') &&
          doomed.document.url
        ) {
          const marker = '/lead-docs/';
          const idx = doomed.document.url.indexOf(marker);
          if (idx >= 0) {
            const objectPath = decodeURIComponent(
              doomed.document.url.slice(idx + marker.length).split('?')[0]
            );
            void supabase.storage.from('lead-docs').remove([objectPath]);
          }
        }
      } catch {
        /* ignore */
      }
    }
    showToast('Permanently deleted');
  };

  const emptyTrash = () => {
    if (trash.length === 0) return;
    // Confirm is handled by the Trash UI call site
    const doomed = [...trash];
    persistTrash([]);
    if (supabaseEnabled && supabase) {
      void (async () => {
        for (const item of doomed) {
          try {
            if (item.kind === 'lead') {
              const cloudId = item.lead.supabaseId?.trim();
              if (cloudId) {
                await supabase.from('estimates').delete().eq('lead_id', cloudId);
                await supabase.from('leads').delete().eq('id', cloudId);
              }
            } else if (item.kind === 'photo' && item.photo.url) {
              const marker = '/lead-photos/';
              const idx = item.photo.url.indexOf(marker);
              if (idx >= 0) {
                const objectPath = decodeURIComponent(
                  item.photo.url.slice(idx + marker.length).split('?')[0]
                );
                await supabase.storage.from('lead-photos').remove([objectPath]);
              }
            } else if (
              (item.kind === 'document' || item.kind === 'measurement') &&
              item.document.url
            ) {
              const marker = '/lead-docs/';
              const idx = item.document.url.indexOf(marker);
              if (idx >= 0) {
                const objectPath = decodeURIComponent(
                  item.document.url.slice(idx + marker.length).split('?')[0]
                );
                await supabase.storage.from('lead-docs').remove([objectPath]);
              }
            }
          } catch (err) {
            console.error('Empty trash purge error:', err);
          }
        }
      })();
    }
    showToast('Trash emptied');
  };
  

  const addLeadNote = () => {
    if (!leadNoteDraft.trim() || !currentLeadId) return;
    const newNote: LeadNote = {
      text: leadNoteDraft.trim(),
      date:
        new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
        ' ' +
        new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    };
    const updatedLeads = leads.map((lead) =>
      lead.id === currentLeadId
        ? { ...lead, notes: [...(lead.notes || []), newNote] }
        : lead
    );
    persistLeads(updatedLeads);
    setLeadNoteDraft('');
    showToast('Note added');
  };

  /** Resize long edge + JPEG encode for smaller Storage uploads (browser canvas). */
  const compressImageForUpload = async (
    file: Blob,
    maxEdge = 1920,
    quality = 0.72
  ): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        try {
          let w = img.naturalWidth;
          let h = img.naturalHeight;
          if (w > maxEdge || h > maxEdge) {
            const s = maxEdge / Math.max(w, h);
            w = Math.round(w * s);
            h = Math.round(h * s);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            URL.revokeObjectURL(url);
            reject(new Error('canvas'));
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob(
            (b) => {
              URL.revokeObjectURL(url);
              if (b) resolve(b);
              else reject(new Error('toBlob'));
            },
            'image/jpeg',
            quality
          );
        } catch (e) {
          URL.revokeObjectURL(url);
          reject(e);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('img'));
      };
      img.src = url;
    });
  };

  const handlePhotoFiles = async (fileList: FileList | File[]) => {
    if (!currentLeadId || photosUploading) return;
    const imageFiles = Array.from(fileList).filter(
      (f) =>
        f.type.startsWith('image/') ||
        /\.(heic|heif|jpg|jpeg|png|webp|gif)$/i.test(f.name)
    );
    if (imageFiles.length === 0) {
      showToast('Please select image files');
      return;
    }
    if (!supabaseEnabled || !supabase) {
      showToast('Cloud storage not available — check Supabase config');
      return;
    }

    const currentLead = leads.find((l) => l.id === currentLeadId);
    const folderKey =
      currentLead?.supabaseId?.trim() || String(currentLeadId);

    setPhotosUploading(true);
    try {
      const stamp =
        new Date().toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }) +
        ' ' +
        new Date().toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
        });

      // Parallel convert/compress/upload (cap concurrency for mobile CPU + network)
      const concurrency = 3;
      const slots: (LeadPhoto | null)[] = new Array(imageFiles.length).fill(null);
      let cursor = 0;

      const runOne = async (i: number) => {
        let file = imageFiles[i];
        const originalName = file.name;
        const id = `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 9)}`;
        try {
          // HEIC/HEIF → JPEG on the server (heic-convert / nodejs runtime)
          const isHeic =
            /image\/hei[cf]/i.test(file.type) ||
            /\.(heic|heif)$/i.test(file.name);
          if (isHeic) {
            const body = new FormData();
            body.append('file', file, originalName);
            const res = await fetch('/api/convert-heic', {
              method: 'POST',
              body,
            });
            if (!res.ok) throw new Error(await res.text());
            const jpegBlob = await res.blob();
            file = new File(
              [jpegBlob],
              originalName.replace(/\.(heic|heif)$/i, '.jpg'),
              { type: 'image/jpeg' }
            );
          }

          let uploadBody: Blob = file;
          let uploadName = file.name || originalName;
          let contentType = file.type || 'image/jpeg';
          const isGif =
            /image\/gif/i.test(file.type) || /\.gif$/i.test(originalName);
          if (!isGif) {
            try {
              uploadBody = await compressImageForUpload(file, 1600, 0.65);
              uploadName = originalName.replace(
                /\.(heic|heif|png|webp|jpe?g)$/i,
                '.jpg'
              );
              if (!/\.jpe?g$/i.test(uploadName)) {
                uploadName = `${uploadName.replace(/\.[^.]+$/, '') || 'photo'}.jpg`;
              }
              contentType = 'image/jpeg';
            } catch (compErr) {
              console.error('Compress failed, uploading original:', compErr);
              uploadBody = file;
              contentType = file.type || 'image/jpeg';
              uploadName = file.name || originalName;
            }
          }

          const ext = (uploadName.split('.').pop() || 'jpg')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');
          const storagePath = `${folderKey}/${id}.${ext || 'jpg'}`;

          const { error: upErr } = await supabase.storage
            .from('lead-photos')
            .upload(storagePath, uploadBody, {
              cacheControl: '3600',
              upsert: false,
              contentType,
            });
          if (upErr) {
            console.error('Photo upload error:', upErr);
            return;
          }

          const { data: pub } = supabase.storage
            .from('lead-photos')
            .getPublicUrl(storagePath);

          slots[i] = {
            id,
            name: uploadName || originalName,
            url: pub.publicUrl,
            createdAt: stamp,
          };
        } catch (e) {
          console.error('Photo failed:', originalName, e);
        }
      };

      const workers = Array.from(
        { length: Math.min(concurrency, imageFiles.length) },
        async () => {
          while (true) {
            const i = cursor++;
            if (i >= imageFiles.length) break;
            await runOne(i);
          }
        }
      );
      await Promise.all(workers);
      const newPhotos = slots.filter(Boolean) as LeadPhoto[];

      if (newPhotos.length === 0) {
        showToast('No photos uploaded');
        return;
      }

      const updatedLeads = leads.map((lead) =>
        lead.id === currentLeadId
          ? { ...lead, photos: [...(lead.photos || []), ...newPhotos] }
          : lead
      );
      persistLeads(updatedLeads);
      showToast(
        newPhotos.length === 1
          ? 'Photo uploaded'
          : `${newPhotos.length} photos uploaded`
      );
    } catch (err) {
      console.error(err);
      showToast('Failed to upload photo(s)');
    } finally {
      setPhotosUploading(false);
    }
  };

  
  const openPhotoReportBuilder = () => {
    if (!currentLeadId) return;
    const lead = leads.find((l) => l.id === currentLeadId);
    const photos = lead?.photos || [];
    if (photos.length === 0) {
      showToast('Upload photos first');
      return;
    }
    setPhotoReportTitle('Photo Report');
    setPhotoReportSelected(photos.map((p) => p.id));
    setPhotoReportCaptions({});
    setPhotoReportOpen(true);
  };

  const togglePhotoInReport = (photoId: string) => {
    setPhotoReportSelected((prev) =>
      prev.includes(photoId) ? prev.filter((id) => id !== photoId) : [...prev, photoId]
    );
  };

  const generatePhotoReportPdf = async () => {
    if (!currentLeadId || photoReportBusy) return;
    const lead = leads.find((l) => l.id === currentLeadId);
    if (!lead) return;
    const photos = lead.photos || [];
    const chosen = photoReportSelected
      .map((id) => photos.find((p) => p.id === id))
      .filter(Boolean) as LeadPhoto[];
    if (chosen.length === 0) {
      showToast('Select at least one photo');
      return;
    }
    setPhotoReportBusy(true);
    try {
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const margin = 14;
      const leadName =
        [lead.clientFirstName, lead.clientLastName].filter(Boolean).join(' ') ||
        'Lead';
      const addr = [lead.clientAddress, lead.clientCity, lead.clientState, lead.clientZip]
        .filter(Boolean)
        .join(', ');
      const brand =
        (typeof userCompany === 'string' && userCompany.trim()) || 'Summit';
      const title = (photoReportTitle || 'Photo Report').trim();
      const dateStr = new Date().toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });

      const loadImg = (src: string) =>
        new Promise<{ data: string; w: number; h: number }>((resolve, reject) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            try {
              const canvas = document.createElement('canvas');
              const max = 1200;
              let w = img.naturalWidth;
              let h = img.naturalHeight;
              if (w > max || h > max) {
                const s = max / Math.max(w, h);
                w = Math.round(w * s);
                h = Math.round(h * s);
              }
              canvas.width = w;
              canvas.height = h;
              const ctx = canvas.getContext('2d');
              if (!ctx) {
                reject(new Error('canvas'));
                return;
              }
              ctx.drawImage(img, 0, 0, w, h);
              resolve({ data: canvas.toDataURL('image/jpeg', 0.82), w, h });
            } catch (e) {
              reject(e);
            }
          };
          img.onerror = () => reject(new Error('img load'));
          img.src = src;
        });

      // Cover page
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      doc.setTextColor(60);
      doc.text(`${dateStr}  |  ${chosen.length} Photo${chosen.length === 1 ? '' : 's'}`, pageW / 2, pageH * 0.38, {
        align: 'center',
      });
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(28);
      doc.setTextColor(15, 23, 42);
      doc.text(title, pageW / 2, pageH * 0.48, { align: 'center' });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      doc.setTextColor(100);
      doc.text(leadName, pageW / 2, pageH * 0.56, { align: 'center' });
      if (addr) doc.text(addr, pageW / 2, pageH * 0.56 + 6, { align: 'center' });
      if (lead.jobNumber) {
        doc.text(String(lead.jobNumber), pageW / 2, pageH * 0.56 + 12, { align: 'center' });
      }
      doc.setFontSize(9);
      doc.text(brand, pageW / 2, pageH - 16, { align: 'center' });

      // Photo pages — 2 per page
      const slotH = (pageH - 36) / 2;
      for (let i = 0; i < chosen.length; i += 2) {
        doc.addPage();
        const pair = [chosen[i], chosen[i + 1]].filter(Boolean) as LeadPhoto[];
        for (let s = 0; s < pair.length; s++) {
          const photo = pair[s];
          const top = 12 + s * slotH;
          const src = photo.url || photo.dataUrl || '';
          const cap = (photoReportCaptions[photo.id] || '').trim();
          const boxW = pageW - margin * 2;
          const imgMaxH = slotH - 22;
          if (src) {
            try {
              const { data, w, h } = await loadImg(src);
              const ratio = Math.min(boxW / w, imgMaxH / h);
              const dw = w * ratio;
              const dh = h * ratio;
              const x = margin + (boxW - dw) / 2;
              doc.addImage(data, 'JPEG', x, top, dw, dh);
              let cy = top + dh + 5;
              doc.setFontSize(9);
              doc.setTextColor(40);
              if (cap) {
                const lines = doc.splitTextToSize(cap, boxW);
                doc.text(lines, margin, cy);
              } else {
                doc.setTextColor(140);
                doc.text(photo.name || 'Photo', margin, cy);
              }
            } catch (e) {
              console.error(e);
              doc.setTextColor(180, 50, 50);
              doc.text('(Image could not be embedded)', margin, top + 20);
            }
          }
        }
        // footer
        doc.setFontSize(8);
        doc.setTextColor(160);
        doc.text(
          `${Math.floor(i / 2) + 2} / ${Math.ceil(chosen.length / 2) + 1}`,
          pageW / 2,
          pageH - 8,
          { align: 'center' }
        );
      }

      const blob = doc.output('blob');
      const safe = title.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40) || 'Photo_Report';
      const job = String(lead.jobNumber || currentLeadId).replace(/[^a-zA-Z0-9-]+/g, '_');
      const fileName = `${safe}_${job}.pdf`;

      // Save to lead documents (Storage)
      if (supabaseEnabled && supabase) {
        const folderKey = lead.supabaseId?.trim() || String(currentLeadId);
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const storagePath = `${folderKey}/reports/${id}-${fileName}`;
        const { error: upErr } = await supabase.storage
          .from('lead-docs')
          .upload(storagePath, blob, {
            cacheControl: '3600',
            upsert: false,
            contentType: 'application/pdf',
          });
        if (upErr) {
          console.error('Report upload error', upErr);
          showToast('PDF built but cloud save failed — downloading');
          doc.save(fileName);
        } else {
          const { data: pub } = supabase.storage
            .from('lead-docs')
            .getPublicUrl(storagePath);
          const stamp = new Date().toLocaleString();
          const newDoc: LeadDocument = {
            id,
            name: fileName,
            url: pub.publicUrl,
            size: blob.size,
            mimeType: 'application/pdf',
            createdAt: stamp,
          };
          const report: PhotoReport = {
            id: `${Date.now()}-r`,
            title,
            createdAt: stamp,
            items: chosen.map((p) => ({
              photoId: p.id,
              caption: photoReportCaptions[p.id] || '',
            })),
          };
          const updated = leads.map((l) =>
            l.id === currentLeadId
              ? {
                  ...l,
                  documents: [...(l.documents || []), newDoc],
                  photoReports: [...(l.photoReports || []), report],
                }
              : l
          );
          persistLeads(updated);
          showToast('Report saved to Documents');
        }
      } else {
        doc.save(fileName);
        showToast('Report downloaded (cloud off)');
      }
      setPhotoReportOpen(false);
    } catch (err) {
      console.error(err);
      showToast('Could not build photo report');
    } finally {
      setPhotoReportBusy(false);
    }
  };

  const leadLabelFor = (lead: Lead) =>
    [lead.clientFirstName, lead.clientLastName].filter(Boolean).join(' ') ||
    lead.jobNumber ||
    'Lead';

  /** Soft-delete photo → app trash (Storage kept until permanent purge). */
  const removeLeadPhoto = (photoId: string) => {
    if (!currentLeadId) return;
    if (!confirm('Move this photo to trash?')) return;
    const lead = leads.find((l) => l.id === currentLeadId);
    const photo = lead?.photos?.find((p) => p.id === photoId);
    if (!photo || !lead) return;
    const updated = leads.map((l) =>
      l.id === currentLeadId
        ? { ...l, photos: (l.photos || []).filter((p) => p.id !== photoId) }
        : l
    );
    persistLeads(updated);
    persistTrash([
      {
        id: `${Date.now()}-photo`,
        kind: 'photo',
        deletedAt: new Date().toLocaleString(),
        leadId: currentLeadId,
        leadLabel: leadLabelFor(lead),
        photo,
      },
      ...trash,
    ]);
    if (lightboxPhoto?.id === photoId) setLightboxPhoto(null);
    showToast('Moved to trash');
  };

  /** Soft-delete measurement report (+ matching document entry) → app trash. */
  const removeMeasurementReport = (docId: string) => {
    if (!currentLeadId) return;
    if (!confirm('Move this measurement to trash?')) return;
    const lead = leads.find((l) => l.id === currentLeadId);
    const doc =
      lead?.measurementReports?.find((d) => d.id === docId) ||
      lead?.documents?.find((d) => d.id === docId);
    if (!doc || !lead) return;
    const updated = leads.map((l) =>
      l.id === currentLeadId
        ? {
            ...l,
            measurementReports: (l.measurementReports || []).filter(
              (d) => d.id !== docId
            ),
            documents: (l.documents || []).filter((d) => d.id !== docId),
          }
        : l
    );
    persistLeads(updated);
    persistTrash([
      {
        id: `${Date.now()}-meas`,
        kind: 'measurement',
        deletedAt: new Date().toLocaleString(),
        leadId: currentLeadId,
        leadLabel: leadLabelFor(lead),
        document: doc,
      },
      ...trash,
    ]);
    if (measurementPdfUrl && doc.url === measurementPdfUrl) {
      setMeasurementPdfUrl(null);
      setMeasurementPdfName('');
    }
    showToast('Moved to trash');
  };

  const uploadMeasurementReport = async (fileList: FileList | File[] | null) => {
    if (!fileList || !currentLeadId) return;
    const files = Array.from(fileList).filter(
      (f) =>
        f.type === 'application/pdf' ||
        f.type.startsWith('image/') ||
        /\.(pdf|png|jpe?g|heic)$/i.test(f.name)
    );
    if (files.length === 0) {
      showToast('Upload a PDF or image report');
      return;
    }
    if (!supabaseEnabled || !supabase) {
      showToast('Cloud storage not available');
      return;
    }
    const currentLead = leads.find((l) => l.id === currentLeadId);
    const folderKey = currentLead?.supabaseId?.trim() || String(currentLeadId);
    setDocsUploading(true);
    try {
      const newDocs: LeadDocument[] = [];
      const stamp =
        new Date().toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }) +
        ' ' +
        new Date().toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
        });
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const id = `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 9)}`;
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const storagePath = `${folderKey}/measurements/${id}-${safeName}`;
        const { error: upErr } = await supabase.storage
          .from('lead-docs')
          .upload(storagePath, file, {
            cacheControl: '3600',
            upsert: false,
            contentType: file.type || 'application/pdf',
          });
        if (upErr) {
          console.error(upErr);
          showToast(`Failed: ${file.name}`);
          continue;
        }
        const { data: pub } = supabase.storage
          .from('lead-docs')
          .getPublicUrl(storagePath);
        newDocs.push({
          id,
          name: file.name,
          url: pub.publicUrl,
          size: file.size,
          mimeType: file.type || 'application/pdf',
          createdAt: stamp,
        });
      }
      if (newDocs.length === 0) {
        showToast('No files uploaded');
        return;
      }
      const updated = leads.map((lead) =>
        lead.id === currentLeadId
          ? {
              ...lead,
              documents: [...(lead.documents || []), ...newDocs],
              measurementReports: [
                ...(lead.measurementReports || []),
                ...newDocs,
              ],
            }
          : lead
      );
      persistLeads(updated);
showToast(
        newDocs.length === 1
          ? 'Measurement saved'
          : `${newDocs.length} measurements saved`
      );
    } catch (e) {
      console.error(e);
      showToast('Upload failed');
    } finally {
      setDocsUploading(false);
    }
  };

  const handleDocFiles = async (fileList: FileList | File[]) => {
    if (!currentLeadId || docsUploading) return;
    const files = Array.from(fileList);
    if (files.length === 0) return;
    if (!supabaseEnabled || !supabase) {
      showToast('Cloud storage not available — check Supabase config');
      return;
    }

    const currentLead = leads.find((l) => l.id === currentLeadId);
    const folderKey =
      currentLead?.supabaseId?.trim() || String(currentLeadId);

    setDocsUploading(true);
    try {
      const newDocs: LeadDocument[] = [];
      const stamp =
        new Date().toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }) +
        ' ' +
        new Date().toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
        });

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const id = `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 9)}`;
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const storagePath = `${folderKey}/${id}-${safeName}`;

        const { error: upErr } = await supabase.storage
          .from('lead-docs')
          .upload(storagePath, file, {
            cacheControl: '3600',
            upsert: false,
            contentType: file.type || 'application/octet-stream',
          });

        if (upErr) {
          console.error('Doc upload error:', upErr);
          showToast(`Failed to upload ${file.name}`);
          continue;
        }

        const { data: pub } = supabase.storage
          .from('lead-docs')
          .getPublicUrl(storagePath);

        newDocs.push({
          id,
          name: file.name,
          url: pub.publicUrl,
          size: file.size,
          mimeType: file.type || undefined,
          createdAt: stamp,
        });
      }

      if (newDocs.length === 0) {
        showToast('No documents uploaded');
        return;
      }

      const updatedLeads = leads.map((lead) =>
        lead.id === currentLeadId
          ? { ...lead, documents: [...(lead.documents || []), ...newDocs] }
          : lead
      );
      persistLeads(updatedLeads);
      showToast(
        newDocs.length === 1
          ? 'Document uploaded'
          : `${newDocs.length} documents uploaded`
      );
    } catch (err) {
      console.error(err);
      showToast('Failed to upload document(s)');
    } finally {
      setDocsUploading(false);
    }
  };

  /** Soft-delete document (and measurement twin if present) → app trash. */
  const removeLeadDocument = (docId: string) => {
    if (!currentLeadId) return;
    if (!confirm('Move this document to trash?')) return;
    const lead = leads.find((l) => l.id === currentLeadId);
    const doc = lead?.documents?.find((d) => d.id === docId);
    if (!doc || !lead) return;
    const wasMeasurement = (lead.measurementReports || []).some(
      (d) => d.id === docId
    );
    const updated = leads.map((l) =>
      l.id === currentLeadId
        ? {
            ...l,
            documents: (l.documents || []).filter((d) => d.id !== docId),
            measurementReports: (l.measurementReports || []).filter(
              (d) => d.id !== docId
            ),
          }
        : l
    );
    persistLeads(updated);
    persistTrash([
      {
        id: `${Date.now()}-doc`,
        kind: wasMeasurement ? 'measurement' : 'document',
        deletedAt: new Date().toLocaleString(),
        leadId: currentLeadId,
        leadLabel: leadLabelFor(lead),
        document: doc,
      },
      ...trash,
    ]);
    if (measurementPdfUrl && doc.url === measurementPdfUrl) {
      setMeasurementPdfUrl(null);
      setMeasurementPdfName('');
    }
    showToast('Moved to trash');
  };

  const moveLeadToStage = (
    leadId: number,
    stage: PipelineStage,
    options?: { toast?: boolean }
  ) => {
    const updatedLeads = leads.map((lead) =>
      lead.id === leadId ? { ...lead, category: stage } : lead
    );
    persistLeads(updatedLeads);
    if (currentLeadId === leadId) {
      setLeadCategory(stage);
    }
    if (options?.toast !== false) {
      showToast(`Pipeline → ${stage}`);
    }
  };

  const setLeadMilestone = (next: PipelineStage, options?: { toast?: boolean }) => {
    if (!currentLeadId) return;
    moveLeadToStage(currentLeadId, next, options);
  };

  const advanceJobMilestone = () => {
    const idx = PIPELINE_STAGES.indexOf(leadCategory);
    if (idx < 0 || idx >= PIPELINE_STAGES.length - 1) {
      showToast('Job is already at Closed');
      return;
    }
    const next = PIPELINE_STAGES[idx + 1];
    setLeadMilestone(next);
  };

  /** Snapshot current form fields onto a lead (draft or full save). */
  const buildLeadFormPatch = (): Partial<Lead> => ({
    clientFirstName,
    clientLastName,
    clientAddress,
    clientCity,
    clientState,
    clientZip,
    clientPhone,
    clientEmail,
    additionalContacts: additionalContacts.map((c) =>
      emptyAdditionalContact({
        ...c,
        phone: c.phone || '',
        email: c.email || '',
      })
    ),
    financialWorksheet: withAutoApproved({
      ...financialWorksheet,
      sections: normalizeJobFinancialSections(financialWorksheet.sections),
      collected: Number(financialWorksheet.collected) || 0,
      notes: financialWorksheet.notes || '',
    }),
    company: leadCompany,
    jobNumber: clientJobNumber,
    mailingSameAsBilling,
    billingAddress: mailingSameAsBilling ? clientAddress : billingAddress,
    billingCity: mailingSameAsBilling ? clientCity : billingCity,
    billingState: mailingSameAsBilling ? clientState : billingState,
    billingZip: mailingSameAsBilling ? clientZip : billingZip,
    jobCategory,
    hasHOA,
    hoaInfo,
    leadSource,
    referralName,
    insuranceCompany,
    damageLocation,
    dateOfLoss,
    claimFiled,
    adjusterName,
    adjusterPhone,
    adjusterEmail,
    metAdjuster,
    claimNumber,
    policyNumber,
    category: leadCategory,
    followUpDate: followUpDate || '',
  });

  /**
   * Persist open lead form to localStorage without leaving the profile.
   * Called automatically when jumping to estimator so edits are not lost.
   */
  const saveLeadDraft = (opts?: {
    leadId?: number | null;
    silent?: boolean;
  }): boolean => {
    const id = opts?.leadId ?? currentLeadId;
    if (!id) return false;
    const updatedLeads = leads.map((lead) =>
      lead.id === id ? { ...lead, ...buildLeadFormPatch() } : lead
    );
    persistLeads(updatedLeads);
    if (!opts?.silent) showToast('Lead draft saved');
    return true;
  };

  // Approved job value always follows worksheet line grand total
  useEffect(() => {
    if (!isEditingLead) return;
    setFinancialWorksheet((w) => {
      const grand = worksheetGrandTotal(w);
      if (grand === w.approvedJobValue) return w;
      return { ...w, approvedJobValue: grand };
    });
  }, [financialWorksheet.sections, isEditingLead]);

  const switchProfileTab = (tab: ProfileTab) => {
    if (currentLeadId != null && isEditingLead) {
      saveLeadDraft({ silent: true });
    }
    setProfileTab(tab);
  };

  const saveLeadProfile = () => {
    if (!saveLeadDraft({ silent: true })) return;
    // Stay on dedicated full-screen profile after save (AccuLynx-style)
    setIsEditingLead(true);
    setActiveTab('leads');
    showToast('Lead profile saved');
  };

  const TAKEOFF_FIELD_LABELS: { key: keyof TakeoffSheet; label: string }[] = [
    { key: 'roofTypeLayers', label: 'Roof type & layers' },
    { key: 'pipeJacks', label: 'Pipe jacks — neoprene or lead / qty & sizes' },
    { key: 'turtleVents', label: 'Turtle type vents' },
    { key: 'powerAtticVents', label: 'Power attic vents' },
    { key: 'windTurbines', label: 'Wind turbines' },
    { key: 'ridgeVent', label: 'Ridge vent — aluminum or shingle-over' },
    { key: 'roofExhaustCap', label: 'Roof exhaust cap (e.g. goose-neck)' },
    { key: 'hvacVent', label: 'HVAC vent — size and/or model #' },
    { key: 'hvacMount', label: 'HVAC mount — curb or elbow' },
    { key: 'chimneyFlashing', label: 'Chimney flashing & size' },
    { key: 'soffitOverhang', label: 'Soffit overhang measurement' },
    { key: 'satelliteDish', label: 'Satellite dish' },
    { key: 'electricalMast', label: 'Electrical mast — split boot or DNR' },
    { key: 'skylights', label: 'Skylights — type & quantity/sizes' },
    { key: 'dripEdgeGutterApron', label: 'Drip edge / gutter apron' },
    { key: 'iceAndWaterShield', label: 'Ice & water shield' },
    { key: 'valleyLiner', label: 'Valley liner' },
    { key: 'drywallSf', label: 'Interior — drywall SF' },
    { key: 'paintingSf', label: 'Interior — painting SF / coats' },
    { key: 'ceilingHeight', label: 'Ceiling height' },
    { key: 'ceilingFans', label: 'Ceiling fans' },
    { key: 'notes', label: 'Notes' },
  ];

  const saveTakeoff = (alsoDocument = false) => {
    if (!currentLeadId) return;
    const snapshot = { ...takeoffForm };
    const updatedLeads = leads.map((lead) =>
      lead.id === currentLeadId ? { ...lead, takeoff: snapshot } : lead
    );
    persistLeads(updatedLeads);

    if (alsoDocument) {
      const lead = updatedLeads.find((l) => l.id === currentLeadId);
      const clientName = lead
        ? [lead.clientFirstName, lead.clientLastName].filter(Boolean).join(' ')
        : '';
      const lines = [
        'TAKE-OFF / INSPECTION SHEET',
        `Job: ${lead?.jobNumber || ''}`,
        `Client: ${clientName}`,
        `Address: ${
          lead
            ? [lead.clientAddress, lead.clientCity, lead.clientState, lead.clientZip]
                .filter(Boolean)
                .join(', ')
            : ''
        }`,
        `Date: ${new Date().toLocaleString()}`,
        '',
        ...TAKEOFF_FIELD_LABELS.map(
          ({ key, label }) => `${label}: ${snapshot[key] || '—'}`
        ),
      ];
      const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
      const safeName = (clientName || 'Lead').replace(/[^\w.-]+/g, '_');
      const file = new File([blob], `Takeoff-${safeName}-${Date.now()}.txt`, {
        type: 'text/plain',
      });
      void handleDocFiles([file]);
      showToast('Take-off saved + added to Documents');
    } else {
      showToast('Take-off saved');
    }
  };

  const assignTakeoffToLead = (leadId: number) => {
    const snapshot = { ...takeoffForm };
    const updatedLeads = leads.map((lead) =>
      lead.id === leadId ? { ...lead, takeoff: snapshot } : lead
    );
    persistLeads(updatedLeads);
    setSystemDocWorkspace(null);
    setTakeoffAssignOpen(false);
    setTakeoffAssignSearch('');
    const lead = updatedLeads.find((l) => l.id === leadId);
    if (lead) {
      applyLeadFields(lead);
      setIsEditingLead(true);
      setActiveTab('leads');
      setProfileTab('takeoff');
    }
    showToast('Take-off assigned to lead');
  };

  const assignTakeoffToNewLead = async () => {
    const jobNumber = await generateJobNumber();
    const newLead = createEmptyLead({
      jobNumber,
      takeoff: { ...takeoffForm },
    });
    persistLeads([...leads, newLead]);
    setSystemDocWorkspace(null);
    setTakeoffAssignOpen(false);
    setTakeoffAssignSearch('');
    applyLeadFields(newLead);
    setIsEditingLead(true);
    setActiveTab('leads');
    setProfileTab('overview');
    showToast('New lead created with take-off');
  };

  /** Leave estimator; keep unsaved estimate guard. Optionally return to source lead. */
  const leaveEstimator = (opts?: {
    returnToLead?: boolean;
    targetTab?: AppTab;
  }) => {
    if (hasUnsavedChanges) {
      const stayToSave = confirm(
        'Unsaved estimate changes.\n\nOK = stay and save · Cancel = discard and leave'
      );
      if (stayToSave) return false;
      const keepContact =
        (opts?.returnToLead && estimatorSourceLeadId != null) ||
        currentLeadId != null;
      resetEstimatorFields(!!keepContact);
      setHasUnsavedChanges(false);
    }

    setShowProfessionalEstimate(false);
    setShowUserMenu(false);

    setEstimateWorkspace('estimate');

    if (opts?.returnToLead) {
      const id = estimatorSourceLeadId ?? currentLeadId;
      if (id != null) {
        setCurrentLeadId(id);
        setIsEditingLead(true);
        setActiveTab('leads');
        setProfileTab('estimates');
        return true;
      }
      setIsEditingLead(false);
      setActiveTab('leads');
      return true;
    }

    const tab = opts?.targetTab ?? 'leads';
    if (tab !== 'leads') {
      setIsEditingLead(false);
      setEstimatorSourceLeadId(null);
    }
    setActiveTab(tab);
    return true;
  };

  const applyNegotiatedPrice = () => {
    const newPrice = Math.round(negotiatedPrice);
    setEstimatorTotalPrice(newPrice);
    setNegotiatedPrice(newPrice);
  };

  const selectRoofSystem = (system: RoofSystem) => {
    setRoofSystem(system);
    setSelectedShingle('');
    setFlatSystem('');
    setCoatingKind('');
    setFoamKind('');
    setFoamIso48('');
    setFoamIso44('');
    setFoamGranules(false);
    setFoamExtraSpf(false);
    setFoamScarify(false);
    setCoatingExtraPass(false);
    setCoatingPressureWash(false);
    setProductColors({});
    setLowSlopeMode('none');
    setLowSlopeType('none');
    setTileMode('');
    setTileProduct('');
    setTileBrand('');
    setCurrentTile('');
    setEstimateFlow('estimate');
    setHasUnsavedChanges(true);
  };

  const selectShingleProduct = (type: ShingleType) => {
    setSelectedShingle(type);
    // Keep legacy color fields in sync when switching products
    if (type !== 'cambridge') setCambridgeColor('');
    if (type !== 'dynasty') setDynastyColor('');
    if (type !== 'armourshake') setArmourshakeColor('');
  };

  const setProductColor = (product: string, color: string) => {
    setProductColors((prev) => ({ ...prev, [product]: color }));
    if (product === 'cambridge') setCambridgeColor(color);
    if (product === 'dynasty') setDynastyColor(color);
    if (product === 'armourshake') setArmourshakeColor(color);
  };

  /** Map flat system tree → sell key on selectedShingle. */
  const applyFlatSelection = (
    system: FlatSystem,
    kind: CoatingKind = '',
    foam: FoamKind = ''
  ) => {
    setFlatSystem(system);
    if (system === 'coating') {
      setCoatingKind(kind);
    } else if (system !== 'foam') {
      // Foam may keep optional top-coating via coatingKind
      setCoatingKind('');
      setCoatingExtraPass(false);
      setCoatingPressureWash(false);
    } else {
      // Entering foam: clear coating adders, keep/reset kind for top coat pick
      setCoatingExtraPass(false);
      setCoatingPressureWash(false);
      if (!kind) setCoatingKind('');
    }
    if (system !== 'foam') {
      setFoamKind('');
      setFoamIso48('');
      setFoamIso44('');
      setFoamGranules(false);
      setFoamExtraSpf(false);
      setFoamScarify(false);
    } else {
      setFoamKind(foam);
    }

    let product: ShingleType = '';
    if (system === 'mod_bit') product = 'mod_bitumen';
    else if (system === 'bur') product = 'bur';
    else if (system === 'foam') {
      product = foam === 'overlay' ? 'foam_overlay' : foam === 'full' ? 'full_foam' : '';
    } else if (system === 'coating') {
      if (kind === 'elastomeric') product = 'elastomeric';
      else if (kind === 'silicone') product = 'silicone';
      else if (kind === 'urethane') product = 'urethane';
      else product = '';
    }
    setSelectedShingle(product);
    setHasUnsavedChanges(true);
  };

  const toggleFascia = (mode: Exclude<FasciaMode, ''>) => {
    setFasciaMode(fasciaMode === mode ? '' : mode);
    setHasUnsavedChanges(true);
  };
  const toggleDecking = (mode: Exclude<DeckingMode, ''>) => {
    setDeckingMode(deckingMode === mode ? '' : mode);
    setHasUnsavedChanges(true);
  };

  // Live lead contact for estimate UI + PDF (never typed on the estimate form)
  const estimatorClient = resolveEstimatorClient();

  const getShingleDisplayName = () => {
    const names: Record<string, string> = {
      cambridge: 'Cambridge',
      dynasty: 'Dynasty',
      armourshake: 'Armourshake',
      gaf_hdz: 'GAF HDZ',
      gaf_natural_shadow: 'GAF Natural Shadow',
      owens_oakridge: 'Owens Oakridge',
      owens_duration: 'Owens Duration',
      tile_dr: 'Detach & Reset',
      tile_rr: 'Remove & Replace',
      sa_underlayment: 'SA High-Temp Underlayment',
      coating: 'Roof Coating',
      elastomeric: 'Elastomeric Coating',
      silicone: 'Silicone Coating',
      urethane: 'Urethane Coating',
      full_foam: 'Full Foam',
      foam_overlay: 'Foam Overlay',
      mod_bitumen: 'Modified Bitumen',
      bur: 'Built-Up Roof (BUR)',
    };
    return names[selectedShingle] || '';
  };

  const getShingleColor = () => {
    if (selectedShingle === 'dynasty') return dynastyColor || 'Color Selected';
    if (selectedShingle === 'cambridge') return cambridgeColor || 'Color Selected';
    if (selectedShingle === 'armourshake') return armourshakeColor || 'Color Selected';
    if (selectedShingle && productColors[selectedShingle]) {
      return productColors[selectedShingle];
    }
    return 'Color Selected';
  };

  const getUnderlaymentLabel = () => {
    if (selectedUnderlayment === 'sa-high-temp') {
      return 'Install SA High-Temp Underlayment';
    }
    if (selectedUnderlayment === 'high-temp') {
      return 'Install TopShield Bigfoot 30 High-Temp Synthetic Underlayment';
    }
    return 'Install TopShield Securegrip 30 Full Synthetic Underlayment';
  };

  const buildScopeOfWork = (): { text: string; amount?: number }[] => {
    const items: { text: string; amount?: number }[] = [];
    const flf = parseFloat(fasciaLF) || 0;
    const billableFascia = Math.max(0, flf - 10);
    const osbN = parseFloat(deckingOsbSheets) || 0;
    const cdxN = parseFloat(deckingCdxSheets) || 0;
    const gLF = parseFloat(gutterLF) || 0;
    const sky = parseFloat(skylights) || 0;
    const hvac = parseFloat(hvacUnits) || 0;
    const panels = parseFloat(solarPanels) || 0;
    const ridge = parseFloat(ridgeVentLF) || 0;
    const sq = parseFloat(squares) || 0;
    const ly = parseInt(layers) || 1;
    const pt = pitch || '4/12';

    const push = (text: string, amount?: number) => {
      items.push(amount != null && amount > 0 ? { text, amount } : { text });
    };

    push('Tear off, haul, and dispose of existing roofing materials');
    push('Inspect decking for non-nailable surfaces (dry rot, broken, or soft areas)');

    if (selectedUnderlayment) {
      push(getUnderlaymentLabel());
    } else {
      push('Install ice & water shield at eaves and valleys as required');
      push('Install synthetic underlayment over the entire roof deck');
    }

    const drip = (dripEdgeColor || '').trim();
    push(
      drip
        ? `Install drip edge on rakes and eaves (${drip})`
        : 'Install drip edge on rakes and eaves'
    );

    if (selectedShingle && (roofSystem === 'shingle' || !roofSystem)) {
      push('Install starter course at all eaves & rakes');
      push('Remove and replace roof-to-wall flashings (step and counter flashing)');
      push('Remove and replace pipe jacks and roof vents');
      const name = getShingleDisplayName();
      const color = getShingleColor();
      if (name) {
        push(
          color && color !== 'Color Selected'
            ? `Install ${name} shingles (${color})`
            : `Install ${name} shingles`
        );
      }
    }

    // --- Priced adders only below ---
    if (ly > 1) {
      const layerRate = getSellPrice(
        'remove_layer',
        activePricingRegion === 'central' ? 20 : 25
      );
      push(
        `Remove additional layer${ly > 2 ? 's' : ''} — ${ly - 1} layer${ly > 2 ? 's' : ''}`,
        (ly - 1) * layerRate * sq
      );
    }

    let steepAmt = 0;
    if (pt === '8/12' || pt === '9/12') steepAmt = getSellPrice('steep_8_9', 100) * sq;
    else if (pt === '10/12' || pt === '11/12') steepAmt = getSellPrice('steep_9_11', 175) * sq;
    else if (pt === '12/12') steepAmt = getSellPrice('steep_11_12', 250) * sq;
    if (steepAmt > 0) {
      push(`Steep slope charge — ${pt}`, steepAmt);
    }

    if (ridge > 0) {
      const ridgeAmt = ridge * getSellPrice('ridge_vent', 12);
      push(`Install ridge vent — ${ridge} LF`, ridgeAmt);
    }

    if (fasciaMode && flf > 0) {
      const fType = fasciaType === '2x8' ? '2×8' : fasciaType === '2x6' ? '2×6' : '';
      const kind = fasciaMode === 'full' ? 'Full fascia replacement' : 'Fascia repair';
      const fasciaRate = getSellPrice(
        'fascia',
        activePricingRegion === 'central' ? 15 : 18
      );
      const fasciaAmt = billableFascia * fasciaRate;
      push(
        fType
          ? `${kind} — primed ${fType}, ${flf} LF`
          : `${kind} — primed fascia, ${flf} LF`,
        fasciaAmt
      );
      if (billableFascia > 0) {
        const moldRate = getSellPrice(
          'shingle_mold',
          activePricingRegion === 'central' ? 5 : 6
        );
        push(`Install shingle mold — ${billableFascia} LF`, billableFascia * moldRate);
      }
    }

    const osbRate = getSellPrice('osb', 80);
    if (deckingMode === 'full') {
      const sheets =
        typeof sheetsNeeded === 'number' && sheetsNeeded > 0
          ? sheetsNeeded
          : Math.ceil((sq * 100) / 32);
      push(
        `Full re-deck — ${sheets} sheets (OSB at non-visible areas; CDX at exposed eaves, soffits, and similar)`,
        sheets * osbRate
      );
    } else if (deckingMode === 'repair' && (osbN > 0 || cdxN > 0)) {
      let freeLeft = 2;
      const osbBill = Math.max(0, osbN - freeLeft);
      freeLeft = Math.max(0, freeLeft - osbN);
      const cdxBill = Math.max(0, cdxN - freeLeft);
      if (osbN > 0) {
        push(
          `Replace decking — ${osbN} sheet${osbN === 1 ? '' : 's'} OSB`,
          osbBill * osbRate
        );
      }
      if (cdxN > 0) {
        push(
          `Replace decking — ${cdxN} sheet${cdxN === 1 ? '' : 's'} CDX`,
          cdxBill * osbRate
        );
      }
    }

    if (panels > 0) {
      push(
        `Detach, reset, and clean solar panels — ${panels} panel${panels === 1 ? '' : 's'}`,
        panels * 250
      );
    }
    if (hvac > 0) {
      const hvacRate = getSellPrice(
        'hvac',
        activePricingRegion === 'central' ? 1250 : 1600
      );
      push(
        `Detach and reset HVAC — ${hvac} unit${hvac === 1 ? '' : 's'}`,
        hvac * hvacRate
      );
    }
    if (sky > 0) {
      const skyRate = getSellPrice(
        'skylight',
        activePricingRegion === 'central' ? 500 : 550
      );
      push(`Detach and reset skylights — ${sky}`, sky * skyRate);
    }
    if (gutterMode === 'dr' && gLF > 0) {
      const rate = getSellPrice(
        'gutters_dr',
        activePricingRegion === 'central' ? 15 : 20
      );
      push(`Detach and reset gutters — ${gLF} LF`, gLF * rate);
    } else if (gutterMode === 'rr' && gLF > 0) {
      const rate = getSellPrice(
        'gutters_rr',
        activePricingRegion === 'central' ? 20 : 30
      );
      push(`Remove and replace gutters — ${gLF} LF`, gLF * rate);
    }

    const mbSqScope = parseFloat(modifiedBitumenSquares) || 0;
    const isModBitScope =
      flatSystem === 'mod_bit' ||
      selectedShingle === 'mod_bitumen' ||
      (lowSlopeMode !== 'none' && lowSlopeType === 'mod_bitumen');
    const mbScopeSq =
      isModBitScope
        ? mbSqScope > 0
          ? mbSqScope
          : flatSystem === 'mod_bit' || selectedShingle === 'mod_bitumen'
            ? sq
            : 0
        : 0;
    if (isModBitScope && mbScopeSq > 0) {
      // 1 base ply + SA cap only (never 2 base layers)
      push(
        `Install modified bitumen — ${mbScopeSq} SQ (1 base ply + SA cap sheet${
          modifiedBitumenColor ? `, ${modifiedBitumenColor}` : ''
        })`
      );
    }

    const iso48n = parseFloat(foamIso48) || 0;
    const iso44n = parseFloat(foamIso44) || 0;
    if (iso48n > 0 || iso44n > 0) {
      const parts: string[] = [];
      if (iso48n > 0) parts.push(`${iso48n} sheet${iso48n === 1 ? '' : 's'} 4×8`);
      if (iso44n > 0) parts.push(`${iso44n} sheet${iso44n === 1 ? '' : 's'} 4×4`);
      const iso48Rate = getSellPrice('iso_4x8', getSellPrice('iso_board', 0));
      const iso44Rate = getSellPrice('iso_4x4', getSellPrice('iso_board', 0) * 0.5);
      push(
        `Install ISO board — ${parts.join(', ')}`,
        iso48n * iso48Rate + iso44n * iso44Rate
      );
    }
    push('Clean jobsite and dispose of all related debris');
    return items;
  };

  const brandCompany =
    userCompany.trim() || DEFAULT_USER_PROFILE.company;

  const generatePDF = () => {
    // Summit jsPDF type scale: title 18, subtitle 11, sections 12, body 10, total 14
    const client = resolveEstimatorClient();
    const doc = new jsPDF();
    const scopeItems = buildScopeOfWork();
    const pageWidth = doc.internal.pageSize.getWidth();
    const maxWidth = pageWidth - 40;
    const pmPhone = displayPhoneUS(userPhone) || userPhone;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text(brandCompany, 20, 20);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(`Prepared ${estimateDate}`, 20, 28);

    doc.setFontSize(10);
    doc.text(`Client: ${client.fullName}`, 20, 46);
    doc.text(`Phone: ${client.phone || 'N/A'}`, 20, 52);
    doc.text(`Email: ${client.email || 'N/A'}`, 20, 58);
    const addressLines = doc.splitTextToSize(`Address: ${client.fullAddress}`, maxWidth);
    doc.text(addressLines, 20, 64);
    let y = 64 + addressLines.length * 6;
    doc.text(`Job #: ${client.jobNumber || 'N/A'}`, 20, y);
    y += 10;

    // Project manager contact
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Your Project Manager', 20, y);
    y += 6;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(`${userName || 'Rep'} · ${userTitle || 'Project Manager'}`, 20, y);
    y += 5;
    doc.text(`Phone: ${pmPhone}`, 20, y);
    y += 5;
    doc.text(`Email: ${userEmail || 'N/A'}`, 20, y);
    y += 12;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('Scope of Work', 20, y);
    y += 8;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);

    scopeItems.forEach((item) => {
      if (y > 270) {
        doc.addPage();
        y = 20;
      }
      const line = typeof item === 'string' ? item : item.text;
      const amount =
        typeof item === 'object' && item && item.amount != null && item.amount > 0
          ? Math.round(item.amount)
          : null;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(30);
      const maxW = amount != null ? 140 : 170;
      const lines = doc.splitTextToSize(`•  ${line}`, maxW);
      doc.text(lines, 20, y);
      if (amount != null) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.text(`$${amount.toLocaleString()}`, 190, y, { align: 'right' });
      }
      y += lines.length * 5 + 2;
    });

    if (notes.trim()) {
      y += 10;
      if (y > 250) {
        doc.addPage();
        y = 20;
      }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.text('ADDITIONAL NOTES', 20, y);
      y += 8;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      const noteLines = doc.splitTextToSize(notes, maxWidth);
      if (y + noteLines.length * 5 > 270) {
        doc.addPage();
        y = 20;
      }
      doc.text(noteLines, 20, y);
      y += noteLines.length * 5 + 8;
    }

    y += 12;
    if (y > 250) {
      doc.addPage();
      y = 20;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text('Total Investment', 20, y);
    doc.text(`$${estimatorTotalPrice.toLocaleString()}`, pageWidth - 20, y, { align: 'right' });
    doc.setFont('helvetica', 'normal');

    if (bufferUsed > 0) {
      y += 8;
      doc.setFontSize(10);
      doc.text(
        `Special discount applied — $${bufferUsed.toLocaleString()}`,
        20,
        y
      );
    }

    y += 12;
    doc.setFontSize(9);
    doc.text(
      'Pricing subject to change upon signed change order for unforeseen conditions. Valid for 30 days.',
      20,
      y
    );

    y += 10;
    doc.setFontSize(10);
    doc.text(`Thank you for choosing ${brandCompany}.`, 20, y);
    y += 8;
    doc.setFontSize(9);
    doc.text(
      `Questions? Contact ${userName || 'Rep'} (${userTitle || 'Project Manager'}) · ${pmPhone} · ${userEmail || ''}`,
      20,
      y
    );

    const safeName =
      [client.firstName, client.lastName].filter(Boolean).join('_') || 'Estimate';
    const safeBrand =
      brandCompany.replace(/[^\w]+/g, '_').replace(/^_|_$/g, '') || 'Estimate';
    doc.save(`${safeBrand}_Estimate_${safeName}.pdf`);
  };

  const renderProfessionalEstimate = () => {
    const client = resolveEstimatorClient();
    const scopeItems = buildScopeOfWork();

    return (
      <div className="bg-white p-5 sm:p-8 text-zinc-900 pb-16 rounded-3xl border border-zinc-200/80 shadow-sm">
        <div className="w-full">
          <div className="flex justify-between items-center mb-8 gap-3">
            <button
              onClick={() => setShowProfessionalEstimate(false)}
              className="px-6 py-2 border border-zinc-300 rounded-2xl text-sm hover:bg-zinc-100"
            >
              ← Back to Estimator
            </button>
            <button
              onClick={generatePDF}
              className="btn-primary px-6 sm:px-8 py-3 rounded-3xl font-semibold"
            >
              Download PDF
            </button>
          </div>

          <div className="text-center mb-10">
            <div className="font-bold text-4xl tracking-tight">{brandCompany}</div>
            <div className="text-sm text-zinc-400 mt-1">Prepared {estimateDate}</div>
          </div>

          <div className="border border-zinc-200 rounded-3xl p-10">
            <div className="mb-8">
              <div className="font-semibold text-lg mb-3">Client Information</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-y-2 text-sm">
                <div><span className="text-zinc-500">Name:</span> {client.fullName}</div>
                <div><span className="text-zinc-500">Phone:</span> {client.phone || '—'}</div>
                <div><span className="text-zinc-500">Email:</span> {client.email || '—'}</div>
                <div><span className="text-zinc-500">Job #:</span> {client.jobNumber || '—'}</div>
                <div className="md:col-span-2"><span className="text-zinc-500">Address:</span> {client.fullAddress}</div>
              </div>
            </div>

            <div className="mb-8 rounded-2xl border border-zinc-200 bg-zinc-50/80 px-5 py-4">
              <div className="font-semibold text-sm text-zinc-900 mb-2">
                Your Project Manager
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-1.5 text-sm">
                <div>
                  <span className="font-medium text-zinc-900">{userName || 'Rep'}</span>
                  <span className="text-zinc-500"> · {userTitle || 'Project Manager'}</span>
                </div>
                <div>
                  <span className="text-zinc-500">Phone:</span>{' '}
                  {displayPhoneUS(userPhone) || userPhone}
                </div>
                <div className="sm:col-span-2">
                  <span className="text-zinc-500">Email:</span>{' '}
                  <a
                    href={`mailto:${userEmail}`}
                    className="text-sky-800 hover:underline"
                  >
                    {userEmail}
                  </a>
                </div>
              </div>
            </div>

            <div className="mb-8">
              <div className="font-semibold text-lg mb-4">Scope of Work</div>
              <div className="space-y-3 text-sm">
                {scopeItems.map((item, index) => (
                  <div
                    key={index}
                    className="flex justify-between gap-4 items-start"
                  >
                    <div className="min-w-0">• {item.text}</div>
                    {item.amount != null && item.amount > 0 && (
                      <div className="shrink-0 tabular-nums font-medium text-emerald-700">
                        ${Math.round(item.amount).toLocaleString()}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {notes.trim() && (
              <div className="mb-8 p-5 bg-amber-50/80 border border-amber-200/80 rounded-2xl">
                <div className="font-semibold text-lg mb-2 text-amber-900">ADDITIONAL NOTES</div>
                <div className="text-sm whitespace-pre-wrap text-amber-950/80">{notes}</div>
              </div>
            )}

            <div className="pt-8 border-t border-zinc-200">
              <div className="flex justify-between items-center text-3xl font-semibold mb-1 text-zinc-900">
                <div>Total Investment</div>
                <div className="tabular-nums text-emerald-700">${estimatorTotalPrice.toLocaleString()}</div>
              </div>
              {bufferUsed > 0 && (
                <div className="text-amber-700 text-right font-medium">
                  Special discount applied — ${bufferUsed.toLocaleString()}
                </div>
              )}
            </div>

            <div className="mt-8 text-xs text-amber-800/90 border-t border-amber-100 pt-6">
              Pricing subject to change upon signed change order for unforeseen conditions
              (decking, fascia, structure, etc.). This estimate is valid for 30 days.
            </div>
            <div className="mt-3 text-xs text-zinc-500">
              Questions? Contact {userName || 'Rep'} ({userTitle || 'Project Manager'}) ·{' '}
              {displayPhoneUS(userPhone) || userPhone} · {userEmail}
            </div>

            <button
              onClick={saveCurrentEstimate}
              className="btn-primary mt-10 w-full py-4 rounded-3xl font-semibold text-lg"
            >
              Save This Estimate to Lead
            </button>
          </div>
        </div>
      </div>
    );
  };

  const headerSearchQuery = headerSearch.trim().toLowerCase();
  const headerSearchResults = headerSearchQuery
    ? leads
        .filter((lead) => {
          const hay = [
            lead.clientFirstName,
            lead.clientLastName,
            lead.clientAddress,
            lead.clientCity,
            lead.clientPhone,
            lead.clientEmail,
            lead.jobNumber,
            lead.category,
          ]
            .join(' ')
            .toLowerCase();
          return hay.includes(headerSearchQuery);
        })
        .slice(0, 6)
    : [];

  const openNavTab = (tab: AppTab) => {
    setShowProfessionalEstimate(false);
    setSidebarOpen(false);
    handleTabChange(tab);
  };

  type SidebarItem = {
    tab: AppTab;
    label: string;
    /** Simple geometric icon key */
    icon:
      | 'home'
      | 'jobs'
      | 'estimates'
      | 'invoices'
      | 'calendar'
      | 'performance'
      | 'tools'
      | 'documents'
      | 'settings';
  };

  const sidebarPrimary: SidebarItem[] = [
    { tab: 'home', label: 'Home', icon: 'home' },
    { tab: 'leads', label: 'Pipeline', icon: 'jobs' },
    { tab: 'estimates', label: 'Estimates', icon: 'estimates' },
    { tab: 'invoices', label: 'Invoices', icon: 'invoices' },
    { tab: 'calendar', label: 'Calendar', icon: 'calendar' },
    { tab: 'performance', label: 'Performance', icon: 'performance' },
    { tab: 'tools', label: 'Tools', icon: 'tools' },
    { tab: 'documents', label: 'Documents', icon: 'documents' },
  ];

  const isSidebarTabActive = (tab: AppTab) =>
    !showProfessionalEstimate &&
    (activeTab === tab ||
      (tab === 'leads' && isEditingLead && currentLeadId != null) ||
      (tab === 'settings' && activeTab === 'settings'));

  const SidebarIcon = ({
    icon,
    className = 'w-5 h-5',
  }: {
    icon: SidebarItem['icon'];
    className?: string;
  }) => {
    const common = {
      className,
      fill: 'none' as const,
      stroke: 'currentColor',
      strokeWidth: 1.75,
      strokeLinecap: 'round' as const,
      strokeLinejoin: 'round' as const,
      viewBox: '0 0 24 24',
      'aria-hidden': true as const,
    };
    switch (icon) {
      case 'home':
        return (
          <svg {...common}>
            <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5Z" />
          </svg>
        );
      case 'jobs':
        return (
          <svg {...common}>
            <rect x="3" y="7" width="18" height="13" rx="2" />
            <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        );
      case 'estimates':
        return (
          <svg {...common}>
            <path d="M8 6h11M8 12h11M8 18h7" />
            <path d="M4 6h.01M4 12h.01M4 18h.01" />
          </svg>
        );
      case 'invoices':
        return (
          <svg {...common}>
            <path d="M6 3h9l3 3v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
            <path d="M15 3v4h4M8 12h8M8 16h6M8 8h3" />
          </svg>
        );
      case 'calendar':
        return (
          <svg {...common}>
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M3 10h18M8 3v4M16 3v4" />
          </svg>
        );
      case 'performance':
        return (
          <svg {...common}>
            <path d="M4 19V5M10 19v-9M16 19V8M22 19H2" />
          </svg>
        );
      case 'tools':
        return (
          <svg {...common}>
            <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-2.5 2.5-2.5Z" />
          </svg>
        );
      case 'documents':
        return (
          <svg {...common}>
            <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
            <path d="M14 3v5h5" />
          </svg>
        );
      case 'settings':
        return (
          <svg {...common}>
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        );
      default:
        return null;
    }
  };

  const renderSidebarNav = (onNavigate?: () => void) => (
    <nav className="flex flex-col gap-0.5 px-2.5 py-3">
      {sidebarPrimary.map((item) => {
        const active = isSidebarTabActive(item.tab);
        return (
          <button
            key={item.tab}
            type="button"
            onClick={() => {
              setSidebarProfileOpen(false);
              openNavTab(item.tab);
              onNavigate?.();
            }}
            className={`flex items-center gap-3 w-full rounded-xl px-3 py-2.5 text-sm font-medium transition-all ${
              active
                ? 'bg-zinc-900 text-white shadow-sm'
                : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
            }`}
          >
            <SidebarIcon
              icon={item.icon}
              className={`w-[18px] h-[18px] shrink-0 ${
                active ? 'opacity-100' : 'opacity-80'
              }`}
            />
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );

  /** Grok-style profile dock — bottom of sidebar */
  const renderSidebarProfile = (onNavigate?: () => void) => {
    const displayName = userName || (email ? email.split('@')[0] : 'Account');
    const subtitle =
      userCompany.trim() || userTitle.trim() || userEmail || email || '';
    const initial = (userName || email || 'J').charAt(0).toUpperCase();
    const profileActive = activeTab === 'settings' && !showProfessionalEstimate;

    return (
      <div
        className="relative shrink-0 border-t border-zinc-200/70 px-2.5 py-2.5"
        data-sidebar-profile
      >
        {sidebarProfileOpen && (
          <div className="absolute bottom-full left-2.5 right-2.5 mb-1.5 rounded-2xl bg-white border border-zinc-200 shadow-md overflow-hidden z-50">
            <button
              type="button"
              onClick={() => {
                setSidebarProfileOpen(false);
                openNavTab('settings');
                onNavigate?.();
              }}
              className="w-full text-left px-3.5 py-2.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100"
            >
              Profile settings
            </button>
            <button
              type="button"
              onClick={() => {
                setSidebarProfileOpen(false);
                handleSignOut();
              }}
              className="w-full text-left px-3.5 py-2.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 border-t border-zinc-100"
            >
              Sign out
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => {
            setShowUserMenu(false);
            setSidebarProfileOpen((v) => !v);
          }}
          className={`w-full flex items-center gap-2.5 rounded-2xl px-2 py-2 text-left transition-colors ${
            profileActive || sidebarProfileOpen
              ? 'bg-zinc-200/70 ring-1 ring-zinc-200/90'
              : 'hover:bg-zinc-200/50'
          }`}
          aria-expanded={sidebarProfileOpen}
          aria-haspopup="menu"
        >
          <div className="w-9 h-9 rounded-full bg-zinc-800 flex items-center justify-center text-sm font-semibold text-white shrink-0">
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-zinc-900 truncate leading-tight">
              {displayName}
            </div>
            {subtitle ? (
              <div className="text-[11px] text-zinc-500 truncate mt-0.5 leading-tight">
                {subtitle}
              </div>
            ) : null}
          </div>
          <svg
            className={`w-4 h-4 shrink-0 text-zinc-400 transition-transform ${
              sidebarProfileOpen ? 'rotate-180' : ''
            }`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            viewBox="0 0 24 24"
            aria-hidden
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>
    );
  };

  const renderAppSidebar = () => (
    <>
      {/* Desktop sidebar */}
      <aside
        className="hidden lg:flex fixed inset-y-0 left-0 z-40 w-[15.5rem] flex-col border-r border-zinc-200/80 bg-zinc-50/95 backdrop-blur-md"
        aria-label="Main navigation"
      >
        <div className="h-14 sm:h-16 flex items-center gap-2.5 px-4 border-b border-zinc-200/70 shrink-0">
          <div className="w-8 h-8 rounded-xl bg-zinc-900 ring-1 ring-zinc-700/40 flex items-center justify-center">
            <span className="text-white text-lg font-bold tracking-tight">S</span>
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-[15px] tracking-tight text-zinc-900 truncate">
              Summit
            </div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-medium">
              Roofing OS
            </div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-1">{renderSidebarNav()}</div>
        {renderSidebarProfile()}
      </aside>

      {/* Mobile drawer */}
      {sidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-[60]" role="dialog" aria-modal="true">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close menu"
            onClick={() => {
              setSidebarOpen(false);
              setSidebarProfileOpen(false);
            }}
          />
          <aside className="absolute inset-y-0 left-0 w-[17rem] max-w-[85vw] bg-zinc-50 shadow-md border-r border-zinc-200 flex flex-col animate-[page-fade-in_0.18s_ease-out]">
            <div className="h-14 flex items-center justify-between gap-2 px-4 border-b border-zinc-200/70">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-8 h-8 rounded-xl bg-zinc-900 flex items-center justify-center shrink-0">
                  <span className="text-white text-lg font-bold">S</span>
                </div>
                <span className="font-semibold text-zinc-900 truncate">Summit</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSidebarOpen(false);
                  setSidebarProfileOpen(false);
                }}
                className="px-2.5 py-1.5 rounded-lg text-sm text-zinc-600 hover:bg-zinc-200/70"
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {renderSidebarNav(() => setSidebarOpen(false))}
            </div>
            {renderSidebarProfile(() => setSidebarOpen(false))}
          </aside>
        </div>
      )}
    </>
  );

  /** Top bar: menu (mobile), search, user — same on every page */
  const renderAppHeader = () => (
    <header
      className="sticky top-0 z-50 bg-zinc-100/90 backdrop-blur-md border-b border-zinc-200/80 text-zinc-900"
      suppressHydrationWarning
    >
      <div className="h-14 sm:h-16 flex items-center gap-2 sm:gap-3 px-3 sm:px-5 lg:px-6">
        <button
          type="button"
          className="lg:hidden shrink-0 w-10 h-10 rounded-xl flex items-center justify-center text-zinc-700 hover:bg-zinc-200/70 border border-transparent hover:border-zinc-200"
          onClick={() => {
            setSidebarOpen(true);
            setShowUserMenu(false);
          }}
          aria-label="Open menu"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
            <path strokeLinecap="round" d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>

        <div className="lg:hidden flex items-center gap-2 shrink-0 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-zinc-900 flex items-center justify-center">
            <span className="text-white text-sm font-bold">S</span>
          </div>
          <span className="font-semibold text-sm text-zinc-900 truncate hidden xs:inline sm:inline">
            Summit
          </span>
        </div>

        {/* Search */}
        <div
          ref={headerSearchRef}
          className="flex-1 min-w-0 max-w-xl lg:max-w-lg relative"
        >
          <input
            type="search"
            value={headerSearch}
            onChange={(e) => setHeaderSearch(e.target.value)}
            placeholder="Search jobs, leads, estimates..."
            className="w-full h-10 px-3.5 rounded-xl bg-white border border-zinc-200 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-300/50"
          />
          {headerSearchQuery && (
            <div className="absolute left-0 right-0 mt-2 rounded-2xl bg-white text-zinc-900 border border-zinc-200 shadow-md overflow-hidden z-[60]">
              {headerSearchResults.length === 0 ? (
                <div className="px-4 py-6 text-sm text-zinc-400 text-center">
                  No matches for “{headerSearch.trim()}”
                </div>
              ) : (
                <div className="max-h-80 overflow-y-auto py-1">
                  {headerSearchResults.map((lead) => {
                    const stage = normalizePipelineStage(lead.category);
                    return (
                      <button
                        key={lead.id}
                        type="button"
                        onClick={() => {
                          openLeadProfile(lead.id);
                          setHeaderSearch('');
                          setSidebarOpen(false);
                        }}
                        className="w-full text-left px-4 py-3 hover:bg-zinc-100 transition-colors border-b border-zinc-50 last:border-0"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-medium text-sm truncate">
                            {[lead.clientFirstName, lead.clientLastName]
                              .filter(Boolean)
                              .join(' ') || 'Untitled lead'}
                          </div>
                          <span className="text-[10px] uppercase tracking-wide text-zinc-400 shrink-0">
                            {stage}
                          </span>
                        </div>
                        <div className="text-xs text-zinc-500 mt-0.5 truncate">
                          {lead.clientAddress || 'No address'}
                          {lead.jobNumber ? ` · #${lead.jobNumber}` : ''}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* User */}
        <div className="relative shrink-0" data-header-menu>
          <button
            type="button"
            onClick={() => {
              setShowUserMenu((v) => !v);
            }}
            className={`flex items-center gap-2 h-10 pl-1.5 pr-2 sm:pr-3 rounded-xl transition-colors ${
              showUserMenu
                ? 'bg-white shadow-sm ring-1 ring-zinc-200/90'
                : 'hover:bg-zinc-200/60'
            }`}
            aria-label="User menu"
          >
            <div className="w-7 h-7 rounded-lg bg-zinc-800 flex items-center justify-center text-xs font-semibold text-white">
              {(userName || email || 'J').charAt(0).toUpperCase()}
            </div>
            <span className="hidden sm:block text-sm text-zinc-700 font-medium truncate max-w-[8rem]">
              {userName || (email ? email.split('@')[0] : 'Account')}
            </span>
          </button>
          {showUserMenu && (
            <div className="absolute right-0 mt-2 w-56 rounded-2xl bg-white text-zinc-900 border border-zinc-200 shadow-md overflow-hidden z-[60]">
              <div className="px-4 py-3 border-b border-zinc-100">
                <div className="text-sm font-semibold truncate">
                  {userName || email || 'Signed in'}
                </div>
                <div className="text-xs text-zinc-500 truncate mt-0.5">
                  {userEmail || email || ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowUserMenu(false);
                  handleTabChange('home');
                }}
                className="w-full text-left px-4 py-2.5 text-sm hover:bg-zinc-100 text-zinc-700"
              >
                Home
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowUserMenu(false);
                  handleTabChange('settings');
                }}
                className="w-full text-left px-4 py-2.5 text-sm hover:bg-zinc-100 text-zinc-700"
              >
                Profile settings
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowUserMenu(false);
                  handleSignOut();
                }}
                className="w-full text-left px-4 py-2.5 text-sm hover:bg-zinc-50 text-zinc-800 border-t border-zinc-100"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );

  // Wait for client storage restore so header/nav match (no hydration mismatch)
  if (!sessionReady) {
    return (
      <div className="min-h-screen bg-zinc-100" aria-busy="true" aria-label="Loading" />
    );
  }

  if (!isLoggedIn) {
    return (
      <div className="min-h-screen bg-zinc-100 flex items-center justify-center p-6">
        <div className="w-full max-w-md text-center">
          <div className="mx-auto w-20 h-20 bg-zinc-900 rounded-3xl flex items-center justify-center mb-8">
            <span className="text-white text-6xl font-bold tracking-tighter">S</span>
          </div>

          <div className="font-bold text-5xl tracking-tighter text-zinc-900 mb-1">Summit</div>
          <p className="text-zinc-500 mb-12">Roofing OS</p>

          <div className="space-y-6">
            <div>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleLogin();
                }}
                className="w-full px-6 py-4 border border-zinc-200 rounded-2xl focus:outline-none focus:border-zinc-400 text-base bg-white"
                placeholder="you@summitroofing.com"
              />
            </div>

            <div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleLogin();
                }}
                className="w-full px-6 py-4 border border-zinc-200 rounded-2xl focus:outline-none focus:border-zinc-400 text-base bg-white"
                placeholder="Password"
              />
            </div>

            <button
              onClick={handleLogin}
              className="btn-primary w-full py-4 rounded-3xl font-semibold text-lg"
            >
              Sign In
            </button>

            <div className="text-center">
              <button type="button" className="text-sm text-zinc-500 hover:text-zinc-700">
                Forgot password?
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-100 text-zinc-900">
      {toastMessage && (
        <div className="fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 z-[80] px-6 py-3 bg-zinc-900/95 text-white rounded-2xl shadow-md ring-1 ring-white/10 text-sm font-medium">
          {toastMessage}
        </div>
      )}
      {renderAppSidebar()}
      {/* Main column offset for fixed desktop sidebar */}
      <div className="lg:pl-[15.5rem] min-h-screen pb-8 flex flex-col">
      {/* Single global shell: search + user on every page */}
      {renderAppHeader()}

      {showProfessionalEstimate ? (
        <div className="page-shell page-fade">
          {renderProfessionalEstimate()}
        </div>
      ) : null}

      {/* New Estimate: pick lead or reopen a saved estimate */}
      {showEstimatePicker && (() => {
        const q = estimatePickerQuery.trim().toLowerCase();
        const leadMatches = leads
          .filter((lead) => {
            if (!q) return true;
            const hay = [
              lead.clientFirstName,
              lead.clientLastName,
              lead.clientAddress,
              lead.clientCity,
              lead.clientPhone,
              lead.jobNumber,
            ]
              .join(' ')
              .toLowerCase();
            return hay.includes(q);
          })
          .slice(0, 40);
        const estimateItems = allEstimates()
          .filter(({ lead, estimate, leadName }) => {
            if (!q) return true;
            const hay = [
              leadName,
              lead.clientAddress,
              estimate.date,
              estimate.selectedShingle,
              String(estimate.total || ''),
            ]
              .join(' ')
              .toLowerCase();
            return hay.includes(q);
          })
          .slice(0, 20);

        return (
          <div className="fixed inset-0 z-[70] bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-lg sm:rounded-3xl rounded-t-3xl shadow-md border border-zinc-200 max-h-[88vh] flex flex-col">
              <div className="px-5 pt-5 pb-3 border-b border-zinc-100 shrink-0">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-semibold text-zinc-900">
                      {estimatePickerMode === 'internal'
                        ? 'Open Internal'
                        : 'New estimate'}
                    </h2>
                    <p className="text-sm text-zinc-500 mt-1">
                      {estimatePickerMode === 'internal'
                        ? 'Choose a lead for cost, commission, and buffer.'
                        : 'Choose a lead — contact info is pulled into the estimate.'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowEstimatePicker(false)}
                    className="text-sm font-medium text-zinc-500 hover:text-zinc-800 px-2 py-1"
                  >
                    Close
                  </button>
                </div>
                <input
                  value={estimatePickerQuery}
                  onChange={(e) => setEstimatePickerQuery(e.target.value)}
                  placeholder="Search leads or estimates…"
                  className="mt-4 w-full border border-zinc-200 rounded-2xl px-4 py-2.5 text-sm focus:outline-none focus:border-zinc-400"
                  autoFocus
                />
              </div>

              <div className="overflow-y-auto flex-1 px-5 py-4 space-y-6">
                <section>
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-2">
                    Select a lead
                  </h3>
                  {leadMatches.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-zinc-200 px-4 py-8 text-center">
                      <p className="text-sm text-zinc-500 mb-3">
                        {leads.length === 0
                          ? 'No leads yet — create one first'
                          : 'No leads match that search'}
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setShowEstimatePicker(false);
                          createNewLead();
                        }}
                        className="btn-primary px-5 py-2.5 rounded-2xl text-sm font-semibold"
                      >
                        New lead
                      </button>
                    </div>
                  ) : (
                    <ul className="space-y-1.5">
                      {leadMatches.map((lead) => {
                        const name =
                          [lead.clientFirstName, lead.clientLastName]
                            .filter(Boolean)
                            .join(' ') ||
                          lead.clientAddress ||
                          'Untitled lead';
                        const estCount = lead.estimates?.length || 0;
                        return (
                          <li key={lead.id}>
                            <button
                              type="button"
                              onClick={() => {
                                setShowEstimatePicker(false);
                                startNewEstimate({
                                  fromLeadId: lead.id,
                                  workspace: estimatePickerMode,
                                });
                              }}
                              className="w-full text-left rounded-2xl border border-zinc-200 px-4 py-3 hover:border-sky-300 hover:bg-sky-50/40 transition-colors"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="text-sm font-semibold text-zinc-900 truncate">
                                    {name}
                                  </div>
                                  <div className="text-xs text-zinc-500 truncate mt-0.5">
                                    {[lead.clientAddress, lead.clientCity]
                                      .filter(Boolean)
                                      .join(', ') || 'No address'}
                                    {estCount > 0
                                      ? ` · ${estCount} estimate${estCount === 1 ? '' : 's'}`
                                      : ''}
                                  </div>
                                </div>
                                <span className="text-xs font-semibold text-sky-800 shrink-0">
                                  Start →
                                </span>
                              </div>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>

                <section>
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-2">
                    Saved estimates
                  </h3>
                  {estimateItems.length === 0 ? (
                    <p className="text-sm text-zinc-400 px-1 py-2">
                      No saved estimates yet
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {estimateItems.map(({ lead, estimate, leadName }) => (
                        <li key={`${lead.id}-${estimate.id}`}>
                          <button
                            type="button"
                            onClick={() =>
                              loadEstimate(estimate, { leadId: lead.id })
                            }
                            className="w-full text-left rounded-2xl border border-zinc-200 px-4 py-3 hover:border-sky-300 hover:bg-sky-50/30 transition-colors"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <div className="text-sm font-semibold text-zinc-900 truncate">
                                  {leadName}
                                </div>
                                <div className="text-xs text-zinc-500 mt-0.5 truncate">
                                  {estimate.date}
                                  {estimate.selectedShingle
                                    ? ` · ${estimate.selectedShingle}`
                                    : ''}
                                  {estimate.squares
                                    ? ` · ${estimate.squares} sq`
                                    : ''}
                                </div>
                              </div>
                              <span className="text-sm font-semibold text-emerald-700 tabular-nums shrink-0">
                                ${(estimate.negotiatedPrice || estimate.total || 0).toLocaleString()}
                              </span>
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>

              <div className="px-5 py-3 border-t border-zinc-100 shrink-0 flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowEstimatePicker(false)}
                  className="flex-1 py-2.5 rounded-2xl text-sm font-medium border border-zinc-200 text-zinc-700 hover:bg-zinc-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowEstimatePicker(false);
                    createNewLead();
                  }}
                  className="flex-1 py-2.5 rounded-2xl text-sm font-semibold border border-zinc-200 text-zinc-800 hover:bg-zinc-50"
                >
                  New lead first
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Home / standalone measure: address first */}
      {showMeasureAddressModal && (
        <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl w-full max-w-lg p-6 shadow-md border border-zinc-200">
            <h2 className="text-xl font-semibold text-zinc-900">New measurement</h2>
            <p className="text-sm text-zinc-500 mt-1 mb-5">
              Enter the property address to continue. If map data is unavailable, you can still
              trace on street view or enter area manually.
            </p>
            <div className="space-y-3">
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5">
                  Street address
                </div>
                <AddressAutocomplete
                  value={measureAddrStreet}
                  onChange={setMeasureAddrStreet}
                  onSelect={(p) => {
                    setMeasureAddrStreet(p.street);
                    if (p.city) setMeasureAddrCity(p.city);
                    if (p.state) setMeasureAddrState(p.state);
                    if (p.zip) setMeasureAddrZip(p.zip);
                  }}
                  cityHint={measureAddrCity}
                  stateHint={measureAddrState}
                  placeholder="123 Main St"
                  className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-zinc-400"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5">
                    City
                  </div>
                  <input
                    value={measureAddrCity}
                    onChange={(e) => setMeasureAddrCity(e.target.value)}
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-zinc-400"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5">
                      State
                    </div>
                    <input
                      value={measureAddrState}
                      onChange={(e) => setMeasureAddrState(e.target.value)}
                      className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-zinc-400"
                    />
                  </div>
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5">
                      Zip
                    </div>
                    <input
                      value={measureAddrZip}
                      onChange={(e) => setMeasureAddrZip(e.target.value)}
                      className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-zinc-400"
                    />
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-6 flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setShowMeasureAddressModal(false)}
                className="px-4 py-2.5 rounded-2xl text-sm font-medium border border-zinc-200 text-zinc-600 hover:bg-zinc-100"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={geocoding}
                onClick={() => void submitMeasureAddress()}
                className="btn-primary px-5 py-2.5 rounded-2xl text-sm font-semibold disabled:opacity-50"
              >
                {geocoding ? 'Finding address…' : 'Continue to tracer'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Measurements hub: full report */}
      {hubReport &&
        (() => {
          const lead = leads.find((l) => l.id === hubReport.leadId);
          const measurement = lead?.measurements?.find(
            (m) => m.id === hubReport.measurementId
          );
          if (!lead || !measurement) return null;
          const leadName =
            [lead.clientFirstName, lead.clientLastName].filter(Boolean).join(' ') ||
            lead.clientAddress ||
            'Unassigned lead';
          const multiDiag =
            measurement.sections && measurement.sections.length > 0
              ? multiSectionSvgPaths(measurement.sections)
              : measurement.points.length >= 3
                ? (() => {
                    const s = polygonToSvgPath(measurement.points);
                    return {
                      paths: [{ d: s.path, kind: 'pitched' as const }],
                      viewBox: s.viewBox,
                    };
                  })()
                : null;
          const roofTypeLabel =
            measurement.roofType === 'flat-modified-bitumen'
              ? 'Flat modified bitumen'
              : measurement.roofType === 'mixed'
                ? 'Mixed pitched + flat'
                : 'Pitched shingles';
          const pitchLabel = [
            measurement.pitch,
            measurement.secondaryPitch
              ? `+ ${measurement.secondaryPitch} (${Math.round((measurement.secondaryFraction || 0) * 100)}%)`
              : '',
            measurement.pitchAuto ? '(auto)' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const rows: [string, string][] = [
            ['Roof type', roofTypeLabel],
            [
              'Sections',
              measurement.sections?.length
                ? String(measurement.sections.length)
                : '1',
            ],
            ['Pitched squares', String(measurement.squares ?? 0)],
            ['Flat squares', String(measurement.flatSquares ?? 0)],
            [
              'Total squares',
              String(
                Math.round(
                  ((measurement.squares || 0) + (measurement.flatSquares || 0)) *
                    100
                ) / 100
              ),
            ],
            ['Footprint', `${measurement.footprintSqFt.toLocaleString()} sq ft`],
            ['Surface', `${measurement.surfaceSqFt.toLocaleString()} sq ft`],
            ['Pitch', pitchLabel],
            [
              'Waste',
              `${Math.round(measurement.waste * 100)}%${
                measurement.wasteAuto ? ' (auto)' : ''
              }`,
            ],
            ['Perimeter', `${measurement.perimeterLF} LF`],
            ['Ridge', `${measurement.ridgeLF} LF`],
            ['Hip', `${measurement.hipLF} LF`],
            ['Valley', `${measurement.valleyLF ?? 0} LF`],
            ['Eave', `${measurement.eaveLF} LF`],
            ['Rake', `${measurement.rakeLF} LF`],
          ];
          return (
            <div className="fixed inset-0 z-[70] bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
              <div className="bg-white w-full sm:max-w-2xl sm:rounded-3xl rounded-t-3xl shadow-md border border-zinc-200 max-h-[92vh] overflow-y-auto">
                <div className="sticky top-0 bg-white border-b border-zinc-100 px-5 py-4 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold text-zinc-900 truncate">
                      {measurement.label || 'Roof report'}
                    </h2>
                    <p className="text-sm text-zinc-500 mt-0.5 truncate">
                      {leadName} · {measurement.createdAt} · {roofTypeLabel}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setHubReport(null)}
                    className="px-3 py-1.5 text-sm font-medium rounded-xl border border-zinc-200 text-zinc-600 hover:bg-zinc-100 shrink-0"
                  >
                    Close
                  </button>
                </div>
                <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <div className="rounded-2xl border border-zinc-200 bg-zinc-100 p-4 flex items-center justify-center min-h-[220px]">
                    {multiDiag?.paths?.length ? (
                      <svg
                        viewBox={multiDiag.viewBox}
                        className="w-full max-w-[240px] h-auto"
                      >
                        {multiDiag.paths.map((p, i) => (
                          <path
                            key={i}
                            d={p.d}
                            fill={
                              p.kind === 'flat' ? '#1c1e2120' : '#5a6f8a28'
                            }
                            stroke={p.kind === 'flat' ? '#1c1e21' : '#0f172a'}
                            strokeWidth="2"
                          />
                        ))}
                      </svg>
                    ) : (
                      <div className="text-sm text-zinc-400 text-center px-4">
                        Manual entry — no traced outline
                      </div>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    {rows.map(([k, v]) => (
                      <div
                        key={k}
                        className="flex justify-between text-sm py-1.5 border-b border-zinc-100 last:border-0"
                      >
                        <span className="text-zinc-500">{k}</span>
                        <span className="font-medium tabular-nums text-zinc-900">{v}</span>
                      </div>
                    ))}
                    {measurement.sections?.map((s, i) => (
                      <div
                        key={s.id}
                        className="flex justify-between text-xs py-1 text-zinc-500"
                      >
                        <span>
                          Sec {i + 1}: {s.label} ({s.kind})
                        </span>
                        <span className="tabular-nums font-medium text-zinc-800">
                          {s.squares} sq
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="px-5 pb-5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      applyMeasurementToEstimator(measurement, lead);
                      setHubReport(null);
                      enterLeadEstimator(lead.id, 'estimate');
                      showToast('Applied to estimate');
                    }}
                    className="btn-primary px-5 py-2.5 rounded-2xl text-sm font-semibold"
                  >
                    Apply to estimate
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setHubReport(null);
                      openMeasureRoof(lead.id);
                      setSelectedMeasurementId(measurement.id);
                    }}
                    className="px-5 py-2.5 rounded-2xl text-sm font-medium border border-zinc-200 text-zinc-700 hover:bg-zinc-100"
                  >
                    Open on lead
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

      {!showProfessionalEstimate && (
      <div
        className={
          isEditingLead && currentLeadId
            ? 'w-full page-fade'
            : 'page-shell page-fade'
        }
        key={
          isEditingLead && currentLeadId
            ? `profile-${currentLeadId}`
            : `tab-${activeTab}`
        }
      >
        {isEditingLead && currentLeadId ? null : (
        <>
        {activeTab === 'home' && (() => {
          // Client-only greeting (sessionReady already true here)
          const greeting = timeOfDayGreeting();
          const firstName = firstNameFrom(userName, 'Joe');

          return (
            <div className="pb-8 w-full">
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-6 mb-12">
                <div>
                  <div className="text-5xl font-bold tracking-tighter text-zinc-900">
                    {greeting}, {firstName}
                  </div>
                  <p className="text-xl text-zinc-500 mt-2">Welcome back</p>
                </div>

                <div className="sm:text-right">
                  <div className="text-sm uppercase tracking-widest text-zinc-400">
                    Pipeline Overview
                  </div>
                  <div className="text-sm font-medium text-sky-800/80 mt-1">
                    {leads.length} active job{leads.length === 1 ? '' : 's'}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4 mb-16">
                {PIPELINE_STAGES.map((stage) => {
                  const stageLeads = leads.filter(
                    (l) => normalizePipelineStage(l.category) === stage
                  );
                  const count = stageLeads.length;
                  const stageValue = stageLeads.reduce(
                    (sum, l) => sum + leadEstimateValue(l),
                    0
                  );
                  const styles = PIPELINE_STAGE_STYLES[stage];
                  const active = pipelineFilter === stage;
                  return (
                    <button
                      key={stage}
                      type="button"
                      onClick={() => {
                        setPipelineFilter(stage);
                        setLeadsView('active');
                        setLeadsSearch('');
                        handleTabChange('leads');
                      }}
                      className={`rounded-3xl border bg-white p-4 sm:p-5 text-center transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${
                        active
                          ? `border-zinc-800 ring-2 ${styles.ring} shadow-sm`
                          : 'border-zinc-200 hover:border-sky-300'
                      }`}
                      title={`View ${stage} leads`}
                    >
                      <div className="flex items-center justify-center gap-1.5 mb-2">
                        <span
                          className={`w-2.5 h-2.5 rounded-full shrink-0 shadow-sm ring-2 ring-white ${styles.dash}`}
                          aria-hidden
                        />
                        <div className="text-[10px] sm:text-xs font-medium uppercase tracking-wide text-zinc-500">
                          {stage}
                        </div>
                      </div>
                      <div className="text-3xl sm:text-4xl font-semibold tabular-nums tracking-tight text-zinc-900">
                        {count}
                      </div>
                      <div className="text-xs font-semibold text-zinc-600 mt-1 tabular-nums">
                        ${stageValue.toLocaleString()}
                      </div>
                      <div className="mt-1.5 text-[10px] font-medium text-zinc-400">
                        View
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Quick links — match original card stack */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
                <div
                  onClick={() => createNewLead()}
                  className="group bg-white border border-zinc-200/80 hover:border-sky-300/80 hover:shadow-md hover:-translate-y-0.5 rounded-3xl p-7 sm:p-8 cursor-pointer transition-all duration-200"
                >
                  <div className="text-xl sm:text-2xl font-semibold text-zinc-900 mb-1 group-hover:text-sky-900 transition-colors">
                    New Lead
                  </div>
                  <p className="text-sm text-zinc-500 group-hover:text-zinc-600">
                    Create a job · estimate from the lead profile
                  </p>
                </div>

                <div
                  onClick={() => openEstimatesHub()}
                  className="group bg-white border border-zinc-200/80 hover:border-sky-300/80 hover:shadow-md hover:-translate-y-0.5 rounded-3xl p-7 sm:p-8 cursor-pointer transition-all duration-200"
                >
                  <div className="text-xl sm:text-2xl font-semibold text-zinc-900 mb-1 group-hover:text-sky-900 transition-colors">
                    Estimates
                  </div>
                  <p className="text-sm text-zinc-500 group-hover:text-zinc-600">
                    All saved quotes across leads
                  </p>
                </div>

                <div
                  onClick={() => handleTabChange('invoices')}
                  className="group bg-white border border-zinc-200/80 hover:border-sky-300/80 hover:shadow-md hover:-translate-y-0.5 rounded-3xl p-7 sm:p-8 cursor-pointer transition-all duration-200"
                >
                  <div className="text-xl sm:text-2xl font-semibold text-zinc-900 mb-1 group-hover:text-sky-900 transition-colors">
                    Invoices
                  </div>
                  <p className="text-sm text-zinc-500 group-hover:text-zinc-600">
                    Mitigation and job invoices
                  </p>
                </div>

                <div
                  onClick={() => handleTabChange('leads')}
                  className="group bg-white border border-zinc-200/80 hover:border-sky-300/80 hover:shadow-md hover:-translate-y-0.5 rounded-3xl p-7 sm:p-8 cursor-pointer transition-all duration-200"
                >
                  <div className="text-xl sm:text-2xl font-semibold text-zinc-900 mb-1 group-hover:text-sky-900 transition-colors">
                    Pipeline
                  </div>
                  <p className="text-sm text-zinc-500 group-hover:text-zinc-600">
                    Pipeline board · open a job to estimate
                  </p>
                </div>

                <div
                  onClick={() => handleTabChange('documents')}
                  className="group bg-white border border-zinc-200/80 hover:border-sky-300/80 hover:shadow-md hover:-translate-y-0.5 rounded-3xl p-7 sm:p-8 cursor-pointer transition-all duration-200"
                >
                  <div className="text-xl sm:text-2xl font-semibold text-zinc-900 mb-1 group-hover:text-sky-900 transition-colors">
                    Documents
                  </div>
                  <p className="text-sm text-zinc-500 group-hover:text-zinc-600">
                    Contracts and files
                  </p>
                </div>

                <div
                  onClick={() => handleTabChange('calendar')}
                  className="group bg-white border border-zinc-200/80 hover:border-sky-300/80 hover:shadow-md hover:-translate-y-0.5 rounded-3xl p-7 sm:p-8 cursor-pointer transition-all duration-200"
                >
                  <div className="text-xl sm:text-2xl font-semibold text-zinc-900 mb-1 group-hover:text-sky-900 transition-colors">
                    Calendar
                  </div>
                  <p className="text-sm text-zinc-500 group-hover:text-zinc-600">
                    Schedule and follow-ups
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => handleTabChange('tools')}
                  className="group text-left bg-white border border-zinc-200/80 hover:border-sky-300/80 hover:shadow-md hover:-translate-y-0.5 rounded-3xl p-7 sm:p-8 transition-all duration-200"
                >
                  <div className="text-xl sm:text-2xl font-semibold text-zinc-900 mb-1 group-hover:text-sky-900 transition-colors">
                    Tools
                  </div>
                  <p className="text-sm text-zinc-500 group-hover:text-zinc-600">
                    Weather, canvassing
                  </p>
                </button>
              </div>
            </div>
          );
        })()}





        {activeTab === 'invoices' && (
          <div className="pb-8 w-full">
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-8">
              <div>
                <h1 className="text-3xl font-semibold text-zinc-900 tracking-tight">
                  Invoices
                </h1>
                <p className="text-zinc-500 mt-1">
                  Mitigation and job invoices across leads
                </p>
              </div>
            </div>
            <div className="rounded-3xl border border-dashed border-zinc-200 bg-white px-6 py-16 text-center">
              <p className="text-sm font-medium text-zinc-800">No invoices yet</p>
              <p className="text-sm text-zinc-500 mt-2 max-w-md mx-auto">
                Create one from a lead&apos;s Documents or Tools → Mitigation
                invoice.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  onClick={() => handleTabChange('leads')}
                  className="btn-primary px-5 py-2.5 rounded-2xl text-sm font-semibold"
                >
                  Go to jobs
                </button>
                <button
                  type="button"
                  onClick={() => handleTabChange('tools')}
                  className="px-5 py-2.5 rounded-2xl text-sm font-medium border border-zinc-200 text-zinc-700 hover:bg-zinc-50"
                >
                  Open tools
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'estimates' && (() => {
          const items = allEstimates();
          return (
            <div className="pb-8 w-full">
              <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-8">
                <div>
                  <h1 className="text-3xl font-semibold text-zinc-900 tracking-tight">
                    Estimates
                  </h1>
                  <p className="text-zinc-500 mt-1">
                    {items.length === 0
                      ? 'Saved quotes across all leads'
                      : `${items.length} saved estimate${items.length === 1 ? '' : 's'}`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => openEstimatePicker('estimate')}
                  className="btn-primary px-5 py-2.5 rounded-2xl text-sm font-semibold"
                >
                  New estimate
                </button>
              </div>

              {items.length === 0 ? (
                <div className="rounded-3xl border border-dashed border-zinc-200 bg-white px-6 py-16 text-center">
                  <p className="text-sm font-medium text-zinc-800">No estimates yet</p>
                  <p className="text-sm text-zinc-500 mt-2 max-w-md mx-auto">
                    Open a lead and create an estimate — they all list here.
                  </p>
                  <div className="mt-6 flex flex-wrap justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => openEstimatePicker('estimate')}
                      className="btn-primary px-5 py-2.5 rounded-2xl text-sm font-semibold"
                    >
                      New estimate
                    </button>
                    <button
                      type="button"
                      onClick={() => handleTabChange('leads')}
                      className="px-5 py-2.5 rounded-2xl text-sm font-medium border border-zinc-200 text-zinc-700 hover:bg-zinc-50"
                    >
                      Go to jobs
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {items.map(({ lead, estimate, leadName }) => {
                    const addr = [
                      lead.clientAddress,
                      lead.clientCity,
                      lead.clientState,
                    ]
                      .filter(Boolean)
                      .join(', ');
                    const total =
                      estimate.negotiatedPrice || estimate.total || 0;
                    return (
                      <div
                        key={`${lead.id}-${estimate.id}`}
                        className="bg-white border border-zinc-200 rounded-3xl p-5 hover:border-sky-300 hover:shadow-sm transition-all"
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                          <button
                            type="button"
                            className="text-left min-w-0 flex-1"
                            onClick={() =>
                              loadEstimate(estimate, { leadId: lead.id })
                            }
                          >
                            <div className="font-semibold text-zinc-900 truncate">
                              {leadName}
                            </div>
                            <div className="text-sm text-zinc-500 mt-0.5 truncate">
                              {estimate.date}
                              {estimate.selectedShingle
                                ? ` · ${estimate.selectedShingle}`
                                : ''}
                              {estimate.squares
                                ? ` · ${estimate.squares} sq`
                                : ''}
                              {addr ? ` · ${addr}` : ''}
                            </div>
                          </button>
                          <div className="flex items-center gap-3 shrink-0">
                            <div className="text-xl font-semibold tabular-nums text-emerald-700">
                              ${total.toLocaleString()}
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                loadEstimate(estimate, { leadId: lead.id })
                              }
                              className="btn-primary px-3 py-1.5 text-xs font-semibold rounded-lg"
                            >
                              Open
                            </button>
                            <button
                              type="button"
                              onClick={() => openLeadProfile(lead.id, lead)}
                              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-zinc-200 text-zinc-700 hover:bg-zinc-50"
                            >
                              Lead
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}

        {activeTab === 'documents' && (
          <div className="pb-8 w-full max-w-3xl">
            <h1 className="text-3xl font-semibold text-zinc-900 tracking-tight">
              Documents
            </h1>
            <p className="text-zinc-500 mt-1 mb-8">
              System templates you can fill and assign to a job, or add from a
              lead’s Documents tab.
            </p>
            <div className="space-y-3">
              {SYSTEM_DOCUMENTS.map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  onClick={() => {
                    if (doc.id === 'takeoff') {
                      setTakeoffForm(emptyTakeoff());
                      setSystemDocWorkspace('takeoff');
                      setSystemDocPreview(null);
                      setTakeoffAssignOpen(false);
                      setTakeoffAssignSearch('');
                    } else if (doc.id === 'pricing') {
                      setSystemDocWorkspace('pricing');
                      setSystemDocPreview(null);
                    }
                  }}
                  className="w-full text-left rounded-3xl border border-zinc-200 bg-white p-5 hover:border-sky-300 transition"
                >
                  <div className="font-semibold text-zinc-900">{doc.name}</div>
                  <div className="text-sm text-zinc-500 mt-1">{doc.description}</div>
                </button>
              ))}
            </div>
            <p className="text-xs text-zinc-400 mt-6">
              Open Take-off or Company pricing here, or on a lead use Documents →
              + Add → From system.
            </p>
          </div>
        )}

        {systemDocWorkspace === 'pricing' && (
        <div className="fixed inset-0 z-[85] bg-zinc-50 overflow-y-auto">
          <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 py-6 pb-20">
            <div className="flex items-center justify-between gap-3 mb-4 sticky top-0 bg-zinc-50/95 backdrop-blur py-3 z-10">
              <div>
                <h1 className="text-xl font-semibold text-zinc-900">Company pricing</h1>
                <p className="text-xs text-zinc-500">Cost · Sell PHX · Sell Tuc/North</p>
              </div>
              <button
                type="button"
                onClick={() => setSystemDocWorkspace(null)}
                className="text-sm font-medium text-sky-700 shrink-0"
              >
                Close
              </button>
            </div>
            <div className="grid grid-cols-1 gap-4">
              {PRICING_GUIDE.map((section) => (
                <section
                  key={section.title}
                  className="rounded-2xl border border-zinc-200 bg-white overflow-hidden"
                >
                  <div className="px-3 py-2 border-b border-zinc-100 bg-zinc-50">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-600">
                      {section.title}
                    </h2>
                  </div>
                  <div className="divide-y divide-zinc-50">
                    {section.rows.map((row, idx) => {
                      const live =
                        row.key && priceSheet && priceSheet[row.key] != null
                          ? Number(priceSheet[row.key])
                          : null;
                      const sellPhx = live != null && live > 0 ? live : row.sellPhx;
                      const liveCost =
                        row.key != null
                          ? getCost(row.key, row.cost ?? 0)
                          : row.cost ?? 0;
                      const unit = row.unit || '';
                      const money = (n?: number) =>
                        n != null && n > 0 ? (
                          <span className="whitespace-nowrap">
                            <span className="font-semibold text-zinc-900">
                              ${Number(n).toLocaleString()}
                            </span>
                            {unit ? (
                              <span className="text-[10px] text-zinc-400 ml-0.5">{unit}</span>
                            ) : null}
                          </span>
                        ) : null;
                      return (
                        <div
                          key={`${section.title}-${idx}`}
                          className="px-3 py-2 flex items-start justify-between gap-3"
                        >
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-zinc-900 leading-snug">
                              {row.label}
                            </div>
                            {row.note && (
                              <div className="text-[11px] text-zinc-400 leading-snug mt-0.5">
                                {row.note}
                              </div>
                            )}
                          </div>
                          <div className="text-right shrink-0 text-xs leading-snug space-y-0.5">
                            {liveCost > 0 && (
                              <div className="text-zinc-500">
                                C{' '}
                                <span className="font-medium text-zinc-700">
                                  ${Number(liveCost).toLocaleString()}
                                </span>
                                {unit ? (
                                  <span className="text-[10px] text-zinc-400 ml-0.5">
                                    {unit}
                                  </span>
                                ) : null}
                              </div>
                            )}
                            {sellPhx != null && sellPhx > 0 && (
                              <div>
                                <span className="text-zinc-400">PHX </span>
                                {money(sellPhx)}
                              </div>
                            )}
                            {row.sellTuc != null && row.sellTuc > 0 && (
                              <div>
                                <span className="text-zinc-400">Tuc </span>
                                {money(row.sellTuc)}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </div>
      )}
{systemDocWorkspace === 'takeoff' && (
          <div className="fixed inset-0 z-[85] bg-zinc-50 overflow-y-auto">
            <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 py-6 pb-28">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
                <div>
                  <h1 className="text-xl font-semibold text-zinc-900">
                    Take-off / Inspection Sheet
                  </h1>
                  <p className="text-sm text-zinc-500">
                    Fill now, then assign to a lead
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSystemDocWorkspace(null);
                    setTakeoffAssignOpen(false);
                  }}
                  className="text-sm text-zinc-600 hover:text-zinc-900 px-3 py-1.5 rounded-xl border border-zinc-200 bg-white"
                >
                  Close
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                {TAKEOFF_FIELD_LABELS.map(({ key, label }) =>
                  key === 'notes' ? (
                    <div key={key} className="md:col-span-2">
                      <label className="text-xs text-zinc-500 mb-1 block">
                        {label}
                      </label>
                      <textarea
                        value={takeoffForm[key]}
                        onChange={(e) =>
                          setTakeoffForm((f) => ({
                            ...f,
                            [key]: e.target.value,
                          }))
                        }
                        rows={3}
                        className="w-full border border-zinc-200 rounded-xl px-3 py-2 text-sm text-zinc-900 bg-white"
                      />
                    </div>
                  ) : (
                    <div key={key}>
                      <label className="text-xs text-zinc-500 mb-1 block">
                        {label}
                      </label>
                      <input
                        value={takeoffForm[key]}
                        onChange={(e) =>
                          setTakeoffForm((f) => ({
                            ...f,
                            [key]: e.target.value,
                          }))
                        }
                        className="w-full border border-zinc-200 rounded-xl px-3 py-2 text-sm text-zinc-900 bg-white"
                      />
                    </div>
                  )
                )}
              </div>

              <div className="flex flex-wrap gap-2 sticky bottom-4">
                <button
                  type="button"
                  onClick={() => setTakeoffAssignOpen(true)}
                  className="px-4 py-2.5 rounded-xl bg-sky-600 text-white text-sm font-medium hover:bg-sky-700"
                >
                  Assign to lead
                </button>
                <button
                  type="button"
                  onClick={() => void assignTakeoffToNewLead()}
                  className="px-4 py-2.5 rounded-xl border border-zinc-200 bg-white text-sm font-medium text-zinc-800 hover:border-sky-300"
                >
                  New lead + assign
                </button>
              </div>
            </div>

            {takeoffAssignOpen && (
              <div className="fixed inset-0 z-[90] bg-black/40 flex items-end sm:items-center justify-center p-4">
                <div className="bg-white rounded-3xl w-full max-w-md max-h-[80vh] overflow-hidden flex flex-col shadow-lg">
                  <div className="p-4 border-b border-zinc-100">
                    <div className="font-semibold text-zinc-900 mb-2">
                      Assign to lead
                    </div>
                    <input
                      value={takeoffAssignSearch}
                      onChange={(e) => setTakeoffAssignSearch(e.target.value)}
                      placeholder="Search name, job #, address…"
                      className="w-full border border-zinc-200 rounded-xl px-3 py-2 text-sm"
                      autoFocus
                    />
                  </div>
                  <div className="overflow-y-auto flex-1 p-2">
                    {leads
                      .filter((l) => {
                        const q = takeoffAssignSearch.trim().toLowerCase();
                        if (!q) return true;
                        const hay = [
                          l.clientFirstName,
                          l.clientLastName,
                          l.jobNumber,
                          l.clientAddress,
                          l.clientCity,
                          l.clientPhone,
                        ]
                          .join(' ')
                          .toLowerCase();
                        return hay.includes(q);
                      })
                      .slice(0, 50)
                      .map((l) => (
                        <button
                          key={l.id}
                          type="button"
                          onClick={() => assignTakeoffToLead(l.id)}
                          className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-sky-50 text-sm"
                        >
                          <div className="font-medium text-zinc-900">
                            {[l.clientFirstName, l.clientLastName]
                              .filter(Boolean)
                              .join(' ') || 'Untitled lead'}
                          </div>
                          <div className="text-xs text-zinc-500">
                            {l.jobNumber || 'No job #'}
                            {l.clientAddress ? ` · ${l.clientAddress}` : ''}
                          </div>
                        </button>
                      ))}
                    {leads.length === 0 && (
                      <p className="text-sm text-zinc-500 px-3 py-4">
                        No leads yet — use New lead + assign.
                      </p>
                    )}
                  </div>
                  <div className="p-3 border-t border-zinc-100">
                    <button
                      type="button"
                      onClick={() => setTakeoffAssignOpen(false)}
                      className="text-sm text-zinc-500 hover:text-zinc-800"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'calendar' && (() => {
          const openJobs = leads.filter(
            (l) => normalizePipelineStage(l.category) !== 'Closed'
          );
          const synced = openJobs.filter((l) => l.calendarEventId);
          const todayIso = toLocalIsoDate(new Date());

          // Group jobs by schedule date
          const byDate = new Map<string, Lead[]>();
          for (const lead of openJobs) {
            const key = leadScheduleIso(lead);
            if (!key) continue;
            const list = byDate.get(key) || [];
            list.push(lead);
            byDate.set(key, list);
          }

          const weekStart = startOfWeekSunday(calendarCursor);
          const weekDays = Array.from({ length: 7 }, (_, i) =>
            addDays(weekStart, i)
          );

          // Month grid: full weeks covering the month
          const monthStart = new Date(
            calendarCursor.getFullYear(),
            calendarCursor.getMonth(),
            1
          );
          monthStart.setHours(12, 0, 0, 0);
          const monthGridStart = startOfWeekSunday(monthStart);
          const monthDays = Array.from({ length: 42 }, (_, i) =>
            addDays(monthGridStart, i)
          );
          const selectedIso =
            calendarSelectedDay ||
            todayIso ||
            toLocalIsoDate(calendarCursor);
          const dayJobs = byDate.get(selectedIso) || [];
          const unscheduled = openJobs.filter((l) => !leadScheduleIso(l));

          const scheduleLeadOnDay = (leadId: number, iso: string) => {
            const updated = leads.map((l) =>
              l.id === leadId ? { ...l, followUpDate: iso } : l
            );
            persistLeads(updated);
            setCalendarSelectedDay(iso);
            showToast(`Scheduled for ${iso}`);
          };

          const scheduleName = firstNameFrom(userName, 'Joe');
          const monthLabel = calendarCursor.toLocaleDateString(undefined, {
            month: 'long',
            year: 'numeric',
          });

          return (
            <div className="pb-8 w-full max-w-6xl mx-auto space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">
                    Summit Calendar
                  </h1>
                  <p className="text-zinc-500 mt-1">
                    {scheduleName}
                    {gcalEmail ? ` · ${gcalEmail}` : ''}
                    {gcalConnected
                      ? ` · ${synced.length}/${openJobs.length} jobs linked`
                      : ''}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {gcalConnected ? (
                    <>
                      <button
                        type="button"
                        disabled={googleEventsLoading}
                        onClick={() => void loadGoogleEvents()}
                        className="btn-primary px-5 py-2.5 rounded-2xl text-sm font-semibold disabled:opacity-50"
                      >
                        {googleEventsLoading
                          ? 'Loading…'
                          : 'Refresh from Google'}
                      </button>
                      <button
                        type="button"
                        disabled={gcalBusy || openJobs.length === 0}
                        onClick={() => void syncLeadsToGoogleCalendar()}
                        className="px-5 py-2.5 rounded-2xl text-sm font-semibold border border-zinc-200 text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
                      >
                        {gcalBusy ? 'Syncing…' : 'Sync jobs'}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={gcalBusy}
                      onClick={() => void connectGoogleCalendar()}
                      className="btn-primary px-5 py-2.5 rounded-2xl text-sm font-semibold disabled:opacity-50"
                    >
                      Connect Google
                    </button>
                  )}
                </div>
              </div>

              {/* Mini month (left) + week strip & agenda (right) */}
              <div className="flex flex-col lg:flex-row gap-6 lg:gap-8">
                {/* Left: mini month */}
                <div className="w-full lg:w-64 shrink-0 bg-white border border-zinc-200 rounded-2xl p-4 h-fit">
                  <div className="flex items-center justify-between mb-3">
                    <button
                      type="button"
                      onClick={() =>
                        setCalendarCursor((prev) => {
                          const n = new Date(prev);
                          n.setMonth(n.getMonth() - 1);
                          return n;
                        })
                      }
                      className="w-8 h-8 rounded-lg text-zinc-600 hover:bg-zinc-100 text-sm"
                      aria-label="Previous month"
                    >
                      ←
                    </button>
                    <div className="text-center text-emerald-700 font-semibold text-sm">
                      {monthLabel}
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setCalendarCursor((prev) => {
                          const n = new Date(prev);
                          n.setMonth(n.getMonth() + 1);
                          return n;
                        })
                      }
                      className="w-8 h-8 rounded-lg text-zinc-600 hover:bg-zinc-100 text-sm"
                      aria-label="Next month"
                    >
                      →
                    </button>
                  </div>
                  <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium text-zinc-400 mb-1">
                    {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                      <div key={`mh-${i}`}>{d}</div>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-1 text-center text-xs">
                    {monthDays.map((day) => {
                      const iso = toLocalIsoDate(day);
                      const inMonth =
                        day.getMonth() === calendarCursor.getMonth();
                      const isToday = iso === todayIso;
                      const isSelected = iso === selectedIso;
                      const hasJob = (byDate.get(iso) || []).length > 0;
                      return (
                        <button
                          key={iso}
                          type="button"
                          onClick={() => {
                            setCalendarSelectedDay(iso);
                            setCalendarCursor(day);
                          }}
                          className={`py-1.5 rounded-lg tabular-nums transition-colors ${
                            isSelected
                              ? 'day-highlight font-semibold'
                              : isToday
                                ? 'bg-transparent text-slate-800 font-semibold border border-slate-500'
                                : inMonth
                                  ? 'text-zinc-800 hover:bg-white'
                                  : 'text-zinc-300'
                          }`}
                        >
                          {day.getDate()}
                          {hasJob && !isSelected ? (
                            <span className="block w-1 h-1 mx-auto mt-0.5 rounded-full bg-slate-500" />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const now = new Date();
                      setCalendarCursor(now);
                      setCalendarSelectedDay(toLocalIsoDate(now));
                    }}
                    className="mt-3 w-full text-xs font-medium text-slate-800 hover:underline"
                  >
                    Today
                  </button>
                </div>

                {/* Right: week header + Google agenda */}
                <div className="flex-1 min-w-0">
                  <div className="grid grid-cols-7 gap-2 text-center text-sm mb-4">
                    {weekDays.map((day) => {
                      const iso = toLocalIsoDate(day);
                      const isToday = iso === todayIso;
                      const isSelected = iso === selectedIso;
                      const label = day.toLocaleDateString('en-US', {
                        weekday: 'short',
                        day: 'numeric',
                      });
                      return (
                        <button
                          key={`wk-${iso}`}
                          type="button"
                          onClick={() => {
                            setCalendarSelectedDay(iso);
                            setCalendarCursor(day);
                          }}
                          className={`rounded-xl py-3 border transition-colors ${
                            isSelected
                              ? 'day-highlight font-semibold'
                              : isToday
                                ? 'bg-transparent text-slate-900 border-slate-500 font-medium'
                                : 'bg-white border-zinc-200 text-zinc-700 hover:border-sky-300'
                          }`}
                        >
                          {label.toUpperCase()}
                        </button>
                      );
                    })}
                  </div>

                  <div className="space-y-3 max-h-[min(640px,60vh)] overflow-y-auto">
                    {!gcalConnected ? (
                      <div className="text-center py-20 text-zinc-400 text-sm rounded-2xl border border-dashed border-zinc-200 bg-white">
                        <p>Refresh Google Calendar to see your events</p>
                        <button
                          type="button"
                          disabled={gcalBusy}
                          onClick={() => void connectGoogleCalendar()}
                          className="btn-primary mt-4 px-5 py-2.5 rounded-2xl text-sm font-semibold"
                        >
                          Connect Google
                        </button>
                      </div>
                    ) : googleEventsLoading &&
                      googleCalendarEvents.length === 0 ? (
                      <div className="text-center py-20 text-zinc-400 text-sm">
                        Loading events…
                      </div>
                    ) : googleCalendarEvents.length === 0 ? (
                      <div className="text-center py-20 text-zinc-400 text-sm rounded-2xl border border-dashed border-zinc-200 bg-white">
                        Refresh Google Calendar to see your events
                      </div>
                    ) : (
                      googleCalendarEvents.map((event) => {
                        const startRaw =
                          event.start?.dateTime || event.start?.date;
                        const isAllDay = Boolean(
                          event.start?.date && !event.start?.dateTime
                        );
                        const timeLabel = !startRaw
                          ? '—'
                          : isAllDay
                            ? 'All day'
                            : new Date(startRaw).toLocaleTimeString([], {
                                hour: 'numeric',
                                minute: '2-digit',
                              });
                        return (
                          <div
                            key={event.id}
                            className="flex items-center gap-6 bg-transparent border border-slate-500 hover:border-slate-400 rounded-2xl p-4 transition"
                          >
                            <div className="w-24 shrink-0 font-mono text-slate-500 text-sm">
                              {timeLabel}
                            </div>
                            <div className="flex-1 min-w-0 font-semibold text-zinc-900 truncate">
                              {event.summary || '(No title)'}
                            </div>
                            {event.htmlLink ? (
                              <a
                                href={event.htmlLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-slate-500 bg-transparent px-3 py-1 rounded-full border border-slate-500 shrink-0"
                              >
                                Open
                              </a>
                            ) : (
                              <div className="text-xs text-slate-500 bg-transparent px-3 py-1 rounded-full border border-slate-500 shrink-0">
                                Open
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>

              {/* Selected day detail */}
              <div className="rounded-3xl border border-zinc-200 bg-white p-5 sm:p-6 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <div>
                    <h2 className="text-lg font-semibold text-zinc-900">
                      {selectedIso === todayIso
                        ? 'Today'
                        : new Date(selectedIso + 'T12:00:00').toLocaleDateString(
                            undefined,
                            {
                              weekday: 'long',
                              month: 'long',
                              day: 'numeric',
                            }
                          )}
                    </h2>
                    <p className="text-sm text-zinc-500 mt-0.5">
                      {dayJobs.length === 0
                        ? 'No jobs scheduled — assign one below'
                        : `${dayJobs.length} job${dayJobs.length === 1 ? '' : 's'} this day`}
                    </p>
                  </div>
                </div>

                {dayJobs.length > 0 && (
                  <div className="space-y-2">
                    {dayJobs.map((lead) => {
                      const name =
                        [lead.clientFirstName, lead.clientLastName]
                          .filter(Boolean)
                          .join(' ') || 'Untitled job';
                      return (
                        <div
                          key={lead.id}
                          className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-2xl border border-zinc-200 px-4 py-3"
                        >
                          <button
                            type="button"
                            className="text-left min-w-0"
                            onClick={() => openLeadProfile(lead.id, lead)}
                          >
                            <div className="font-semibold text-zinc-900 truncate">
                              {name}
                            </div>
                            <div className="text-xs text-zinc-500 mt-0.5">
                              {lead.category}
                              {lead.jobNumber ? ` · #${lead.jobNumber}` : ''}
                              {lead.calendarEventId ? ' · Synced' : ''}
                            </div>
                          </button>
                          <div className="flex gap-2 shrink-0">
                            <button
                              type="button"
                              disabled={!gcalConnected || gcalBusy}
                              onClick={() =>
                                void syncLeadsToGoogleCalendar({
                                  leadIds: [lead.id],
                                })
                              }
                              className="px-3 py-1.5 text-xs font-semibold rounded-lg btn-primary disabled:opacity-50"
                            >
                              {lead.calendarEventId ? 'Update Google' : 'Sync'}
                            </button>
                            <button
                              type="button"
                              onClick={() => openLeadProfile(lead.id, lead)}
                              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-zinc-200 text-zinc-700 hover:bg-zinc-50"
                            >
                              Open
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {unscheduled.length > 0 && (
                  <div className="pt-2 border-t border-zinc-100">
                    <div className="text-xs font-medium uppercase tracking-wide text-zinc-400 mb-2">
                      Schedule on this day
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {unscheduled.slice(0, 8).map((lead) => {
                        const name =
                          [lead.clientFirstName, lead.clientLastName]
                            .filter(Boolean)
                            .join(' ') || 'Untitled';
                        return (
                          <button
                            key={lead.id}
                            type="button"
                            onClick={() =>
                              scheduleLeadOnDay(lead.id, selectedIso)
                            }
                            className="px-3 py-1.5 rounded-full text-xs font-medium border border-zinc-200 text-zinc-700 hover:bg-zinc-100 hover:border-sky-300"
                          >
                            + {name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {unscheduled.length === 0 && dayJobs.length === 0 && (
                  <p className="text-sm text-zinc-500">
                    All open jobs have dates, or create a new lead from Home.
                  </p>
                )}
              </div>
            </div>
          );
        })()}

        {activeTab === 'performance' && (() => {
          const estimates = allEstimates();
          const pipelineValue = estimates.reduce(
            (sum, { estimate }) =>
              sum + (estimate.negotiatedPrice || estimate.total || 0),
            0
          );
          const avgDeal =
            estimates.length > 0
              ? Math.round(pipelineValue / estimates.length)
              : 0;
          const closedCount = leads.filter(
            (l) => normalizePipelineStage(l.category) === 'Closed'
          ).length;
          const stageCounts = PIPELINE_STAGES.map((stage) => ({
            stage,
            count: leads.filter(
              (l) => normalizePipelineStage(l.category) === stage
            ).length,
            styles: PIPELINE_STAGE_STYLES[stage],
          }));
          const maxStage = Math.max(1, ...stageCounts.map((s) => s.count));

          return (
            <div className="pb-8 w-full">
              <div className="mb-8">
                <h1 className="text-3xl font-semibold text-zinc-900 tracking-tight">
                  Performance
                </h1>
                <p className="text-zinc-500 mt-1">
                  Pipeline health from your jobs and estimates
                </p>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-8">
                <div className="rounded-3xl border border-zinc-200 bg-white p-5">
                  <div className="text-[11px] uppercase tracking-wide text-zinc-400 font-medium">
                    Active jobs
                  </div>
                  <div className="text-3xl font-semibold tabular-nums text-zinc-900 mt-1">
                    {leads.length}
                  </div>
                </div>
                <div className="rounded-3xl border border-zinc-200 bg-white p-5">
                  <div className="text-[11px] uppercase tracking-wide text-zinc-400 font-medium">
                    Estimates
                  </div>
                  <div className="text-3xl font-semibold tabular-nums text-zinc-900 mt-1">
                    {estimates.length}
                  </div>
                </div>
                <div className="rounded-3xl border border-zinc-200 bg-white p-5">
                  <div className="text-[11px] uppercase tracking-wide text-zinc-400 font-medium">
                    Pipeline value
                  </div>
                  <div className="text-3xl font-semibold tabular-nums text-emerald-700 mt-1">
                    ${pipelineValue.toLocaleString()}
                  </div>
                </div>
                <div className="rounded-3xl border border-zinc-200 bg-white p-5">
                  <div className="text-[11px] uppercase tracking-wide text-zinc-400 font-medium">
                    Avg estimate
                  </div>
                  <div className="text-3xl font-semibold tabular-nums text-zinc-900 mt-1">
                    ${avgDeal.toLocaleString()}
                  </div>
                  {closedCount > 0 && (
                    <div className="text-xs text-zinc-500 mt-1">
                      {closedCount} closed
                    </div>
                  )}
                </div>
              </div>

              <section className="rounded-3xl border border-zinc-200 bg-white p-5 sm:p-6">
                <h2 className="text-lg font-semibold text-zinc-900 mb-1">
                  Pipeline by stage
                </h2>
                <p className="text-sm text-zinc-500 mb-6">
                  Where jobs sit right now
                </p>
                <div className="space-y-4">
                  {stageCounts.map(({ stage, count, styles }) => (
                    <button
                      key={stage}
                      type="button"
                      onClick={() => {
                        setPipelineFilter(stage);
                        setLeadsView('active');
                        handleTabChange('leads');
                      }}
                      className="w-full text-left group"
                    >
                      <div className="flex items-center justify-between gap-3 mb-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={`w-2.5 h-2.5 rounded-full shrink-0 ${styles.dash}`}
                            aria-hidden
                          />
                          <span className="text-sm font-medium text-zinc-800 group-hover:text-zinc-950">
                            {stage}
                          </span>
                        </div>
                        <span className="text-sm font-semibold tabular-nums text-zinc-900">
                          {count}
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-zinc-100 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${styles.dash}`}
                          style={{
                            width: `${Math.max(count > 0 ? 8 : 0, (count / maxStage) * 100)}%`,
                            opacity: count > 0 ? 0.85 : 0,
                          }}
                        />
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            </div>
          );
        })()}

        {activeTab === 'tools' && (
          <div className="pb-8 w-full">
            <div className="mb-8">
              <h1 className="text-3xl font-semibold text-zinc-900 tracking-tight">
                Tools
              </h1>
              <p className="text-zinc-500 mt-1">
                Field tools — more coming soon
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-white border border-zinc-200 rounded-3xl p-6 sm:p-7">
                <div className="text-xl font-semibold text-zinc-900 mb-1">
                  Weather Tracking
                </div>
                <p className="text-sm text-zinc-500">Coming soon</p>
              </div>
              <div className="bg-white border border-zinc-200 rounded-3xl p-6 sm:p-7">
                <div className="text-xl font-semibold text-zinc-900 mb-1">
                  Canvassing
                </div>
                <p className="text-sm text-zinc-500">Coming soon</p>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="pb-8 w-full page-fade">
            <h1 className="text-3xl font-semibold text-zinc-900 tracking-tight">
              Profile settings
            </h1>
            <p className="text-zinc-500 mt-1 mb-8">
              Your contact appears on estimates and PDFs as the project manager.
            </p>

            <div className="max-w-xl space-y-6">
              <section className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6 space-y-4">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-900">
                    Cloud (Supabase)
                  </h2>
                  <p className="text-sm text-zinc-500 mt-1">
                    Backend client for future lead sync. Keys live in{' '}
                    <code className="text-xs bg-zinc-100 px-1 rounded">
                      .env.local
                    </code>
                    , not in source.
                  </p>
                </div>
                <div
                  className={`rounded-2xl border px-4 py-3 text-sm ${
                    supabaseEnabled
                      ? 'border-slate-200 bg-slate-50 text-slate-800'
                      : 'border-dashed border-zinc-200 bg-zinc-50 text-zinc-600'
                  }`}
                >
                  {supabaseEnabled ? (
                    <>
                      <div className="font-semibold text-zinc-900">Connected</div>
                      <div className="text-xs text-zinc-500 mt-0.5 truncate">
                        {process.env.NEXT_PUBLIC_SUPABASE_URL || 'Supabase project'}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="font-medium text-zinc-800">Not configured</div>
                      <p className="mt-1 text-xs">
                        Set{' '}
                        <code className="bg-zinc-200/80 px-1 rounded">
                          NEXT_PUBLIC_SUPABASE_URL
                        </code>{' '}
                        and{' '}
                        <code className="bg-zinc-200/80 px-1 rounded">
                          NEXT_PUBLIC_SUPABASE_ANON_KEY
                        </code>
                        , then restart the dev server.
                      </p>
                    </>
                  )}
                </div>
                {supabaseEnabled && supabase ? (
                  <p className="text-xs text-zinc-400">
                    Browser client ready for cloud sync.
                  </p>
                ) : null}
              </section>

              <section className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6 space-y-4">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-900">
                    Google Calendar
                  </h2>
                  <p className="text-sm text-zinc-500 mt-1">
                    Connect your calendar and sync open jobs as all-day follow-ups
                    (stage, address, and contact on the event).
                  </p>
                </div>

                {!gcalConfigured ? (
                  <div className="rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 px-4 py-4 text-sm text-zinc-600">
                    <p className="font-medium text-zinc-800">Setup required</p>
                    <p className="mt-1">
                      Add{' '}
                      <code className="text-xs bg-zinc-200/80 px-1 rounded">
                        NEXT_PUBLIC_GOOGLE_CLIENT_ID
                      </code>{' '}
                      to{' '}
                      <code className="text-xs bg-zinc-200/80 px-1 rounded">
                        .env.local
                      </code>
                      , enable the Google Calendar API, and add{' '}
                      <code className="text-xs bg-zinc-200/80 px-1 rounded">
                        http://localhost:3000
                      </code>{' '}
                      under Authorized JavaScript origins.
                    </p>
                  </div>
                ) : gcalConnected ? (
                  <div className="space-y-3">
                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 px-4 py-3">
                      <div className="text-sm font-semibold text-emerald-900">
                        Connected
                      </div>
                      <div className="text-sm text-emerald-800/90 mt-0.5">
                        {gcalName || gcalEmail || 'Google account'}
                        {gcalName && gcalEmail ? ` · ${gcalEmail}` : ''}
                      </div>
                      {gcalLastSync && (
                        <div className="text-xs text-emerald-700/80 mt-1">
                          Last sync{' '}
                          {new Date(gcalLastSync).toLocaleString()}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={gcalBusy || leads.length === 0}
                        onClick={() => void syncLeadsToGoogleCalendar()}
                        className="btn-primary px-5 py-2.5 rounded-2xl text-sm font-semibold disabled:opacity-50"
                      >
                        {gcalBusy ? 'Syncing…' : 'Sync jobs to calendar'}
                      </button>
                      <button
                        type="button"
                        disabled={gcalBusy}
                        onClick={() => void disconnectGoogleCalendar()}
                        className="px-5 py-2.5 rounded-2xl text-sm font-medium border border-zinc-200 text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                      >
                        Disconnect
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTabChange('calendar')}
                        className="px-5 py-2.5 rounded-2xl text-sm font-medium border border-zinc-200 text-zinc-700 hover:bg-zinc-50"
                      >
                        View calendar
                      </button>
                    </div>
                    <p className="text-xs text-zinc-400">
                      Closed jobs are skipped. Re-sync updates existing events when
                      a job already has a calendar link.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <button
                      type="button"
                      disabled={gcalBusy}
                      onClick={connectGoogleCalendar}
                      className="btn-primary px-5 py-2.5 rounded-2xl text-sm font-semibold inline-flex items-center gap-2"
                    >
                      <svg
                        className="w-4 h-4"
                        viewBox="0 0 24 24"
                        aria-hidden
                      >
                        <path
                          fill="currentColor"
                          d="M19.5 3h-2V1.5h-1.5V3h-7.5V1.5H6.75V3h-2A1.5 1.5 0 0 0 3.25 4.5v15A1.5 1.5 0 0 0 4.75 21h14.75a1.5 1.5 0 0 0 1.5-1.5v-15A1.5 1.5 0 0 0 19.5 3Zm0 16.5H4.75v-11h14.75v11Z"
                        />
                      </svg>
                      Connect Google Calendar
                    </button>
                    <p className="text-xs text-zinc-400">
                      You’ll authorize Summit to create and update events on your
                      primary calendar only.
                    </p>
                  </div>
                )}
              </section>

              <section className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6 space-y-4">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-900">
                    Appearance
                  </h2>
                  <p className="text-sm text-zinc-500 mt-1">
                    Day or night across the whole app. Auto follows your local
                    clock (night 7:00 PM – 7:00 AM).
                  </p>
                </div>
                <div className="inline-flex w-full sm:w-auto p-1 rounded-2xl bg-zinc-100 border border-zinc-200/80">
                  {(
                    [
                      {
                        id: 'day' as const,
                        label: 'Day',
                        hint: 'Light',
                      },
                      {
                        id: 'night' as const,
                        label: 'Night',
                        hint: 'Dark',
                      },
                      {
                        id: 'auto' as const,
                        label: 'Auto',
                        hint: 'By time',
                      },
                    ] as const
                  ).map((opt) => {
                    const active = themePref === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setThemePref(opt.id)}
                        className={`flex-1 sm:flex-none min-w-[5.5rem] px-4 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                          active
                            ? 'bg-zinc-900 text-white shadow-sm'
                            : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-200/60'
                        }`}
                      >
                        <span className="block">{opt.label}</span>
                        <span
                          className={`block text-[10px] font-medium mt-0.5 ${
                            active ? 'text-white/70' : 'text-zinc-400'
                          }`}
                        >
                          {opt.hint}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-zinc-400">
                  Now showing{' '}
                  <span className="font-medium text-zinc-600">
                    {themeMode === 'night' ? 'Night' : 'Day'}
                  </span>
                  {themePref === 'auto' ? ' (auto)' : ''}. Saved on this device.
                </p>
              </section>

              <section className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6 space-y-4">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-900">
                    Profile
                  </h2>
                  <p className="text-sm text-zinc-500 mt-1">
                    Name drives the Home greeting — e.g. “
                    {timeOfDayGreeting()}, {firstNameFrom(userName, 'Joe')}”.
                  </p>
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5">
                    Full name
                  </div>
                  <input
                    value={userName}
                    onChange={(e) => setUserName(e.target.value)}
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-zinc-400 bg-white"
                    placeholder="Joe Roslie"
                  />
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5">
                    Title
                  </div>
                  <input
                    value={userTitle}
                    onChange={(e) => setUserTitle(e.target.value)}
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-zinc-400 bg-white"
                    placeholder="Project Manager"
                  />
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5">
                    Company
                  </div>
                  <input
                    value={userCompany}
                    onChange={(e) => setUserCompany(e.target.value)}
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-zinc-400 bg-white"
                    placeholder="Summit Roofing"
                  />
                  <p className="text-xs text-zinc-400 mt-1.5">
                    Shown on estimates and PDFs as your company brand.
                  </p>
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5">
                    Phone
                  </div>
                  <PhoneInput
                    value={userPhone}
                    onChange={setUserPhone}
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-zinc-400 bg-white"
                    placeholder="(253) 381-2035"
                  />
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5">
                    Email
                  </div>
                  <input
                    value={userEmail}
                    onChange={(e) => setUserEmail(e.target.value)}
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-zinc-400 bg-white"
                    placeholder="joe.roslie@prowest.com"
                    inputMode="email"
                  />
                </div>
                <p className="text-xs text-zinc-400 pt-1">
                  Used on professional estimates and PDF downloads.
                </p>
              </section>

              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <button
                  type="button"
                  onClick={saveUserSettings}
                  className="btn-primary px-6 py-3 rounded-2xl text-sm font-semibold"
                >
                  Save Settings
                </button>
                <p className="text-xs text-zinc-400">
                  Saves profile and appearance on this device.
                </p>
              </div>
            </div>
          </div>
        )}



        {activeTab === 'leads' && (() => {
          const q = leadsSearch.trim().toLowerCase();
          const searchFiltered = q
            ? leads.filter((lead) => {
                const hay = [
                  lead.clientFirstName,
                  lead.clientLastName,
                  lead.clientAddress,
                  lead.clientCity,
                  lead.clientPhone,
                  lead.clientEmail,
                  lead.jobNumber,
                  lead.category,
                  ...(lead.estimates || []).map((e) => `${e.date} ${e.selectedShingle}`),
                  ...(lead.notes || []).map((n) => n.text),
                ]
                  .join(' ')
                  .toLowerCase();
                return hay.includes(q);
              })
            : leads;

          // Shared stage filter (Home cards + kanban headers)
          const visibleLeads = pipelineFilter
            ? searchFiltered.filter(
                (l) => normalizePipelineStage(l.category) === pipelineFilter
              )
            : searchFiltered;

          const stagesToShow = pipelineFilter
            ? ([pipelineFilter] as PipelineStage[])
            : PIPELINE_STAGES;

          const filterCount = pipelineFilter
            ? leads.filter(
                (l) => normalizePipelineStage(l.category) === pipelineFilter
              ).length
            : leads.length;

          return (
          <div className="w-full pb-4">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
              <div>
                <h1 className="text-3xl font-semibold text-zinc-900 tracking-tight">Pipeline</h1>
                <p className="text-zinc-500 mt-0.5">
                  {pipelineFilter ? (
                    <>
                      <span className="font-medium text-zinc-700">{filterCount}</span>
                      {' '}in{' '}
                      <span className="font-medium text-zinc-800">{pipelineFilter}</span>
                      <span className="text-zinc-400">
                        {' '}· {leads.length} total
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="font-medium text-zinc-700">{leads.length}</span> in
                      pipeline
                    </>
                  )}
                  {trash.length > 0 && (
                    <span className="text-zinc-400"> · {trash.length} in trash</span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    if (leadsView === 'trash') {
                      setLeadsView('active');
                    } else {
                      setPipelineFilter(null);
                      setLeadsView('trash');
                    }
                  }}
                  className="px-4 py-2 text-sm text-zinc-500 hover:text-amber-800 hover:bg-amber-50 rounded-xl transition-colors border border-transparent hover:border-amber-100"
                >
                  {leadsView === 'trash' ? 'Back to Board' : `Trash (${trash.length})`}
                </button>
                <button
                  onClick={createNewLead}
                  className="btn-primary px-6 py-3 rounded-3xl font-medium"
                >
                  New Lead
                </button>
              </div>
            </div>

            {/* Stage filter chips — same control from Home or board */}
            {leadsView === 'active' && (
              <div className="flex flex-wrap items-center gap-2 mb-6">
                <button
                  type="button"
                  onClick={() => setPipelineFilter(null)}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                    pipelineFilter == null
                      ? 'bg-zinc-900 text-white'
                      : 'bg-white text-zinc-600 border border-zinc-200 hover:border-sky-300'
                  }`}
                >
                  All stages
                </button>
                {PIPELINE_STAGES.map((stage) => {
                  const count = leads.filter(
                    (l) => normalizePipelineStage(l.category) === stage
                  ).length;
                  const styles = PIPELINE_STAGE_STYLES[stage];
                  const active = pipelineFilter === stage;
                  return (
                    <button
                      key={stage}
                      type="button"
                      onClick={() =>
                        setPipelineFilter((cur) => (cur === stage ? null : stage))
                      }
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all border ${
                        active
                          ? 'bg-zinc-900 text-white border-zinc-900 shadow-sm'
                          : 'bg-white text-zinc-600 border-zinc-200 hover:border-sky-300 hover:shadow-sm'
                      }`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          active ? 'bg-white/80' : styles.dash
                        }`}
                      />
                      {stage}
                      <span className={active ? 'text-white/70' : 'text-zinc-400'}>
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {leadsView === 'trash' ? (
              <div className="space-y-3">
                {trash.length === 0 ? (
                  <div className="text-center py-16 text-slate-500">
                    <p className="font-medium">Trash is empty</p>
                    <p className="text-sm mt-1">
                      Deleted leads and documents will appear here
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="flex justify-end mb-2">
                      <button
                        type="button"
                        onClick={() => {
                          if (
                            confirm(
                              `Permanently delete all ${trash.length} items? This cannot be undone.`
                            )
                          ) {
                            emptyTrash();
                          }
                        }}
                        className="text-sm text-red-600 hover:text-red-700 font-medium"
                      >
                        Empty trash permanently
                      </button>
                    </div>

                    {trash.map((item) => {
                      // Defensive: never let a bad item crash the whole list
                      if (!item || !item.id) return null;

                      let title = 'Unknown item';
                      let subtitle = item.deletedAt || '';

                      try {
                        if (item.kind === 'lead' && item.lead) {
                          title =
                            [
                              item.lead.clientFirstName,
                              item.lead.clientLastName,
                            ]
                              .filter(Boolean)
                              .join(' ') ||
                            item.lead.jobNumber ||
                            `Lead #${item.lead.id}`;
                          subtitle = `Lead · ${item.deletedAt}`;
                        } else if (item.kind === 'photo' && item.photo) {
                          title = item.photo.name || 'Photo';
                          subtitle = `Photo · ${item.leadLabel || 'Lead'} · ${item.deletedAt}`;
                        } else if (
                          item.kind === 'roofMeasurement' &&
                          item.measurement
                        ) {
                          title =
                            item.measurement.label ||
                            'Roof measurement';
                          subtitle = `Map measurement · ${item.leadLabel || 'Lead'} · ${item.deletedAt}`;
                        } else if (item.kind === 'estimate' && item.estimate) {
                          title =
                            item.estimate.selectedShingle ||
                            `Estimate · $${Number(item.estimate.total || 0).toLocaleString()}`;
                          subtitle = `Estimate · ${item.leadLabel || 'Lead'} · ${item.deletedAt}`;
                        } else if (item.kind === 'note' && item.note) {
                          title =
                            (item.note.text || 'Note').slice(0, 80) || 'Note';
                          subtitle = `Note · ${item.leadLabel || 'Lead'} · ${item.deletedAt}`;
                        } else if (
                          (item.kind === 'document' ||
                            item.kind === 'measurement') &&
                          item.document
                        ) {
                          title =
                            item.document.name ||
                            (item.kind === 'measurement'
                              ? 'Measurement'
                              : 'Document');
                          subtitle = `${
                            item.kind === 'measurement'
                              ? 'Measurement'
                              : 'Document'
                          } · ${item.leadLabel || 'Lead'} · ${item.deletedAt}`;
                        } else {
                          title = `Broken ${item.kind || 'item'}`;
                          subtitle = `Corrupted entry · ${item.deletedAt || ''}`;
                        }
                      } catch {
                        title = 'Broken trash item';
                        subtitle = 'Could not read this entry';
                      }

                      return (
                        <div
                          key={item.id}
                          className="flex items-center justify-between gap-3 p-4 bg-white border border-slate-200 rounded-xl"
                        >
                          <div className="min-w-0">
                            <div className="font-medium text-slate-900 truncate">
                              {title}
                            </div>
                            <div className="text-xs text-slate-500 mt-0.5">
                              {subtitle}
                            </div>
                          </div>
                          <div className="flex gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() => restoreFromTrash(item.id)}
                              className="px-3 py-1.5 rounded-xl text-sm font-medium border border-zinc-200 text-zinc-700 hover:bg-zinc-50"
                            >
                              Restore
                            </button>
                            <button
                              type="button"
                              onClick={() => permanentlyDelete(item.id)}
                              className="px-3 py-1.5 rounded-xl text-sm font-medium bg-red-50 text-red-700 border border-red-100 hover:bg-red-100"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            ) : (
              <>
                <div className="mb-6 sm:mb-8">
                  <input
                    type="text"
                    value={leadsSearch}
                    placeholder="Search leads..."
                    className="w-full max-w-md px-5 py-4 text-base border border-zinc-200 rounded-3xl focus:outline-none focus:border-zinc-400 bg-white shadow-sm"
                    onChange={(e) => setLeadsSearch(e.target.value)}
                  />
                </div>

                {leads.length === 0 ? (
                  <div className="text-center py-20 rounded-3xl border border-dashed border-zinc-200 bg-zinc-100/50">
                    <div className="text-zinc-400 mb-4">No leads yet.</div>
                    <button
                      type="button"
                      onClick={createNewLead}
                      className="btn-primary px-5 py-2.5 rounded-2xl text-sm font-medium"
                    >
                      Create first lead
                    </button>
                  </div>
                ) : (
                  <div className="w-full">
                    <div
                      className={`kanban-board ${
                        pipelineFilter ? 'kanban-board--single' : ''
                      }`}
                    >
                      {stagesToShow.map((stage) => {
                        const stageLeads = visibleLeads
                          .filter((l) => normalizePipelineStage(l.category) === stage)
                          .sort((a, b) => b.id - a.id);
                        const isDropTarget = dragOverStage === stage;
                        const styles = PIPELINE_STAGE_STYLES[stage];

                        return (
                          <div
                            key={stage}
                            className={`kanban-col rounded-2xl sm:rounded-3xl border p-2.5 sm:p-3 min-w-0 flex flex-col ${styles.column} ${
                              isDropTarget
                                ? `ring-2 ${styles.ring} ring-offset-2 ring-offset-zinc-100`
                                : ''
                            } ${
                              pipelineFilter === stage
                                ? 'ring-2 ring-zinc-900/15'
                                : ''
                            }`}
                            onDragOver={(e) => {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = 'move';
                              if (dragOverStage !== stage) setDragOverStage(stage);
                            }}
                            onDragLeave={(e) => {
                              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                                setDragOverStage((cur) => (cur === stage ? null : cur));
                              }
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              const idRaw =
                                e.dataTransfer.getData('text/plain') ||
                                (dragLeadId != null ? String(dragLeadId) : '');
                              const leadId = Number(idRaw);
                              setDragLeadId(null);
                              setDragOverStage(null);
                              if (!leadId || Number.isNaN(leadId)) return;
                              const lead = leads.find((l) => l.id === leadId);
                              if (!lead) return;
                              if (normalizePipelineStage(lead.category) === stage) return;
                              moveLeadToStage(leadId, stage);
                            }}
                          >
                            <div className="flex items-center justify-between mb-3 gap-1.5">
                              <button
                                type="button"
                                onClick={() =>
                                  setPipelineFilter((cur) =>
                                    cur === stage ? null : stage
                                  )
                                }
                                className="flex items-center gap-1.5 min-w-0 text-left group"
                                title={
                                  pipelineFilter === stage
                                    ? 'Show all stages'
                                    : `Filter to ${stage}`
                                }
                              >
                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${styles.dash}`} />
                                <div
                                  className={`font-semibold text-xs sm:text-sm truncate ${styles.header} group-hover:underline decoration-slate-300 underline-offset-2`}
                                >
                                  {stage}
                                </div>
                              </button>
                              <div
                                className={`px-2 py-0.5 rounded-full text-[10px] sm:text-xs font-medium border shrink-0 ${styles.pill}`}
                              >
                                {stageLeads.length}
                              </div>
                            </div>

                            {/* Cards scroll inside column — board uses full viewport height */}
                            <div className="space-y-2 min-h-[100px] flex-1 overflow-y-auto overscroll-contain">
                              {stageLeads.map((lead) => (
                                <div
                                  key={lead.id}
                                  draggable
                                  onDragStart={(e) => {
                                    setDragLeadId(lead.id);
                                    e.dataTransfer.setData('text/plain', String(lead.id));
                                    e.dataTransfer.effectAllowed = 'move';
                                  }}
                                  onDragEnd={() => {
                                    // Avoid opening profile when a drag ends on the same card
                                    suppressCardClickRef.current = true;
                                    window.setTimeout(() => {
                                      suppressCardClickRef.current = false;
                                    }, 80);
                                    setDragLeadId(null);
                                    setDragOverStage(null);
                                  }}
                                  className={`bg-white border border-zinc-200 rounded-xl sm:rounded-2xl p-2.5 sm:p-3 shadow-sm hover:shadow-sm cursor-grab active:cursor-grabbing transition-all ${
                                    dragLeadId === lead.id ? 'opacity-50 scale-[0.98]' : ''
                                  }`}
                                  onClick={() => {
                                    if (suppressCardClickRef.current) return;
                                    openLeadProfile(lead.id);
                                  }}
                                >
                                  <div className="font-semibold text-xs sm:text-sm text-zinc-900 min-w-0 truncate">
                                    {[lead.clientFirstName, lead.clientLastName]
                                      .filter(Boolean)
                                      .join(' ') || 'Untitled lead'}
                                  </div>
                                  <div className="text-[10px] sm:text-xs text-zinc-500 mt-0.5 line-clamp-2 break-words">
                                    {lead.clientAddress || 'No address'}
                                  </div>
                                  <div className="mt-2 flex items-center justify-between gap-1">
                                    <span className="text-zinc-400 text-[10px] font-medium tabular-nums">
                                      {lead.estimates?.length || 0} est.
                                    </span>
                                    <button
                                      type="button"
                                      className="text-[10px] font-medium text-zinc-400 hover:text-zinc-600 hover:bg-zinc-50 px-1.5 py-0.5 rounded-md transition-colors"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        moveToTrash(lead.id);
                                      }}
                                    >
                                      Trash
                                    </button>
                                  </div>
                                </div>
                              ))}
                              {stageLeads.length === 0 && (
                                <div className="text-center text-xs text-zinc-400 py-8 border border-dashed border-zinc-300/70 rounded-2xl bg-white/50">
                                  Drop leads here
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
          );
        })()}
        </>
        )}


        {isEditingLead &&
          currentLeadId != null &&
          profileTab === 'estimator' && (
          <div className="page-shell !pt-4 w-full">
            {/* Lead context + Estimate / Internal toggle */}
            <div className="mb-4 rounded-2xl border border-zinc-200 bg-white px-4 py-3 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-zinc-900 truncate">
                    {estimatorClient.fullName !== 'N/A'
                      ? estimatorClient.fullName
                      : 'Lead estimate'}
                  </div>
                  <p className="text-xs text-zinc-500 mt-0.5 truncate">
                    {estimateFlow === 'pick'
                      ? 'Choose roof system'
                      : estimateWorkspace === 'estimate'
                        ? `Customer quote · ${roofSystem}`
                        : 'Internal financials & buffer'}
                    {estimatorClient.jobNumber
                      ? ` · Job #${estimatorClient.jobNumber}`
                      : ''}
                    {estimatorClient.fullAddress !== 'N/A'
                      ? ` · ${estimatorClient.fullAddress}`
                      : ''}
                    {hasUnsavedChanges ? ' · unsaved changes' : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => leaveEstimator({ returnToLead: true })}
                  className="shrink-0 px-4 py-2 rounded-xl text-sm font-semibold border border-zinc-200 text-zinc-800 hover:bg-zinc-100"
                >
                  ← Back to lead
                </button>
              </div>
              {estimateFlow === 'estimate' && (
                <div className="inline-flex p-1 rounded-full bg-zinc-100">
                  <button
                    type="button"
                    onClick={() => setEstimateWorkspace('estimate')}
                    className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-colors ${
                      estimateWorkspace === 'estimate'
                        ? 'bg-white text-zinc-900 shadow-sm'
                        : 'text-zinc-500 hover:text-zinc-800'
                    }`}
                  >
                    Estimate
                  </button>
                  <button
                    type="button"
                    onClick={() => setEstimateWorkspace('internal')}
                    className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-colors ${
                      estimateWorkspace === 'internal'
                        ? 'bg-white text-zinc-900 shadow-sm'
                        : 'text-zinc-500 hover:text-zinc-800'
                    }`}
                  >
                    Internal
                  </button>
                </div>
              )}
            </div>

            {estimateWorkspace === 'internal' && (
              <div className="space-y-6 pb-16 w-full">
                <div className="bg-white rounded-3xl p-6 border border-zinc-200">
                  <div className="font-semibold text-xl mb-6 text-zinc-900">
                    Job financials
                  </div>
                  <div className="mb-6">
                    <div className="text-sm text-zinc-500">Total job value</div>
                    <div className="text-4xl font-semibold tabular-nums text-emerald-700">
                      ${estimatorTotalPrice.toLocaleString()}
                    </div>
                    <p className="text-xs text-zinc-400 mt-1">
                      From the estimate · switch to Estimate to edit scope
                    </p>
                  </div>
                  <div className="space-y-4">
                    <div className="flex justify-between items-center text-zinc-900">
                      <div>Office cost / management fee (10%)</div>
                      <div className="font-semibold text-red-600">
                        -${officeCut.toLocaleString()}
                      </div>
                    </div>
                    <div
                      onClick={() => setShowCostBreakdown(!showCostBreakdown)}
                      className="flex justify-between items-center cursor-pointer hover:bg-zinc-100 p-2 rounded-2xl -mx-2 text-zinc-900"
                    >
                      <div>Labor + material cost</div>
                      <div className="font-semibold">
                        -${(realLabor + realMaterial).toFixed(2)}
                      </div>
                    </div>
                  </div>
                  {showCostBreakdown && (
                    <div className="mt-6 bg-zinc-100 rounded-3xl p-6 text-sm text-zinc-900">
                      <div className="font-semibold mb-4">Cost breakdown</div>
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <span>
                            Base labor (${laborPerSq}/sq ·{' '}
                            {REGION_LABEL[activePricingRegion]})
                          </span>
                          <span>${(sq * laborPerSq).toFixed(2)}</span>
                        </div>
                        {ly > 1 && (
                          <div className="flex justify-between">
                            <span>Additional layers</span>
                            <span>${(sq * 10 * (ly - 1)).toFixed(2)}</span>
                          </div>
                        )}
                        {['8/12', '9/12', '10/12', '11/12', '12/12'].includes(pt) && (
                          <div className="flex justify-between">
                            <span>Steep pitch</span>
                            <span>${(sq * 10).toFixed(2)}</span>
                          </div>
                        )}
                        {isTwoStory && (
                          <div className="flex justify-between">
                            <span>2 story</span>
                            <span>${(sq * 10).toFixed(2)}</span>
                          </div>
                        )}
                        {fasciaBeyondFree > 0 && fasciaType && (
                          <div className="flex justify-between">
                            <span>Fascia + trim</span>
                            <span>${(fasciaBeyondFree * 6).toFixed(2)}</span>
                          </div>
                        )}
                        {ridge > 0 && (
                          <div className="flex justify-between">
                            <span>Ridge vent labor</span>
                            <span>${(ridge * 2).toFixed(2)}</span>
                          </div>
                        )}
                        {deckingMode === 'full' && (
                          <div className="flex justify-between">
                            <span>Decking labor</span>
                            <span>
                              $
                              {(
                                Math.max(0, sheetsNeeded - 2) * 20
                              ).toFixed(2)}
                            </span>
                          </div>
                        )}
                        {deckingMode === 'repair' && dsh > 2 && (
                          <div className="flex justify-between">
                            <span>Decking labor</span>
                            <span>${((dsh - 2) * 20).toFixed(2)}</span>
                          </div>
                        )}
                        {hvacLaborCost > 0 && (
                          <div className="flex justify-between">
                            <span>HVAC labor</span>
                            <span>${hvacLaborCost.toFixed(2)}</span>
                          </div>
                        )}
                        {solarLaborCost > 0 && (
                          <div className="flex justify-between">
                            <span>Solar labor</span>
                            <span>${solarLaborCost.toFixed(2)}</span>
                          </div>
                        )}
                        <div className="pt-3 border-t font-semibold text-zinc-500">
                          Materials
                        </div>
                        {shingleMaterialCost > 0 && (
                          <div className="flex justify-between">
                            <span>Shingles</span>
                            <span>${shingleMaterialCost.toFixed(2)}</span>
                          </div>
                        )}
                        {ridgeMaterial > 0 && (
                          <div className="flex justify-between">
                            <span>Ridge vent material</span>
                            <span>${ridgeMaterial.toFixed(2)}</span>
                          </div>
                        )}
                        {summitIsModBit && mbCapMaterial > 0 && (
                          <div className="flex justify-between">
                            <span>MB SA cap sheet</span>
                            <span>${mbCapMaterial.toFixed(2)}</span>
                          </div>
                        )}
                        {summitIsModBit && mbBasePlyMaterial > 0 && (
                          <div className="flex justify-between">
                            <span>MB base ply</span>
                            <span>${mbBasePlyMaterial.toFixed(2)}</span>
                          </div>
                        )}
                        <div className="pt-3 border-t flex justify-between font-semibold">
                          <span>Total labor + material</span>
                          <span>${(realLabor + realMaterial).toFixed(2)}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="bg-white rounded-3xl p-6 border border-zinc-200">
                  <div className="font-semibold text-xl mb-6 text-zinc-900">
                    Your profit & commission
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="bg-emerald-50/60 border border-emerald-100 rounded-3xl p-6">
                      <div className="text-sm text-zinc-500 mb-1">Gross profit</div>
                      <div className="text-4xl font-semibold text-emerald-700 tabular-nums">
                        ${grossProfit.toFixed(2)}
                      </div>
                      <div className="text-xs text-zinc-500 mt-1">
                        Before your commission
                      </div>
                    </div>
                    <div className="bg-zinc-50 border border-zinc-100 rounded-3xl p-6">
                      <div className="text-sm text-zinc-500 mb-1">
                        Your commission rate
                      </div>
                      <div className="flex items-baseline gap-2">
                        <input
                          type="number"
                          value={commissionRate}
                          onChange={(e) => setCommissionRate(e.target.value)}
                          className="text-4xl font-semibold w-24 text-center border border-zinc-200 rounded-2xl text-zinc-900 bg-white"
                        />
                        <span className="text-2xl font-semibold text-zinc-500">%</span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-8 pt-8 border-t border-zinc-100">
                    <div className="text-sm text-zinc-500">Your commission payout</div>
                    <div className="text-5xl font-semibold text-emerald-700 tabular-nums">
                      ${yourCommission.toLocaleString()}
                    </div>
                  </div>
                </div>

                {/* Negotiation buffer — highlight */}
                <div className="bg-white rounded-3xl p-6 border border-amber-200/80 shadow-sm ring-1 ring-amber-100/80">
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-2">
                    <div className="font-semibold text-xl text-zinc-900">
                      Negotiation buffer
                    </div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-amber-800 bg-amber-50 border border-amber-100 px-2.5 py-1 rounded-full w-fit">
                      ${NEGOTIATION_BUFFER_CAP.toLocaleString()} built-in room
                    </div>
                  </div>
                  <p className="text-sm text-zinc-500 mb-5">
                    Lower the price in the field and see impact on commission — protect
                    your payout while closing the deal.
                  </p>

                  <div className="mb-5">
                    <div className="flex justify-between text-xs font-medium text-zinc-500 mb-1.5">
                      <span>Buffer used</span>
                      <span>
                        ${bufferUsed.toLocaleString()} of $
                        {NEGOTIATION_BUFFER_CAP.toLocaleString()}
                      </span>
                    </div>
                    <div className="h-3 rounded-full bg-zinc-100 overflow-hidden flex">
                      <div
                        className="h-full bg-amber-500 transition-all duration-300"
                        style={{ width: `${bufferUsedPct}%` }}
                      />
                      <div
                        className="h-full bg-emerald-500/80 transition-all duration-300"
                        style={{ width: `${100 - bufferUsedPct}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-[11px] mt-1.5">
                      <span className="text-amber-700 font-medium">
                        Used ${bufferUsed.toLocaleString()}
                      </span>
                      <span className="text-emerald-700 font-medium">
                        Left ${bufferRemaining.toLocaleString()}
                      </span>
                    </div>
                  </div>

                  <div className="mb-4">
                    <div className="text-sm text-zinc-500 mb-1">
                      Negotiated / final price
                    </div>
                    <input
                      type="number"
                      value={negotiatedPrice}
                      onChange={(e) => setNegotiatedPrice(Number(e.target.value))}
                      className="text-4xl font-semibold w-full border border-zinc-200 rounded-2xl px-4 py-3 text-zinc-900 focus:outline-none focus:border-amber-300 focus:ring-2 focus:ring-amber-100"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={applyNegotiatedPrice}
                    className="btn-primary w-full py-4 rounded-3xl font-semibold mb-6"
                  >
                    Apply negotiated price
                  </button>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="rounded-2xl bg-amber-50 border border-amber-100 p-4">
                      <div className="text-xs font-medium text-amber-800/80 uppercase tracking-wide">
                        Buffer used
                      </div>
                      <div className="text-3xl font-semibold text-amber-700 tabular-nums mt-1">
                        ${bufferUsed.toLocaleString()}
                      </div>
                    </div>
                    <div className="rounded-2xl bg-emerald-50 border border-emerald-100 p-4">
                      <div className="text-xs font-medium text-emerald-800/80 uppercase tracking-wide">
                        Remaining
                      </div>
                      <div className="text-3xl font-semibold text-emerald-700 tabular-nums mt-1">
                        ${bufferRemaining.toLocaleString()}
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-zinc-500 mt-5">
                    Commission above uses the negotiated price so you always see the real
                    payout after discounting.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setEstimateWorkspace('estimate')}
                  className="w-full py-3 rounded-2xl text-sm font-semibold border border-zinc-200 text-zinc-800 hover:bg-zinc-50"
                >
                  ← Back to estimate
                </button>
              </div>
            )}

            {estimateWorkspace === 'estimate' && estimateFlow === 'pick' && (
              <div className="pb-16 w-full">
                <div className="mb-6">
                  <h2 className="text-2xl font-semibold text-zinc-900 tracking-tight">
                    New estimate
                  </h2>
                  <p className="text-sm text-zinc-500 mt-1">
                    Choose the roof system for this job. You can change it later.
                  </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {(
                    [
                      {
                        id: 'shingle' as const,
                        label: 'Shingle',
                        desc: 'IKO, GAF, Owens — architectural shingles',
                      },
                      {
                        id: 'tile' as const,
                        label: 'Tile',
                        desc: 'Detach & Reset / R&R systems',
                      },
                      {
                        id: 'flat' as const,
                        label: 'Low Slope',
                        desc: 'Mod bit, BUR, coatings, foam — low slope systems',
                      },
                    ] as const
                  ).map((sys) => (
                    <button
                      key={sys.id}
                      type="button"
                      onClick={() => selectRoofSystem(sys.id)}
                      className="text-left bg-white border-2 border-zinc-200 hover:border-sky-300 hover:shadow-md rounded-3xl p-6 sm:p-8 transition-all group"
                    >
                      <div className="text-sky-700 text-xs font-semibold mb-2 uppercase tracking-wide group-hover:text-sky-800">
                        Roof system
                      </div>
                      <div className="text-2xl font-semibold text-zinc-900 mb-2">
                        {sys.label}
                      </div>
                      <p className="text-sm text-zinc-500">{sys.desc}</p>
                      <div className="mt-5 text-sm font-semibold text-sky-700">
                        Continue →
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {estimateWorkspace === 'estimate' && estimateFlow === 'estimate' && (
            <>
            {/* Optional measurement helpers — never required */}
            <div className="mb-6 rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-zinc-900">
                    Roof measurement (optional)
                  </div>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Auto-fill pitched squares, flat squares, pitch & waste from a measurement.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {currentLeadId &&
                    (leads.find((l) => l.id === currentLeadId)?.measurements?.length || 0) >
                      0 && (
                      <button
                        type="button"
                        onClick={() => {
                          const lead = leads.find((l) => l.id === currentLeadId);
                          const list = lead?.measurements || [];
                          const m = list[list.length - 1];
                          if (lead && m) {
                            setEstimatorSourceLeadId(lead.id);
                            applyMeasurementToEstimator(m, lead);
                            const p = Number(m.squares) || 0;
                            const f = Number(m.flatSquares) || 0;
                            showToast(
                              f > 0 && p > 0
                                ? `Applied · ${p} pitched + ${f} flat sq`
                                : f > 0
                                  ? `Applied · ${f} flat squares`
                                  : `Applied · ${p} pitched squares`
                            );
                          }
                        }}
                        className="btn-primary px-4 py-2 rounded-xl text-sm font-semibold"
                      >
                        Apply latest measurement
                      </button>
                    )}
                  <button
                    type="button"
                    onClick={() => {
                      if (currentLeadId) openMeasureRoof(currentLeadId);
                      else openHomeMeasurements();
                    }}
                    className="px-4 py-2 rounded-xl text-sm font-medium border border-zinc-200 text-zinc-700 hover:bg-zinc-100"
                  >
                    Measure by address
                  </button>
                </div>
              </div>
            </div>

            {/* Client/job — read-only from lead (edit on lead Overview) */}
            <div className="mb-8">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
                <div className="text-sm font-semibold text-zinc-600">
                  CLIENT / JOB INFO
                  <span className="ml-2 font-normal text-zinc-400">
                    from lead · not editable here
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (leaveEstimator({ returnToLead: true }) !== false) {
                      setProfileTab('overview');
                    }
                  }}
                  className="text-sm font-medium text-sky-800 hover:text-sky-950 self-start sm:self-auto"
                >
                  Edit on lead profile →
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <div className="bg-zinc-50 rounded-3xl p-4 border border-zinc-200/80 sm:col-span-2 lg:col-span-1">
                  <div className="text-[10px] uppercase tracking-wide text-zinc-400 mb-1">
                    Client
                  </div>
                  <div className="text-base font-semibold text-zinc-900 truncate">
                    {estimatorClient.fullName !== 'N/A'
                      ? estimatorClient.fullName
                      : '—'}
                  </div>
                </div>
                <div className="bg-zinc-50 rounded-3xl p-4 border border-zinc-200/80">
                  <div className="text-[10px] uppercase tracking-wide text-zinc-400 mb-1">
                    Phone
                  </div>
                  <div className="text-base font-medium text-zinc-900 truncate">
                    {estimatorClient.phone || '—'}
                  </div>
                </div>
                <div className="bg-zinc-50 rounded-3xl p-4 border border-zinc-200/80">
                  <div className="text-[10px] uppercase tracking-wide text-zinc-400 mb-1">
                    Email
                  </div>
                  <div className="text-base font-medium text-zinc-900 truncate">
                    {estimatorClient.email || '—'}
                  </div>
                </div>
                <div className="bg-zinc-50 rounded-3xl p-4 border border-zinc-200/80">
                  <div className="text-[10px] uppercase tracking-wide text-zinc-400 mb-1">
                    Job #
                  </div>
                  <div className="text-base font-medium text-zinc-900 truncate">
                    {estimatorClient.jobNumber || '—'}
                  </div>
                </div>
                <div className="bg-zinc-50 rounded-3xl p-4 border border-zinc-200/80 sm:col-span-2">
                  <div className="text-[10px] uppercase tracking-wide text-zinc-400 mb-1">
                    Property address
                  </div>
                  <div className="text-base font-medium text-zinc-900">
                    {estimatorClient.fullAddress !== 'N/A'
                      ? estimatorClient.fullAddress
                      : '—'}
                  </div>
                </div>
              </div>
            </div>

            <div className="mb-8">
              <div className="text-sm font-semibold text-zinc-600 mb-4">ROOF DETAILS</div>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                <div className="bg-white rounded-3xl p-5 border border-zinc-200">
                  <div className="text-xs text-zinc-500 mb-1">PITCHED SQUARES</div>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={squares}
                    onChange={(e) => setSquares(e.target.value)}
                    placeholder="0"
                    className="text-3xl font-semibold w-full bg-transparent border-0 focus:outline-none p-0 text-zinc-900"
                  />
                </div>
                <div className="bg-white rounded-3xl p-5 border border-zinc-200">
                  <div className="text-xs text-zinc-500 mb-1">LAYERS</div>
                  <select value={layers} onChange={(e) => setLayers(e.target.value)} className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900">
                    <option value="">Select...</option>
                    <option value="1">1 Layer</option>
                    <option value="2">2 Layers</option>
                    <option value="3">3 Layers</option>
                    <option value="4">4 Layers</option>
                  </select>
                </div>
                <div className="bg-white rounded-3xl p-5 border border-zinc-200">
                  <div className="text-xs text-zinc-500 mb-1">PITCH</div>
                  <select value={pitch} onChange={(e) => setPitch(e.target.value)} className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900">
                    <option value="">Select...</option>
                    <option>Flat</option><option>2/12</option><option>3/12</option><option>4/12</option><option>5/12</option><option>6/12</option><option>7/12</option><option>8/12</option><option>9/12</option><option>10/12</option><option>11/12</option><option>12/12</option>
                  </select>
                </div>
                <div className="bg-white rounded-3xl p-5 border border-zinc-200">
                  <div className="text-xs text-zinc-500 mb-1">STORIES</div>
                  <select value={stories} onChange={(e) => setStories(e.target.value as '1' | '2' | '')} className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900">
                    <option value="">Select...</option>
                    <option value="1">1 Story</option>
                    <option value="2">2 Story</option>
                  </select>
                </div>
                <div className="bg-white rounded-3xl p-5 border border-zinc-200">
                  <div className="text-xs text-zinc-500 mb-1">WASTE FACTOR</div>
                  <select value={waste} onChange={(e) => setWaste(e.target.value)} className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900">
                    <option value="">0% (None)</option>
                    <option value="0.05">5%</option><option value="0.06">6%</option><option value="0.07">7%</option><option value="0.08">8%</option><option value="0.09">9%</option><option value="0.10">10%</option><option value="0.11">11%</option><option value="0.12">12%</option><option value="0.13">13%</option><option value="0.14">14%</option><option value="0.15">15%</option>
                  </select>
                </div>
                <div className="bg-white rounded-3xl p-5 border border-zinc-200">
                  <div className="text-xs text-zinc-500 mb-1">DRIP EDGE COLOR</div>
                  <select value={dripEdgeColor} onChange={(e) => setDripEdgeColor(e.target.value)} className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900">
                    <option value="">Select...</option>
                    <option>Mill Finish</option><option>Black</option><option>White</option><option>Brown</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="mb-8">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
                <div>
                  <div className="text-sm font-semibold text-zinc-600">
                    {roofSystem === 'shingle'
                      ? 'CHOOSE YOUR SHINGLE'
                      : roofSystem === 'tile'
                        ? 'CHOOSE YOUR TILE SYSTEM'
                        : 'CHOOSE YOUR LOW SLOPE SYSTEM'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setEstimateFlow('pick');
                    setEstimateWorkspace('estimate');
                  }}
                  className="text-sm font-medium text-sky-800 hover:text-sky-950 self-start sm:self-auto"
                >
                  ← Change system
                </button>
              </div>

              {roofSystem === 'shingle' && (
                <div className="bg-white rounded-3xl p-5 border border-zinc-200 space-y-4">
                  {/* Product */}
                  <div className="space-y-2">
                    <div className="text-xs text-zinc-500">PRODUCT</div>
                    <select
                      value={selectedShingle}
                      onChange={(e) => {
                        const val = e.target.value as ShingleType;
                        selectShingleProduct(val);
                        // Clear color when product changes
                        setCambridgeColor('');
                        setDynastyColor('');
                        setArmourshakeColor('');
                        if (val) {
                          setProductColors((prev) => ({ ...prev, [val]: '' }));
                        }
                        setHasUnsavedChanges(true);
                      }}
                      className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900 bg-white"
                    >
                      <option value="">Select product…</option>
                      {SHINGLE_PRODUCTS.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.label}
                        </option>
                      ))}
                    </select>

                    {/* Description for selected product */}
                    {selectedShingle && (
                      <p className="text-sm text-zinc-500 leading-relaxed">
                        {
                          SHINGLE_PRODUCTS.find((p) => p.key === selectedShingle)
                            ?.description
                        }
                      </p>
                    )}
                  </div>

                  {/* Color dropdown — only when a product is selected */}
                  {selectedShingle &&
                    SHINGLE_PRODUCTS.some((p) => p.key === selectedShingle) && (
                      <div className="space-y-2">
                        <div className="text-xs text-zinc-500">COLOR</div>
                        <select
                          value={
                            selectedShingle === 'cambridge'
                              ? cambridgeColor
                              : selectedShingle === 'dynasty'
                                ? dynastyColor
                                : selectedShingle === 'armourshake'
                                  ? armourshakeColor
                                  : productColors[selectedShingle] || ''
                          }
                          onChange={(e) => {
                            setProductColor(selectedShingle, e.target.value);
                            setHasUnsavedChanges(true);
                          }}
                          className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900 bg-white"
                        >
                          <option value="">Select color…</option>
                          {(
                            SHINGLE_PRODUCTS.find((p) => p.key === selectedShingle)
                              ?.colors || []
                          ).map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                </div>
              )}

              {roofSystem === 'tile' && (
                <div className="bg-white rounded-3xl p-5 border border-zinc-200 space-y-4">
                  <div>
                    <div className="text-xs text-zinc-500 mb-2">TILE SCOPE</div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setTileMode('dr');
                          selectShingleProduct('tile_dr');
                          setTileProduct('');
                          setHasUnsavedChanges(true);
                        }}
                        className={`flex-1 py-2.5 rounded-2xl text-sm font-medium border transition-all ${
                          tileMode === 'dr' || selectedShingle === 'tile_dr'
                            ? 'border-sky-400/60 bg-sky-50 text-sky-900'
                            : 'border-zinc-300 text-zinc-700'
                        }`}
                      >
                        Detach &amp; Reset
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setTileMode('rr');
                          selectShingleProduct('tile_rr');
                          setCurrentTile('');
                          setHasUnsavedChanges(true);
                        }}
                        className={`flex-1 py-2.5 rounded-2xl text-sm font-medium border transition-all ${
                          tileMode === 'rr' || selectedShingle === 'tile_rr'
                            ? 'border-sky-400/60 bg-sky-50 text-sky-900'
                            : 'border-zinc-300 text-zinc-700'
                        }`}
                      >
                        Remove &amp; Replace
                      </button>
                    </div>
                  </div>

                  {(tileMode === 'rr' || selectedShingle === 'tile_rr') && (
                    <div className="space-y-2">
                      <div className="text-xs text-zinc-500">NEW TILE PRODUCT</div>
                      <select
                        value={tileProduct}
                        onChange={(e) => {
                          setTileProduct(e.target.value);
                          setTileBrand('');
                          setHasUnsavedChanges(true);
                        }}
                        className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900 bg-white"
                      >
                        <option value="">Select tile…</option>
                        {TILE_PRODUCTS.map((p) => (
                          <option key={p.key} value={p.key}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                      {tileProduct && (
                        <p className="text-sm text-zinc-500 leading-relaxed">
                          {
                            TILE_PRODUCTS.find((p) => p.key === tileProduct)
                              ?.description
                          }
                        </p>
                      )}
                      {tileProduct && (
                        <div className="mt-3 space-y-2">
                          <div className="text-xs text-zinc-500">BRAND</div>
                          <select
                            value={tileBrand}
                            onChange={(e) => {
                              setTileBrand(e.target.value);
                              setHasUnsavedChanges(true);
                            }}
                            className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900 bg-white"
                          >
                            <option value="">Select brand…</option>
                            {(TILE_BRANDS[tileProduct] || []).map((b) => (
                              <option key={b.key} value={b.key}>
                                {b.label}
                              </option>
                            ))}
                          </select>
                          {(TILE_BRANDS[tileProduct] || []).length === 0 && (
                            <p className="text-xs text-zinc-400">
                              No brands loaded yet
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {(tileMode === 'dr' || selectedShingle === 'tile_dr') && (
                    <div className="space-y-2">
                      <div className="text-xs text-zinc-500">CURRENT TILE ON ROOF</div>
                      <input
                        type="text"
                        value={currentTile}
                        onChange={(e) => {
                          setCurrentTile(e.target.value);
                          setHasUnsavedChanges(true);
                        }}
                        placeholder="e.g. Concrete S-tile, clay mission…"
                        className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900 bg-white"
                      />
                    </div>
                  )}
                </div>
              )}

              {roofSystem === 'flat' && (
                <div className="space-y-4">
                  <div className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6">
                    <div className="text-xs font-semibold tracking-wide text-zinc-500 mb-3">
                      SYSTEM
                    </div>
                    <select
                      value={
                        flatSystem === 'mod_bit'
                          ? 'mod_bitumen'
                          : flatSystem === 'bur'
                            ? 'bur'
                            : flatSystem === 'foam'
                              ? foamKind === 'overlay'
                                ? 'foam_overlay'
                                : foamKind === 'full'
                                  ? 'full_foam'
                                  : ''
                              : flatSystem === 'coating'
                                ? 'coating'
                                : ''
                      }
                      onChange={(e) => {
                        const val = e.target.value;
                        setModifiedBitumenColor('');
                        if (!val) {
                          applyFlatSelection('');
                        } else if (val === 'mod_bitumen') {
                          applyFlatSelection('mod_bit');
                        } else if (val === 'bur') {
                          applyFlatSelection('bur');
                        } else if (val === 'full_foam') {
                          applyFlatSelection('foam', '', 'full');
                        } else if (val === 'foam_overlay') {
                          applyFlatSelection('foam', '', 'overlay');
                        } else if (val === 'coating') {
                          applyFlatSelection(
                            'coating',
                            coatingKind || 'elastomeric'
                          );
                        }
                      }}
                      className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900 bg-white outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20"
                    >
                      <option value="">Select system…</option>
                      {LOW_SLOPE_TYPES.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                    {(flatSystem === 'mod_bit' ||
                      flatSystem === 'bur' ||
                      flatSystem === 'foam' ||
                      flatSystem === 'coating') && (
                      <p className="text-sm text-zinc-500 mt-3 leading-relaxed">
                        {
                          LOW_SLOPE_TYPES.find((p) => {
                            if (flatSystem === 'mod_bit')
                              return p.key === 'mod_bitumen';
                            if (flatSystem === 'bur') return p.key === 'bur';
                            if (flatSystem === 'foam')
                              return (
                                p.key ===
                                (foamKind === 'overlay'
                                  ? 'foam_overlay'
                                  : 'full_foam')
                              );
                            if (flatSystem === 'coating')
                              return p.key === 'coating';
                            return false;
                          })?.description
                        }
                      </p>
                    )}

                    {/* Cap color — mod bitumen */}
                    {flatSystem === 'mod_bit' && (
                      <div className="mt-4">
                        <div className="text-xs font-semibold tracking-wide text-zinc-500 mb-3">
                          CAP COLOR
                        </div>
                        <select
                          value={modifiedBitumenColor}
                          onChange={(e) => {
                            setModifiedBitumenColor(e.target.value);
                            setHasUnsavedChanges(true);
                          }}
                          className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900 bg-white outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20"
                        >
                          <option value="">Select color…</option>
                          {MOD_BITUMEN_CAP_COLORS.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* Coating type */}
                    {flatSystem === 'coating' && (
                      <div className="mt-4">
                        <div className="text-xs font-semibold tracking-wide text-zinc-500 mb-3">
                          COATING TYPE
                        </div>
                        <select
                          value={coatingKind}
                          onChange={(e) => {
                            applyFlatSelection(
                              'coating',
                              e.target.value as CoatingKind
                            );
                          }}
                          className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900 bg-white outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20"
                        >
                          <option value="">Select coating…</option>
                          {COATING_TYPES.map((p) => (
                            <option key={p.key} value={p.key}>
                              {p.label}
                            </option>
                          ))}
                        </select>
                        {coatingKind && (
                          <p className="text-sm text-zinc-500 mt-3 leading-relaxed">
                            {
                              COATING_TYPES.find((p) => p.key === coatingKind)
                                ?.description
                            }
                          </p>
                        )}
                      </div>
                    )}

                    {/* Foam top coating (optional finish) */}
                    {flatSystem === 'foam' && foamKind && (
                      <div className="mt-4">
                        <div className="text-xs font-semibold tracking-wide text-zinc-500 mb-3">
                          TOP COATING
                        </div>
                        <select
                          value={coatingKind}
                          onChange={(e) => {
                            setCoatingKind(e.target.value as CoatingKind);
                            setHasUnsavedChanges(true);
                          }}
                          className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900 bg-white outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20"
                        >
                          <option value="">Select top coating…</option>
                          {COATING_TYPES.map((p) => (
                            <option key={p.key} value={p.key}>
                              {p.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>

                  {/* Foam ISO + adders (detail inputs after system pick) */}
                  {flatSystem === 'foam' && foamKind && (
                    <div className="bg-white border border-zinc-200 rounded-3xl p-5 space-y-4">
                      <div>
                        <div className="text-xs font-semibold tracking-wide text-zinc-500 mb-3">
                          ISO BOARD
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <div className="text-xs text-zinc-500 mb-1">4×8 sheets</div>
                            <input
                              type="number"
                              min={0}
                              step={1}
                              value={foamIso48}
                              onChange={(e) => {
                                setFoamIso48(e.target.value);
                                setHasUnsavedChanges(true);
                              }}
                              placeholder="0"
                              className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900"
                            />
                          </div>
                          <div>
                            <div className="text-xs text-zinc-500 mb-1">4×4 sheets</div>
                            <input
                              type="number"
                              min={0}
                              step={1}
                              value={foamIso44}
                              onChange={(e) => {
                                setFoamIso44(e.target.value);
                                setHasUnsavedChanges(true);
                              }}
                              placeholder="0"
                              className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900"
                            />
                          </div>
                        </div>
                      </div>
                      <div>
                        <div className="text-xs font-semibold tracking-wide text-zinc-500 mb-2">
                          FOAM ADDERS
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {(
                            [
                              {
                                key: 'granules' as const,
                                label: 'Granules',
                                on: foamGranules,
                                set: setFoamGranules,
                              },
                              {
                                key: 'spf' as const,
                                label: 'Extra inch SPF',
                                on: foamExtraSpf,
                                set: setFoamExtraSpf,
                              },
                              {
                                key: 'scarify' as const,
                                label: 'Scarify',
                                on: foamScarify,
                                set: setFoamScarify,
                              },
                            ]
                          ).map((a) => (
                            <button
                              key={a.key}
                              type="button"
                              onClick={() => {
                                a.set(!a.on);
                                setHasUnsavedChanges(true);
                              }}
                              className={`rounded-2xl border px-3 py-3 text-sm font-semibold transition ${
                                a.on
                                  ? 'border-sky-400 bg-sky-50 text-sky-900'
                                  : 'border-zinc-200 bg-white text-zinc-700 hover:border-sky-300'
                              }`}
                            >
                              {a.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Coating adders:
                      Additional coat → coating, foam overlay, BUR, full foam
                      Pressure wash → coating + foam overlay only */}
                  {(flatSystem === 'coating' ||
                    flatSystem === 'bur' ||
                    flatSystem === 'foam') && (
                    <div className="mb-2">
                      <div className="text-sm font-semibold text-zinc-600 mb-4">
                        COATING ADDERS
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="bg-white border border-zinc-200 rounded-3xl p-5">
                          <div className="font-semibold mb-2 text-zinc-900">
                            Additional coat
                          </div>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setCoatingExtraPass(true);
                                setHasUnsavedChanges(true);
                              }}
                              className={`flex-1 py-2.5 rounded-2xl text-sm font-medium border transition-all ${
                                coatingExtraPass
                                  ? 'border-sky-400/60 bg-sky-50 text-sky-900'
                                  : 'border-zinc-300'
                              }`}
                            >
                              Yes
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setCoatingExtraPass(false);
                                setHasUnsavedChanges(true);
                              }}
                              className={`flex-1 py-2.5 rounded-2xl text-sm font-medium border transition-all ${
                                !coatingExtraPass
                                  ? 'border-sky-400/60 bg-sky-50 text-sky-900'
                                  : 'border-zinc-300'
                              }`}
                            >
                              No
                            </button>
                          </div>
                        </div>
                        {(flatSystem === 'coating' ||
                          (flatSystem === 'foam' && foamKind === 'overlay')) && (
                          <div className="bg-white border border-zinc-200 rounded-3xl p-5">
                            <div className="font-semibold mb-2 text-zinc-900">
                              Pressure wash &amp; clean
                            </div>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setCoatingPressureWash(true);
                                  setHasUnsavedChanges(true);
                                }}
                                className={`flex-1 py-2.5 rounded-2xl text-sm font-medium border transition-all ${
                                  coatingPressureWash
                                    ? 'border-sky-400/60 bg-sky-50 text-sky-900'
                                    : 'border-zinc-300'
                                }`}
                              >
                                Yes
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setCoatingPressureWash(false);
                                  setHasUnsavedChanges(true);
                                }}
                                className={`flex-1 py-2.5 rounded-2xl text-sm font-medium border transition-all ${
                                  !coatingPressureWash
                                    ? 'border-sky-400/60 bg-sky-50 text-sky-900'
                                    : 'border-zinc-300'
                                }`}
                              >
                                No
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Low slope adder — for shingle & tile (flat systems pick type as main product) */}
            {roofSystem !== 'flat' && (
              <div className="mb-8">
                <div className="text-sm font-semibold text-zinc-600 mb-3">
                  LOW SLOPE ROOF
                </div>
                <p className="text-xs text-zinc-500 mb-3">
                  Optional attached or detached low-slope area on this job.
                </p>
                <div className="grid grid-cols-3 gap-3 mb-4">
                  {(
                    [
                      { id: 'none' as const, label: 'None' },
                      { id: 'attached' as const, label: 'Attached' },
                      { id: 'detached' as const, label: 'Detached' },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        setLowSlopeMode(opt.id);
                        if (opt.id === 'none') {
                          setLowSlopeType('none');
                          setModifiedBitumenSquares('');
                        }
                        setHasUnsavedChanges(true);
                      }}
                      className={`rounded-2xl border px-3 py-3 text-sm font-semibold transition ${
                        lowSlopeMode === opt.id
                          ? 'border-sky-500 bg-sky-50 text-sky-800'
                          : 'border-zinc-200 bg-white text-zinc-700 hover:border-sky-300'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                {lowSlopeMode !== 'none' && (
                  <div className="bg-white rounded-3xl p-5 sm:p-6 border border-zinc-200 space-y-4">
                    <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                      Low slope type ({lowSlopeMode})
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {(
                        [
                          {
                            id: 'mod_bitumen' as const,
                            label: 'Modified Bitumen',
                          },
                          { id: 'full_foam' as const, label: 'Foam' },
                          { id: 'elastomeric' as const, label: 'Elastomeric' },
                          { id: 'silicone' as const, label: 'Silicone' },
                          { id: 'urethane' as const, label: 'Urethane' },
                        ] as const
                      ).map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => {
                            setLowSlopeType(t.id);
                            setHasUnsavedChanges(true);
                          }}
                          className={`rounded-2xl border px-4 py-3 text-sm font-semibold transition text-left ${
                            lowSlopeType === t.id
                              ? 'border-sky-400 bg-sky-50 text-sky-900'
                              : 'border-zinc-200 bg-zinc-50 text-zinc-700 hover:border-sky-300'
                          }`}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <div className="text-xs text-zinc-500 mb-1">LOW SLOPE SQUARES</div>
                        <input
                          type="number"
                          min={0}
                          step={0.1}
                          value={modifiedBitumenSquares}
                          onChange={(e) => {
                            setModifiedBitumenSquares(e.target.value);
                            setHasUnsavedChanges(true);
                          }}
                          placeholder="0"
                          className="w-full text-2xl font-semibold border border-zinc-200 rounded-2xl px-4 py-3 text-zinc-900 focus:outline-none focus:border-zinc-400"
                        />
                      </div>
                      {lowSlopeType === 'mod_bitumen' && (
                        <div>
                          <div className="text-xs text-zinc-500 mb-1">COLOR</div>
                          <select
                            value={modifiedBitumenColor}
                            onChange={(e) => {
                              setModifiedBitumenColor(e.target.value);
                              setHasUnsavedChanges(true);
                            }}
                            className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900"
                          >
                            <option value="">Select color…</option>
                            {MOD_BITUMEN_CAP_COLORS.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="mb-8">
              <div className="text-sm font-semibold text-zinc-600 mb-4">UNDERLAYMENT</div>
              <div className="bg-white border border-zinc-200 rounded-3xl p-5 mb-4">
                <select
                  value={selectedUnderlayment}
                  onChange={(e) => {
                    setSelectedUnderlayment(e.target.value as Underlayment);
                    setHasUnsavedChanges(true);
                  }}
                  className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900 bg-white"
                >
                  <option value="">Select underlayment…</option>
                  <option value="standard">Standard Synthetic</option>
                  <option value="high-temp">High-Temp Synthetic</option>
                  <option value="sa-high-temp">Self-Adhered High-Temp</option>
                </select>
                {selectedUnderlayment === 'standard' && (
                  <p className="text-sm text-zinc-500 leading-relaxed mt-2">
                    Standard synthetic underlayment for typical shingle applications.
                  </p>
                )}
                {selectedUnderlayment === 'high-temp' && (
                  <p className="text-sm text-zinc-500 leading-relaxed mt-2">
                    High-temperature rated synthetic underlayment for hotter roof decks and
                    valleys.
                  </p>
                )}
                {selectedUnderlayment === 'sa-high-temp' && (
                  <p className="text-sm text-zinc-500 leading-relaxed mt-2">
                    Self-adhered high-temp underlayment. Excellent for valleys, eaves, and
                    critical areas.
                  </p>
                )}
              </div>

            </div>

            <div className="mb-8">
              <div className="text-sm font-semibold text-zinc-600 mb-4">ADDERS</div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                {/* Fascia */}
                <div className="bg-white border border-zinc-200 rounded-3xl p-6">
                  <div className="mb-3">
                    <div className="font-semibold text-zinc-900">Fascia</div>
                    <div className="text-xs text-amber-700/80 mt-0.5">
                      10 LF fascia + mold included
                    </div>
                  </div>
                  <div className="flex gap-2 mb-3">
                    <button
                      type="button"
                      onClick={() => toggleFascia('repair')}
                      className={`flex-1 py-2 rounded-2xl text-sm font-medium border transition-all ${
                        fasciaMode === 'repair'
                          ? 'border-sky-400/60 bg-sky-50 text-sky-900'
                          : 'border-zinc-300'
                      }`}
                    >
                      Repair
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleFascia('full')}
                      className={`flex-1 py-2 rounded-2xl text-sm font-medium border transition-all ${
                        fasciaMode === 'full'
                          ? 'border-sky-400/60 bg-sky-50 text-sky-900'
                          : 'border-zinc-300'
                      }`}
                    >
                      Full Replacement
                    </button>
                  </div>
                  <select
                    value={fasciaType}
                    onChange={(e) => {
                      setFasciaType(e.target.value as FasciaType);
                      setHasUnsavedChanges(true);
                    }}
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900 mb-3"
                  >
                    <option value="">Select Fascia Type...</option>
                    <option value="2x6">2x6 Prime Combed</option>
                    <option value="2x8">2x8 Prime Combed</option>
                  </select>
                  <input
                    type="number"
                    min={0}
                    value={fasciaLF}
                    onChange={(e) => {
                      setFasciaLF(e.target.value);
                      setHasUnsavedChanges(true);
                    }}
                    placeholder="Linear Feet (after 10 free)"
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900"
                  />
                  {parseFloat(fasciaLF || '0') > 10 &&
                    (fasciaMode || fasciaType) && (
                      <div className="mt-3 text-sm flex justify-between items-center">
                        <div className="text-amber-700">Cost</div>
                        <div className="font-semibold text-emerald-700">
                          + ${Number(fasciaCost || 0).toLocaleString()}
                        </div>
                      </div>
                    )}
                </div>

                {/* Decking */}
                <div className="bg-white border border-zinc-200 rounded-3xl p-6">
                  <div className="mb-3">
                    <div className="font-semibold text-zinc-900">Decking</div>
                    <div className="text-xs text-amber-700/80 mt-0.5">
                      2 sheets included at no cost
                    </div>
                  </div>
                  <div className="flex gap-2 mb-4">
                    <button
                      type="button"
                      onClick={() => toggleDecking('repair')}
                      className={`flex-1 py-2 rounded-2xl text-sm font-medium border transition-all ${
                        deckingMode === 'repair'
                          ? 'border-sky-400/60 bg-sky-50 text-sky-900'
                          : 'border-zinc-300'
                      }`}
                    >
                      Repair
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleDecking('full')}
                      className={`flex-1 py-2 rounded-2xl text-sm font-medium border transition-all ${
                        deckingMode === 'full'
                          ? 'border-sky-400/60 bg-sky-50 text-sky-900'
                          : 'border-zinc-300'
                      }`}
                    >
                      Full Re-Deck
                    </button>
                  </div>
                  {deckingMode === 'full' ? (
                    <div>
                      <div className="flex justify-between items-center mb-1">
                        <div className="text-sm text-zinc-500">Estimated sheets</div>
                        <div className="text-sm font-semibold text-zinc-900">
                          {sheetsNeeded}
                        </div>
                      </div>
                      <div className="flex justify-between items-center mt-2">
                        <div className="text-sm text-amber-700">Cost</div>
                        <div className="text-sm font-semibold text-emerald-700">
                          + ${Number(deckingCost || 0).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  ) : deckingMode === 'repair' ? (
                    <div className="space-y-2">
                      <input
                        type="number"
                        min={0}
                        value={deckingOsbSheets}
                        onChange={(e) => {
                          setDeckingOsbSheets(e.target.value);
                          setHasUnsavedChanges(true);
                        }}
                        placeholder="OSB sheets"
                        className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900"
                      />
                      <input
                        type="number"
                        min={0}
                        value={deckingCdxSheets}
                        onChange={(e) => {
                          setDeckingCdxSheets(e.target.value);
                          setHasUnsavedChanges(true);
                        }}
                        placeholder="CDX sheets"
                        className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900"
                      />
                      {(parseFloat(deckingOsbSheets || '0') > 0 ||
                        parseFloat(deckingCdxSheets || '0') > 0) && (
                        <div className="flex justify-between items-center text-sm">
                          <div className="text-amber-700">Cost</div>
                          <div className="font-semibold text-emerald-700">
                            + ${Number(deckingCost || 0).toLocaleString()}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>

                {/* Gutters */}
                <div className="bg-white border border-zinc-200 rounded-3xl p-6">
                  <div className="mb-3">
                    <div className="font-semibold text-zinc-900">Gutters</div>
                    <div className="text-xs text-amber-700/80 mt-0.5">
                      Detach &amp; reset or remove &amp; replace
                    </div>
                  </div>
                  <div className="flex gap-2 mb-3">
                    <button
                      type="button"
                      onClick={() => {
                        setGutterMode(gutterMode === 'dr' ? 'none' : 'dr');
                        setHasUnsavedChanges(true);
                      }}
                      className={`flex-1 py-2 rounded-2xl text-sm font-medium border transition-all ${
                        gutterMode === 'dr'
                          ? 'border-sky-400/60 bg-sky-50 text-sky-900'
                          : 'border-zinc-300'
                      }`}
                    >
                      D&amp;R
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setGutterMode(gutterMode === 'rr' ? 'none' : 'rr');
                        setHasUnsavedChanges(true);
                      }}
                      className={`flex-1 py-2 rounded-2xl text-sm font-medium border transition-all ${
                        gutterMode === 'rr'
                          ? 'border-sky-400/60 bg-sky-50 text-sky-900'
                          : 'border-zinc-300'
                      }`}
                    >
                      R&amp;R
                    </button>
                  </div>
                  {gutterMode !== 'none' ? (
                    <div>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={gutterLF}
                        onChange={(e) => {
                          setGutterLF(e.target.value);
                          setHasUnsavedChanges(true);
                        }}
                        placeholder="Linear Feet"
                        className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900 mb-2"
                      />
                      {parseFloat(gutterLF || '0') > 0 && (
                        <div className="text-sm flex justify-between items-center">
                          <div className="text-amber-700">Cost</div>
                          <div className="font-semibold text-emerald-700">
                            + $
                            {(
                              parseFloat(gutterLF || '0') *
                              getSellPrice(
                                gutterMode === 'rr' ? 'gutters_rr' : 'gutters_dr',
                                gutterMode === 'rr'
                                  ? activePricingRegion === 'central'
                                    ? 20
                                    : 30
                                  : activePricingRegion === 'central'
                                    ? 15
                                    : 20
                              )
                            ).toLocaleString()}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-white border border-zinc-200 rounded-3xl p-5">
                  <div className="font-semibold mb-2 text-zinc-900">Solar Panels</div>
                  <input
                    type="number"
                    value={solarPanels}
                    onChange={(e) => setSolarPanels(e.target.value)}
                    placeholder="# of Panels"
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900"
                  />
                  {parseFloat(solarPanels || '0') > 0 && (
                    <div className="text-xs text-emerald-700 mt-2">
                      + ${(parseFloat(solarPanels) * 250).toLocaleString()}
                    </div>
                  )}
                </div>
                <div className="bg-white border border-zinc-200 rounded-3xl p-5">
                  <div className="font-semibold mb-2 text-zinc-900">HVAC</div>
                  <div className="text-xs text-zinc-500 mb-2">detach and reset</div>
                  <input
                    type="number"
                    value={hvacUnits}
                    onChange={(e) => setHvacUnits(e.target.value)}
                    placeholder="# of Units"
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900"
                  />
                  {parseFloat(hvacUnits || '0') > 0 && (
                    <div className="text-xs text-emerald-700 mt-2">
                      + $
                      {(
                        parseFloat(hvacUnits) *
                        getSellPrice(
                          'hvac',
                          activePricingRegion === 'central' ? 1250 : 1600
                        )
                      ).toLocaleString()}
                    </div>
                  )}
                </div>
                <div className="bg-white border border-zinc-200 rounded-3xl p-5">
                  <div className="font-semibold mb-2 text-zinc-900">Skylights</div>
                  <div className="text-xs text-zinc-500 mb-2">detach and reset</div>
                  <input
                    type="number"
                    value={skylights}
                    onChange={(e) => setSkylights(e.target.value)}
                    placeholder="# of Skylights"
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900"
                  />
                  {parseFloat(skylights || '0') > 0 && (
                    <div className="text-xs text-emerald-700 mt-2">
                      + $
                      {(
                        parseFloat(skylights) *
                        getSellPrice(
                          'skylight',
                          activePricingRegion === 'central' ? 500 : 550
                        )
                      ).toLocaleString()}
                    </div>
                  )}
                </div>
                <div className="bg-white border border-zinc-200 rounded-3xl p-5">
                  <div className="font-semibold mb-2 text-zinc-900">Ridge Vent</div>
                  <input
                    type="number"
                    value={ridgeVentLF}
                    onChange={(e) => setRidgeVentLF(e.target.value)}
                    placeholder="Linear Feet"
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900"
                  />
                  {parseFloat(ridgeVentLF || '0') > 0 && (
                    <div className="text-xs text-emerald-700 mt-2">
                      + $
                      {(
                        parseFloat(ridgeVentLF) * getSellPrice('ridge_vent', 12)
                      ).toFixed(0)}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="mb-8">
              <div className="text-sm font-semibold text-zinc-600 mb-4">ADDITIONAL NOTES</div>
              <div className="bg-white rounded-3xl p-5 border border-zinc-200">
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Anything extra to include on the estimate / PDF..."
                  rows={3}
                  className="w-full text-sm text-zinc-900 bg-transparent border-0 focus:outline-none resize-y min-h-[80px]"
                />
              </div>
            </div>
            <div className="sticky bottom-0 bg-white/95 backdrop-blur border-t border-zinc-200 py-4 z-40 -mx-[var(--page-pad-x)] px-[var(--page-pad-x)]">
              <div className="w-full flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
                <div>
                  <div className="text-xs text-zinc-500">TOTAL PRICE</div>
                  {selectedShingle === '' ? (
                    <div className="text-2xl font-semibold text-zinc-400">
                      Select a product to view pricing
                    </div>
                  ) : (
                    <div className="text-5xl font-semibold text-emerald-700 tabular-nums">${estimatorTotalPrice.toLocaleString()}</div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setShowProfessionalEstimate(true)}
                  className="btn-primary px-8 py-4 rounded-3xl font-semibold w-full sm:w-auto"
                >
                  See Estimate
                </button>
              </div>
            </div>
            </>
            )}
          </div>
        )}

            {isEditingLead && currentLeadId != null && profileTab !== 'estimator' && (() => {
              const profileLead = leads.find((l) => l.id === currentLeadId);
              const profileNotes = profileLead?.notes || [];
              const profileEstimates = profileLead?.estimates || [];
              const profilePhotos = profileLead?.photos || [];
              const profileDocuments = profileLead?.documents || [];
              const profileMeasurements = profileLead?.measurements || [];
              // Combined session report: draft sections + current outline
              const currentSectionPreview =
                showTracer && tracePoints.length >= 3
                  ? buildRoofSection(tracePoints, {
                      kind: sectionKind,
                      label:
                        sectionKind === 'flat'
                          ? 'Flat section'
                          : 'Pitched section',
                      pitch:
                        sectionKind === 'flat'
                          ? 'Flat'
                          : measurePitch === 'Flat'
                            ? '6/12'
                            : measurePitch,
                      waste: measureWaste,
                      autoPitch:
                        measurePitchAuto && sectionKind === 'pitched',
                      autoWaste: measureWasteAuto,
                    })
                  : null;
              const sessionSections = currentSectionPreview
                ? [...draftSections, currentSectionPreview]
                : draftSections;
              const sessionReport =
                sessionSections.length > 0
                  ? aggregateSectionsToMeasurement(sessionSections, {
                      label: measureLabel || clientAddress || 'Roof',
                      center: mapCenter || undefined,
                    })
                  : null;
              const liveMetrics =
                currentSectionPreview != null
                  ? computeRoofMetrics(tracePoints, {
                      pitch:
                        sectionKind === 'flat' ? 'Flat' : measurePitch,
                      waste: measureWaste,
                      roofType:
                        sectionKind === 'flat'
                          ? 'flat-modified-bitumen'
                          : 'pitched-shingles',
                      autoPitch:
                        measurePitchAuto && sectionKind === 'pitched',
                      autoWaste: measureWasteAuto,
                      pitchedFraction: sectionKind === 'flat' ? 0 : 1,
                    })
                  : null;
              const canAddSection = tracePoints.length >= 3;
              const canSaveReport =
                draftSections.length > 0 || canAddSection;
              const displayName =
                [clientFirstName, clientLastName].filter(Boolean).join(' ') ||
                'Untitled lead';
              const milestoneIndex = Math.max(
                0,
                PIPELINE_STAGES.indexOf(leadCategory)
              );
              const isFinalMilestone = leadCategory === 'Closed';

              const tabs: { id: ProfileTab; label: string; count?: number }[] = [
                { id: 'overview', label: 'Overview' },
                { id: 'pipeline', label: 'Pipeline' },
                {
                  id: 'measurements',
                  label: 'Measurements',
                  count: profileMeasurements.length,
                },
                { id: 'financial', label: 'Financial' },
                { id: 'insurance', label: 'Insurance' },
                {
                  id: 'notes',
                  label: 'Notes',
                  count: profileNotes.length,
                },
                {
                  id: 'estimates',
                  label: 'Estimates',
                  count: profileEstimates.length,
                },
                {
                  id: 'photos',
                  label: 'Photos',
                  count: profilePhotos.length,
                },
                {
                  id: 'documents',
                  label: 'Documents',
                  count: profileDocuments.length,
                },
              ];

              const fieldClass =
                'w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base bg-white focus:outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-300/50';
              const labelClass =
                'text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5';

              return (
                <div className="flex flex-col min-h-0 w-full page-fade">
                  {/* Lead sub-bar — same rail as header / estimator */}
                  <div className="bg-white border-b border-zinc-200/80">
                    <div className="page-rail py-3 sm:py-3.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <button
                            type="button"
                            onClick={closeLeadProfile}
                            className="shrink-0 px-3 py-2 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-100 border border-zinc-200 transition-colors"
                          >
                            ← Back
                          </button>
                          <h1 className="text-lg sm:text-xl font-semibold text-zinc-900 truncate">
                            {displayName}
                          </h1>
                        </div>
                        <button
                          type="button"
                          onClick={saveLeadProfile}
                          className="btn-primary shrink-0 px-5 py-2.5 rounded-xl font-semibold text-sm"
                        >
                          Save
                        </button>
                      </div>

                      <div className="mt-3 -mx-1 overflow-x-auto scrollbar-none">
                        <div className="flex gap-1 min-w-max px-1 pb-0.5">
                          {tabs.map((tab) => {
                            const active = profileTab === tab.id;
                            return (
                              <button
                                key={tab.id}
                                type="button"
                                onClick={() => switchProfileTab(tab.id)}
                                className={`px-3 sm:px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
                                  active
                                    ? 'bg-zinc-900 text-white shadow-sm'
                                    : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
                                }`}
                              >
                                {tab.label}
                                {typeof tab.count === 'number' && tab.count > 0 && (
                                  <span
                                    className={`ml-1.5 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full text-xs ${
                                      active
                                        ? 'bg-zinc-700 text-white'
                                        : 'bg-zinc-200 text-zinc-700'
                                    }`}
                                  >
                                    {tab.count}
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Tab content — same content width as estimator */}
                  <div className="flex-1">
                    <div className="page-shell page-shell--flush-top">
                      {profileTab === 'overview' && (
                        <div className="space-y-6">
                          <section className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6">
                            <h2 className="text-lg font-semibold text-zinc-900 mb-4">Contact</h2>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                              <div>
                                <div className={labelClass}>First name</div>
                                <input
                                  value={clientFirstName}
                                  onChange={(e) => setClientFirstName(e.target.value)}
                                  className={fieldClass}
                                />
                              </div>
                              <div>
                                <div className={labelClass}>Last name</div>
                                <input
                                  value={clientLastName}
                                  onChange={(e) => setClientLastName(e.target.value)}
                                  className={fieldClass}
                                />
                              </div>
                              <div className="sm:col-span-2">
                                <div className={labelClass}>Company</div>
                                <input
                                  value={leadCompany}
                                  onChange={(e) => setLeadCompany(e.target.value)}
                                  className={fieldClass}
                                  placeholder="Company name if applicable"
                                />
                              </div>
                              <div>
                                <div className={labelClass}>Phone</div>
                                <PhoneInput
                                  value={clientPhone}
                                  onChange={setClientPhone}
                                  className={fieldClass}
                                  placeholder="(480) 555-0100"
                                />
                              </div>
                              <div>
                                <div className={labelClass}>Email</div>
                                <input
                                  value={clientEmail}
                                  onChange={(e) => setClientEmail(e.target.value)}
                                  className={fieldClass}
                                  inputMode="email"
                                />
                              </div>
                              <div>
                                <div className={labelClass}>Job number</div>
                                <input
                                  value={clientJobNumber}
                                  onChange={(e) => setClientJobNumber(e.target.value)}
                                  className={fieldClass}
                                />
                              </div>
                              <div>
                                <div className={labelClass}>Follow-up date</div>
                                <input
                                  type="date"
                                  value={followUpDate}
                                  onChange={(e) => setFollowUpDate(e.target.value)}
                                  className={fieldClass}
                                />
                                <p className="text-xs text-zinc-400 mt-1.5">
                                  Used when syncing this job to Google Calendar
                                </p>
                              </div>
                            </div>
                            {gcalConnected && currentLeadId != null && (
                              <div className="mt-4 flex flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  disabled={gcalBusy}
                                  onClick={() => {
                                    saveLeadDraft({ silent: true });
                                    void syncLeadsToGoogleCalendar({
                                      leadIds: [currentLeadId],
                                    });
                                  }}
                                  className="px-4 py-2 rounded-xl text-sm font-semibold border border-zinc-200 text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
                                >
                                  {gcalBusy
                                    ? 'Syncing…'
                                    : leads.find((l) => l.id === currentLeadId)
                                          ?.calendarEventId
                                      ? 'Update Google Calendar'
                                      : 'Add to Google Calendar'}
                                </button>
                                {leads.find((l) => l.id === currentLeadId)
                                  ?.calendarHtmlLink && (
                                  <a
                                    href={
                                      leads.find((l) => l.id === currentLeadId)
                                        ?.calendarHtmlLink
                                    }
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-sm font-medium text-sky-800 hover:underline"
                                  >
                                    Open event →
                                  </a>
                                )}
                              </div>
                            )}

                            <div className="mt-6 pt-5 border-t border-zinc-100">
                              <div className="flex items-center justify-between mb-3">
                                <h3 className="text-sm font-semibold text-zinc-800">
                                  Additional contacts
                                </h3>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setAdditionalContacts((prev) => [
                                      ...prev,
                                      emptyAdditionalContact(),
                                    ])
                                  }
                                  className="text-sm font-medium text-sky-700 hover:underline"
                                >
                                  + Add contact
                                </button>
                              </div>
                              {additionalContacts.length > 0 && (
                                <div className="space-y-4">
                                  {additionalContacts.map((c, idx) => (
                                    <div
                                      key={c.id}
                                      className="rounded-2xl border border-zinc-200 p-4 space-y-3"
                                    >
                                      <div className="flex justify-between items-center">
                                        <span className="text-xs font-semibold text-zinc-500">
                                          Contact {idx + 1}
                                        </span>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            setAdditionalContacts((prev) =>
                                              prev.filter((x) => x.id !== c.id)
                                            )
                                          }
                                          className="text-xs text-zinc-400 hover:text-red-600"
                                        >
                                          Remove
                                        </button>
                                      </div>
                                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        <input
                                          placeholder="First name"
                                          value={c.firstName}
                                          onChange={(e) =>
                                            setAdditionalContacts((prev) =>
                                              prev.map((x) =>
                                                x.id === c.id
                                                  ? {
                                                      ...x,
                                                      firstName: e.target.value,
                                                    }
                                                  : x
                                              )
                                            )
                                          }
                                          className={`${fieldClass} !py-2.5`}
                                        />
                                        <input
                                          placeholder="Last name"
                                          value={c.lastName}
                                          onChange={(e) =>
                                            setAdditionalContacts((prev) =>
                                              prev.map((x) =>
                                                x.id === c.id
                                                  ? {
                                                      ...x,
                                                      lastName: e.target.value,
                                                    }
                                                  : x
                                              )
                                            )
                                          }
                                          className={`${fieldClass} !py-2.5`}
                                        />
                                        <input
                                          placeholder="Relationship (spouse, other…)"
                                          value={c.relationship || ''}
                                          onChange={(e) =>
                                            setAdditionalContacts((prev) =>
                                              prev.map((x) =>
                                                x.id === c.id
                                                  ? {
                                                      ...x,
                                                      relationship: e.target.value,
                                                    }
                                                  : x
                                              )
                                            )
                                          }
                                          className={`${fieldClass} !py-2.5 sm:col-span-2`}
                                        />
                                        <PhoneInput
                                          placeholder="Phone"
                                          value={c.phone || ''}
                                          onChange={(v) =>
                                            setAdditionalContacts((prev) =>
                                              prev.map((x) =>
                                                x.id === c.id
                                                  ? { ...x, phone: v }
                                                  : x
                                              )
                                            )
                                          }
                                          className={`${fieldClass} !py-2.5`}
                                        />
                                        <input
                                          placeholder="Email"
                                          value={c.email || ''}
                                          onChange={(e) =>
                                            setAdditionalContacts((prev) =>
                                              prev.map((x) =>
                                                x.id === c.id
                                                  ? {
                                                      ...x,
                                                      email: e.target.value,
                                                    }
                                                  : x
                                              )
                                            )
                                          }
                                          className={`${fieldClass} !py-2.5`}
                                          inputMode="email"
                                        />
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </section>

                          <section className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6">
                            <h2 className="text-lg font-semibold text-zinc-900 mb-1">
                              Property address
                            </h2>
                            <p className="text-sm text-zinc-500 mb-4">
                              Lead job site — used for measurements and estimates. Suggestions
                              only appear while you type.
                            </p>
                            <div className="space-y-4">
                              <div>
                                <div className={labelClass}>Street</div>
                                <AddressAutocomplete
                                  value={clientAddress}
                                  onChange={setClientAddress}
                                  onSelect={(p) => {
                                    setClientAddress(p.street);
                                    if (p.city) setClientCity(p.city);
                                    if (p.state) setClientState(p.state);
                                    if (p.zip) setClientZip(p.zip);
                                  }}
                                  cityHint={clientCity}
                                  stateHint={clientState}
                                  className={fieldClass}
                                  placeholder="Street address"
                                />
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                <div>
                                  <div className={labelClass}>City</div>
                                  <input
                                    value={clientCity}
                                    onChange={(e) => setClientCity(e.target.value)}
                                    placeholder="City"
                                    className={fieldClass}
                                  />
                                </div>
                                <div>
                                  <div className={labelClass}>State</div>
                                  <input
                                    value={clientState}
                                    onChange={(e) => setClientState(e.target.value)}
                                    placeholder="State"
                                    className={fieldClass}
                                  />
                                </div>
                                <div>
                                  <div className={labelClass}>Zip</div>
                                  <input
                                    value={clientZip}
                                    onChange={(e) => setClientZip(e.target.value)}
                                    placeholder="Zip"
                                    className={fieldClass}
                                    inputMode="numeric"
                                  />
                                </div>
                              </div>
                              <label className="flex items-center gap-2 text-sm text-zinc-700 pt-1">
                                <input
                                  type="checkbox"
                                  checked={mailingSameAsBilling}
                                  onChange={(e) => setMailingSameAsBilling(e.target.checked)}
                                  className="w-4 h-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-400"
                                />
                                Billing same as property
                              </label>
                              {!mailingSameAsBilling && (
                                <div className="space-y-3 pt-1 border-t border-zinc-100">
                                  <div className={labelClass}>Billing street</div>
                                  <AddressAutocomplete
                                    value={billingAddress}
                                    onChange={setBillingAddress}
                                    onSelect={(p) => {
                                      setBillingAddress(p.street);
                                      if (p.city) setBillingCity(p.city);
                                      if (p.state) setBillingState(p.state);
                                      if (p.zip) setBillingZip(p.zip);
                                    }}
                                    cityHint={billingCity}
                                    stateHint={billingState}
                                    className={fieldClass}
                                    placeholder="Billing street address"
                                  />
                                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                    <div>
                                      <div className={labelClass}>City</div>
                                      <input
                                        value={billingCity}
                                        onChange={(e) => setBillingCity(e.target.value)}
                                        placeholder="City"
                                        className={fieldClass}
                                      />
                                    </div>
                                    <div>
                                      <div className={labelClass}>State</div>
                                      <input
                                        value={billingState}
                                        onChange={(e) => setBillingState(e.target.value)}
                                        placeholder="State"
                                        className={fieldClass}
                                      />
                                    </div>
                                    <div>
                                      <div className={labelClass}>Zip</div>
                                      <input
                                        value={billingZip}
                                        onChange={(e) => setBillingZip(e.target.value)}
                                        placeholder="Zip"
                                        className={fieldClass}
                                        inputMode="numeric"
                                      />
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          </section>

                          <section className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6">
                            <h2 className="text-lg font-semibold text-zinc-900 mb-4">
                              Job, HOA &amp; source
                            </h2>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                              <div>
                                <div className={labelClass}>Job category</div>
                                <select
                                  value={jobCategory}
                                  onChange={(e) => setJobCategory(e.target.value as JobCategory)}
                                  className={fieldClass}
                                >
                                  <option value="Residential">Residential</option>
                                  <option value="Commercial">Commercial</option>
                                  <option value="Property Management">Property Management</option>
                                </select>
                              </div>
                              <div>
                                <div className={labelClass}>Pipeline stage</div>
                                <select
                                  value={leadCategory}
                                  onChange={(e) => {
                                    const stage = e.target.value as PipelineStage;
                                    setLeadCategory(stage);
                                    if (currentLeadId) {
                                      moveLeadToStage(currentLeadId, stage, { toast: false });
                                    }
                                  }}
                                  className={fieldClass}
                                >
                                  {PIPELINE_STAGES.map((stage) => (
                                    <option key={stage} value={stage}>
                                      {stage}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="sm:col-span-2">
                                <label className="flex items-center gap-2 text-sm text-zinc-700">
                                  <input
                                    type="checkbox"
                                    checked={hasHOA}
                                    onChange={(e) => setHasHOA(e.target.checked)}
                                    className="w-4 h-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-400"
                                  />
                                  This property has an HOA
                                </label>
                                {hasHOA && (
                                  <input
                                    value={hoaInfo}
                                    onChange={(e) => setHoaInfo(e.target.value)}
                                    className={`${fieldClass} mt-3`}
                                    placeholder="HOA name and contact info"
                                  />
                                )}
                              </div>
                              <div className="sm:col-span-2">
                                <div className={labelClass}>Lead source</div>
                                <select
                                  value={leadSource}
                                  onChange={(e) => setLeadSource(e.target.value as LeadSource)}
                                  className={fieldClass}
                                >
                                  <option value="Self Generated">Self Generated</option>
                                  <option value="Referral">Referral</option>
                                  <option value="In-House">In-House</option>
                                  <option value="Yard Sign">Yard Sign</option>
                                  <option value="Social Media">Social Media</option>
                                  <option value="Other">Other</option>
                                </select>
                                {leadSource === 'Referral' && (
                                  <input
                                    value={referralName}
                                    onChange={(e) => setReferralName(e.target.value)}
                                    className={`${fieldClass} mt-3`}
                                    placeholder="Who referred this lead?"
                                  />
                                )}
                              </div>
                            </div>
                          </section>

                          <div className="pt-6 pb-4 flex items-center justify-between gap-3 border-t border-zinc-100 mt-6">
                            <button
                              type="button"
                              onClick={() => {
                                if (currentLeadId != null) moveToTrash(currentLeadId);
                              }}
                              disabled={currentLeadId == null}
                              className="text-xs text-zinc-400 hover:text-red-600 disabled:opacity-40"
                            >
                              Move to trash
                            </button>
                            <button
                              type="button"
                              onClick={saveLeadProfile}
                              className="btn-primary px-5 py-2.5 rounded-xl font-semibold text-sm"
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      )}

                      {profileTab === 'pipeline' && (
                        <section className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6">
                          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
                            <div>
                              <h2 className="text-lg font-semibold text-zinc-900">
                                Pipeline / milestones
                              </h2>
                              <p className="text-sm text-zinc-500 mt-1">
                                Track job progress from first contact through close-out.
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={advanceJobMilestone}
                              disabled={isFinalMilestone}
                              className="btn-primary inline-flex items-center justify-center px-5 py-3 rounded-2xl text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              {isFinalMilestone ? 'Job closed' : 'Advance job'}
                            </button>
                          </div>

                          <div className="rounded-2xl bg-zinc-100 border border-zinc-200 px-4 py-3 mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                            <div className="text-sm text-zinc-800">
                              <span className="font-medium">Current status:</span>{' '}
                              <span className="font-semibold">{leadCategory}</span>
                            </div>
                            <div className="text-xs text-zinc-500 font-medium">
                              Step {milestoneIndex + 1} of {PIPELINE_STAGES.length}
                            </div>
                          </div>

                          <ol className="space-y-3">
                            {PIPELINE_STAGES.map((stage, idx) => {
                              const done = idx < milestoneIndex;
                              const current = idx === milestoneIndex;
                              const upcoming = idx > milestoneIndex;
                              return (
                                <li key={stage}>
                                  <button
                                    type="button"
                                    onClick={() => setLeadMilestone(stage)}
                                    className={`w-full text-left flex items-center gap-4 rounded-2xl border px-4 py-3.5 transition-colors ${
                                      current
                                        ? 'border-zinc-900 bg-white shadow-sm'
                                        : done
                                          ? 'border-zinc-200 bg-white hover:border-zinc-200'
                                          : 'border-zinc-100 bg-zinc-100/80 hover:border-zinc-200'
                                    }`}
                                  >
                                    <div
                                      className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${
                                        current
                                          ? 'bg-zinc-900 text-white'
                                          : done
                                            ? 'bg-zinc-200 text-zinc-700'
                                            : 'bg-white border border-zinc-200 text-zinc-400'
                                      }`}
                                    >
                                      {idx + 1}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div
                                        className={`font-semibold ${
                                          current
                                            ? 'text-zinc-900'
                                            : done
                                              ? 'text-zinc-800'
                                              : 'text-zinc-500'
                                        }`}
                                      >
                                        {stage}
                                      </div>
                                      <div className="text-xs text-zinc-500 mt-0.5">
                                        {current
                                          ? 'Current milestone — highlighted'
                                          : done
                                            ? 'Completed'
                                            : 'Upcoming'}
                                      </div>
                                    </div>
                                    {current && (
                                      <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-zinc-700 bg-zinc-100 px-2.5 py-1 rounded-full">
                                        Now
                                      </span>
                                    )}
                                    {upcoming && (
                                      <span className="shrink-0 text-xs text-zinc-400">
                                        Jump here
                                      </span>
                                    )}
                                  </button>
                                </li>
                              );
                            })}
                          </ol>

                          <p className="mt-5 text-xs text-zinc-400">
                            Tap any stage to set it, use Advance job, or drag cards on the Leads
                            board. Home, kanban, and this profile all share the same 6 stages.
                          </p>
                        </section>
                      )}

                      {profileTab === 'measurements' && (() => {
                        const cityState = [clientCity, clientState]
                          .filter(Boolean)
                          .join(', ');
                        const cityStateZip = [cityState, clientZip]
                          .filter(Boolean)
                          .join(' ');
                        const profileAddressLine = [clientAddress, cityStateZip]
                          .filter(Boolean)
                          .join(', ');
                        const hasProfileAddress = !!(
                          clientAddress.trim() ||
                          clientCity.trim() ||
                          clientZip.trim()
                        );

                        return (
                        <div className="w-full space-y-5">
                          {/* Read-only property address from lead profile */}
                          <div className="rounded-2xl border border-zinc-100 bg-zinc-100/80 px-4 py-3.5">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 text-left">
                                <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">
                                  Property
                                </p>
                                {hasProfileAddress ? (
                                  <p className="mt-1 text-sm font-medium text-zinc-900 leading-snug break-words">
                                    {profileAddressLine || clientAddress}
                                  </p>
                                ) : (
                                  <p className="mt-1 text-sm text-zinc-500">
                                    No address on this lead — add one under Overview
                                  </p>
                                )}
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                {!hasProfileAddress && (
                                  <button
                                    type="button"
                                    onClick={() => setProfileTab('overview')}
                                    className="text-xs font-semibold text-emerald-700 hover:text-emerald-800 transition-colors"
                                  >
                                    Edit lead
                                  </button>
                                )}
                                {(showTracer || mapCenter) && hasProfileAddress && (
                                  <button
                                    type="button"
                                    disabled={geocoding}
                                    onClick={() => void recenterMapOnAddress()}
                                    className="text-xs font-medium text-zinc-500 hover:text-zinc-800"
                                  >
                                    {geocoding ? 'Locating…' : 'Recenter map'}
                                  </button>
                                )}
                              </div>
                            </div>
                            {addressGeocodeFailed && showTracer && (
                              <p className="text-xs text-zinc-600 mt-2">
                                Could not locate address — pan the map or use Street layer
                              </p>
                            )}
                          </div>

                          

                          {/* Map or start */}
                          {!showTracer && !geocoding && (
                            <div className="rounded-3xl bg-zinc-100 border border-zinc-100 px-6 py-12 text-center space-y-4">
                              <p className="text-sm text-zinc-500">
                                {hasProfileAddress
                                  ? 'Trace the roof on satellite to measure'
                                  : 'Add a property address on the lead, then open the map'}
                              </p>
                              
                          <div className="flex flex-wrap items-center justify-center gap-2">
                            <input
                              ref={measurementFileRef}
                              type="file"
                              accept="application/pdf,.pdf,image/*"
                              className="hidden"
                              onChange={(e) => {
                                void uploadMeasurementReport(e.target.files);
                                e.target.value = '';
                              }}
                            />
                            <button
                                type="button"
                                onClick={() => {
                                  if (!hasProfileAddress) {
                                    setProfileTab('overview');
                                    showToast('Add a property address under Overview first');
                                    return;
                                  }
                                  void startNewMeasurementOnLead();
                                }}
                                className="btn-primary px-8 py-3 rounded-full text-sm font-semibold"
                              >
                                {hasProfileAddress ? 'Open map' : 'Add address first'}
                              </button>
                            <button
                              type="button"
                              onClick={() => measurementFileRef.current?.click()}
                              className="btn-primary px-8 py-3 rounded-full text-sm font-semibold"
                            >
                              + Upload
                            </button>
                          </div>
                            </div>
                          )}

                          {(() => {
                            const lead = leads.find((l) => l.id === currentLeadId);
                            const reports = lead?.measurementReports || [];
                            if (reports.length === 0) return null;
                            return (
                              <div className="rounded-2xl border border-zinc-200 bg-white p-4 space-y-2">
                                <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                                  Uploaded measurements
                                </div>
                                {reports.map((doc) => (
                                  <div
                                    key={doc.id}
                                    className="flex items-center gap-2 rounded-xl border border-zinc-100 px-3 py-2.5 hover:border-sky-300 hover:bg-sky-50/50 transition"
                                  >
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setMeasurementPdfUrl(doc.url);
                                        setMeasurementPdfName(doc.name);
                                      }}
                                      className="flex-1 min-w-0 text-left"
                                    >
                                      <span className="text-sm font-medium text-zinc-900 truncate block">
                                        {doc.name}
                                      </span>
                                      <span className="text-xs text-zinc-400">
                                        {doc.createdAt}
                                      </span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => removeMeasurementReport(doc.id)}
                                      className="shrink-0 text-xs font-semibold text-red-600 hover:text-red-700 px-2 py-1"
                                    >
                                      Delete
                                    </button>
                                  </div>
                                ))}
                              </div>
                            );
                          })()}

                          {geocoding && !showTracer && (
                            <div className="rounded-3xl bg-zinc-100 border border-zinc-100 py-16 text-center text-sm text-zinc-400">
                              Finding property…
                            </div>
                          )}

                          {showTracer && (() => {
                            const draftHasPitched = draftSections.some(
                              (s) => s.kind === 'pitched'
                            );
                            const draftHasFlat = draftSections.some(
                              (s) => s.kind === 'flat'
                            );
                            const lastDraft =
                              draftSections[draftSections.length - 1] ?? null;
                            const waitingForNextSection =
                              draftSections.length > 0 &&
                              tracePoints.length === 0;
                            // After a section is committed, spell out the two valid moves
                            const nextStepTitle = !lastDraft
                              ? null
                              : lastDraft.kind === 'flat' && !draftHasPitched
                                ? 'Flat section saved'
                                : lastDraft.kind === 'pitched' && !draftHasFlat
                                  ? 'Pitched section saved'
                                  : `${lastDraft.kind === 'flat' ? 'Flat' : 'Pitched'} section saved`;
                            const nextStepBody = !lastDraft
                              ? null
                              : lastDraft.kind === 'flat' && !draftHasPitched
                                ? 'Choose next: add a pitched section, or finish this report now.'
                                : lastDraft.kind === 'pitched' && !draftHasFlat
                                  ? 'Choose next: add a flat section, or finish this report now.'
                                  : 'Add another pitched or flat section, or finish this report.';

                            return (
                            <div className="space-y-5">
                              <p className="text-center text-xs text-zinc-400">
                                Trace any sections in any order — pitched and flat combine
                                on Save
                              </p>

                              {/* After commit: clear pitched-or-finish / flat-or-finish choice */}
                              {waitingForNextSection && nextStepTitle && (
                                <div className="rounded-2xl border border-emerald-200/70 bg-emerald-50/50 px-4 py-4 space-y-3">
                                  <div className="text-center">
                                    <p className="text-sm font-semibold text-zinc-900">
                                      {nextStepTitle}
                                    </p>
                                    <p className="text-xs text-zinc-700 mt-1">
                                      {nextStepBody}
                                    </p>
                                  </div>
                                  <div className="flex flex-col sm:flex-row gap-2">
                                    {lastDraft?.kind === 'flat' && !draftHasPitched ? (
                                      <>
                                        <button
                                          type="button"
                                          onClick={() => prepareSectionKind('pitched')}
                                          className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-white border border-emerald-200 text-emerald-900 hover:bg-sky-50 transition-colors"
                                        >
                                          Add pitched section
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => saveRoofMeasurement()}
                                          className="btn-primary flex-1 py-2.5 rounded-xl text-sm font-semibold"
                                        >
                                          Save & finish
                                        </button>
                                      </>
                                    ) : lastDraft?.kind === 'pitched' && !draftHasFlat ? (
                                      <>
                                        <button
                                          type="button"
                                          onClick={() => prepareSectionKind('flat')}
                                          className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-white border border-emerald-200 text-emerald-900 hover:bg-sky-50 transition-colors"
                                        >
                                          Add flat section
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => saveRoofMeasurement()}
                                          className="btn-primary flex-1 py-2.5 rounded-xl text-sm font-semibold"
                                        >
                                          Save & finish
                                        </button>
                                      </>
                                    ) : (
                                      <>
                                        <button
                                          type="button"
                                          onClick={() => prepareSectionKind('pitched')}
                                          className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-white border border-emerald-200 text-emerald-900 hover:bg-sky-50 transition-colors"
                                        >
                                          More pitched
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => prepareSectionKind('flat')}
                                          className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-white border border-emerald-200 text-emerald-900 hover:bg-sky-50 transition-colors"
                                        >
                                          More flat
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => saveRoofMeasurement()}
                                          className="btn-primary flex-1 py-2.5 rounded-xl text-sm font-semibold"
                                        >
                                          Save & finish
                                        </button>
                                      </>
                                    )}
                                  </div>
                                  <p className="text-[11px] text-center text-zinc-500">
                                    Selected type below: {sectionKind === 'flat' ? 'Flat' : 'Pitched'}
                                    {' · '}trace the next outline on the map when ready
                                  </p>
                                </div>
                              )}

                              {/* Roof type for current section */}
                              <div className="flex flex-col items-center gap-1.5">
                                <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">
                                  Tracing now
                                </p>
                                <div className="inline-flex p-1 rounded-full bg-zinc-100">
                                  <button
                                    type="button"
                                    onClick={() => prepareSectionKind('pitched')}
                                    className={`px-5 py-2 rounded-full text-sm font-medium transition-colors ${
                                      sectionKind === 'pitched'
                                        ? 'bg-white text-zinc-900 shadow-sm'
                                        : 'text-zinc-500'
                                    }`}
                                  >
                                    Pitched
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => prepareSectionKind('flat')}
                                    className={`px-5 py-2 rounded-full text-sm font-medium transition-colors ${
                                      sectionKind === 'flat'
                                        ? 'bg-white text-zinc-900 shadow-sm'
                                        : 'text-zinc-500'
                                    }`}
                                  >
                                    Flat
                                  </button>
                                </div>
                              </div>

                              <RoofTracer
                                key={`trace-${mapSessionKey}-${currentLeadId ?? 'n'}-${mapCenter ? `${mapCenter.lat.toFixed(5)},${mapCenter.lng.toFixed(5)}` : 'x'}`}
                                initialPoints={tracePoints}
                                center={mapCenter}
                                onChange={setTracePoints}
                                onPolygonComplete={(pts) => {
                                  setTracePoints(pts);
                                  // Ref avoids stale kind when map stays mounted across toggles
                                  const kind = sectionKindRef.current;
                                  const rt: RoofType =
                                    kind === 'flat'
                                      ? 'flat-modified-bitumen'
                                      : 'pitched-shingles';
                                  if (kind === 'flat') {
                                    setMeasurePitch('Flat');
                                  } else if (measurePitchAuto) {
                                    setMeasurePitch(estimatePitchFromPolygon(pts, rt));
                                  }
                                  if (measureWasteAuto) {
                                    setMeasureWaste(estimateWasteFromPolygon(pts, rt));
                                  }
                                }}
                                height={520}
                              />

                              {/* Pitch + waste for current section */}
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <label className="block text-[11px] font-medium text-zinc-400 mb-1.5 text-center">
                                    Pitch
                                  </label>
                                  <select
                                    value={measurePitch}
                                    disabled={sectionKind === 'flat'}
                                    onChange={(e) => {
                                      setMeasurePitch(e.target.value);
                                      setMeasurePitchAuto(false);
                                    }}
                                    className="w-full text-center text-sm font-medium text-zinc-900 rounded-2xl border-0 bg-zinc-100 py-3 focus:outline-none focus:ring-2 focus:ring-zinc-300/50 disabled:opacity-50"
                                  >
                                    {PITCH_OPTIONS.map((p) => (
                                      <option key={p} value={p}>
                                        {p}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                                <div>
                                  <label className="block text-[11px] font-medium text-zinc-400 mb-1.5 text-center">
                                    Waste
                                  </label>
                                  <select
                                    value={String(measureWaste)}
                                    onChange={(e) => {
                                      setMeasureWaste(parseFloat(e.target.value) || 0);
                                      setMeasureWasteAuto(false);
                                    }}
                                    className="w-full text-center text-sm font-medium text-zinc-900 rounded-2xl border-0 bg-zinc-100 py-3 focus:outline-none focus:ring-2 focus:ring-zinc-300/50"
                                  >
                                    {[0, 0.05, 0.08, 0.1, 0.12, 0.15, 0.2].map((w) => (
                                      <option key={w} value={String(w)}>
                                        {Math.round(w * 100)}%
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              </div>

                              {/* This section preview */}
                              {liveMetrics && (
                                <div className="rounded-2xl border border-zinc-100 bg-white px-4 py-3 text-center text-sm text-zinc-600">
                                  This {sectionKind === 'flat' ? 'flat' : 'pitched'} section ·{' '}
                                  <span className="font-semibold text-zinc-900 tabular-nums">
                                    {sectionKind === 'flat'
                                      ? liveMetrics.flatSquares
                                      : liveMetrics.squares}{' '}
                                    sq
                                  </span>
                                  {' · '}
                                  {liveMetrics.pitch}
                                  {' · '}
                                  {Math.round(liveMetrics.waste * 100)}% waste
                                </div>
                              )}

                              {/* Add section (not final save) — no forced order in label */}
                              <button
                                type="button"
                                disabled={!canAddSection}
                                onClick={addSectionToDraft}
                                className="w-full py-3 rounded-2xl text-sm font-semibold border border-zinc-200 text-zinc-800 hover:bg-zinc-100 disabled:opacity-30 transition-colors"
                              >
                                {canAddSection
                                  ? sectionKind === 'pitched'
                                    ? 'Add pitched section to report'
                                    : 'Add flat section to report'
                                  : 'Trace 3+ corners to add this section'}
                              </button>

                              {/* Committed sections this session */}
                              {draftSections.length > 0 && (
                                <div className="space-y-2">
                                  <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 px-1">
                                    In this report ({draftSections.length})
                                    {draftHasPitched && draftHasFlat
                                      ? ' · mixed'
                                      : draftHasFlat
                                        ? ' · flat only'
                                        : ' · pitched only'}
                                  </p>
                                  {draftSections.map((s, i) => (
                                    <div
                                      key={s.id}
                                      className="flex items-center justify-between gap-2 rounded-xl border border-zinc-100 bg-zinc-100/80 px-3 py-2.5"
                                    >
                                      <div className="min-w-0">
                                        <div className="text-sm font-medium text-zinc-900">
                                          {i + 1}. {s.label}{' '}
                                          <span
                                            className={`text-[10px] uppercase font-semibold ${
                                              s.kind === 'flat'
                                                ? 'text-sky-700'
                                                : 'text-emerald-700'
                                            }`}
                                          >
                                            {s.kind}
                                          </span>
                                        </div>
                                        <div className="text-xs text-zinc-500">
                                          {s.squares} sq · {s.pitch} ·{' '}
                                          {Math.round(s.waste * 100)}%
                                        </div>
                                      </div>
                                      <button
                                        type="button"
                                        onClick={() => removeDraftSection(s.id)}
                                        className="text-xs text-zinc-400 hover:text-zinc-700 shrink-0"
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              )}

                              {/* Combined report totals */}
                              {sessionReport && (
                                <div className="rounded-3xl bg-zinc-100 px-4 py-4">
                                  <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 text-center mb-3">
                                    Combined report
                                    {sessionSections.length > 1
                                      ? ` · ${sessionSections.length} sections`
                                      : ''}
                                  </p>
                                  <div className="grid grid-cols-3 gap-y-4 gap-x-2 text-center">
                                    <div>
                                      <div className="text-[11px] text-zinc-400 font-medium">
                                        Pitched sq
                                      </div>
                                      <div className="text-xl font-semibold tabular-nums text-zinc-900 mt-0.5">
                                        {sessionReport.squares}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[11px] text-zinc-400 font-medium">
                                        Flat sq
                                      </div>
                                      <div className="text-xl font-semibold tabular-nums text-zinc-900 mt-0.5">
                                        {sessionReport.flatSquares}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[11px] text-zinc-400 font-medium">
                                        Total sq
                                      </div>
                                      <div className="text-xl font-semibold tabular-nums text-zinc-900 mt-0.5">
                                        {Math.round(
                                          (sessionReport.squares +
                                            sessionReport.flatSquares) *
                                            100
                                        ) / 100}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[11px] text-zinc-400 font-medium">
                                        Perimeter
                                      </div>
                                      <div className="text-base font-semibold tabular-nums text-zinc-800 mt-0.5">
                                        {sessionReport.perimeterLF} lf
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[11px] text-zinc-400 font-medium">
                                        Ridge
                                      </div>
                                      <div className="text-base font-semibold tabular-nums text-zinc-800 mt-0.5">
                                        {sessionReport.ridgeLF} lf
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[11px] text-zinc-400 font-medium">
                                        Eave
                                      </div>
                                      <div className="text-base font-semibold tabular-nums text-zinc-800 mt-0.5">
                                        {sessionReport.eaveLF} lf
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              )}

                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  onClick={() => {
                                    clearMapSession();
                                    setShowTracer(false);
                                    setGeocoding(false);
                                  }}
                                  className="px-5 py-3.5 rounded-2xl text-sm font-medium text-zinc-600 bg-zinc-100 hover:bg-zinc-200 transition-colors"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  disabled={!canSaveReport}
                                  onClick={() => saveRoofMeasurement()}
                                  className="btn-primary flex-1 py-3.5 rounded-2xl text-sm font-semibold disabled:opacity-30"
                                >
                                  {draftSections.length > 0
                                    ? 'Save report & finish'
                                    : 'Save report'}
                                </button>
                              </div>
                            </div>
                            );
                          })()}

                          {/* Saved list — minimal */}
                          {!showTracer && profileMeasurements.length > 0 && (
                            <div className="pt-2 space-y-1">
                              <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 px-1 mb-2">
                                Saved
                              </p>
                              {[...profileMeasurements].reverse().map((m) => (
                                <div
                                  key={m.id}
                                  className="flex items-center gap-3 px-3 py-3 rounded-2xl hover:bg-zinc-100 transition-colors"
                                >
                                  <button
                                    type="button"
                                    className="flex-1 text-left min-w-0"
                                    onClick={() => setSelectedMeasurementId(m.id)}
                                  >
                                    <div className="text-sm font-medium text-zinc-900 truncate">
                                      {m.label || 'Roof'}
                                    </div>
                                    <div className="text-xs text-zinc-400 mt-0.5">
                                      {m.squares > 0 ? `${m.squares} pitched` : ''}
                                      {m.squares > 0 && m.flatSquares > 0
                                        ? ' · '
                                        : ''}
                                      {m.flatSquares > 0
                                        ? `${m.flatSquares} flat`
                                        : ''}
                                      {m.squares <= 0 && m.flatSquares <= 0
                                        ? '0 sq'
                                        : ''}{' '}
                                      · {m.pitch} · {Math.round(m.waste * 100)}%
                                    </div>
                                  </button>
                                  {profileLead && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        saveLeadDraft({ silent: true });
                                        applyMeasurementToEstimator(m, profileLead);
                                        enterLeadEstimator(profileLead.id, 'estimate');
                                        showToast('Applied to estimate');
                                      }}
                                      className="text-xs font-semibold text-emerald-700 hover:text-emerald-800 transition-colors shrink-0"
                                    >
                                      Apply
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => deleteRoofMeasurement(m.id)}
                                    className="text-xs text-zinc-300 hover:text-zinc-500 shrink-0"
                                  >
                                    ✕
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        );
                      })()}

                      {profileTab === 'financial' && (
                        <div className="space-y-4">
                          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                            <div className="lg:col-span-2 space-y-3">
                              <div className="flex items-center justify-between gap-3">
                                <h2 className="text-sm font-semibold text-zinc-900">
                                  Worksheet
                                </h2>
                                <div className="relative">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setFinSectionMenuOpen((o) => !o)
                                    }
                                    className="text-sm font-medium text-sky-700 hover:underline"
                                  >
                                    + Section
                                  </button>
                                  {finSectionMenuOpen && (
                                    <div className="absolute right-0 mt-1 w-52 rounded-xl border border-zinc-200 bg-white shadow-lg z-20 py-1">
                                      {(
                                        [
                                          'Roof – Shingle',
                                          'Roof – Tile',
                                          'Roof – Flat / Mod bit',
                                          'Roof – Foam',
                                          'Roof – Coating',
                                          'Other',
                                        ] as const
                                      ).map((title) => (
                                        <button
                                          key={title}
                                          type="button"
                                          className="w-full text-left px-3 py-2 text-sm text-zinc-800 hover:bg-sky-50"
                                          onClick={() => {
                                            setFinancialWorksheet((w) =>
                                              withAutoApproved({
                                                ...w,
                                                sections: [
                                                  ...w.sections,
                                                  {
                                                    id: newFinId(),
                                                    title,
                                                    lines: [],
                                                  },
                                                ],
                                              })
                                            );
                                            setFinSectionMenuOpen(false);
                                          }}
                                        >
                                          {title}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                              {financialWorksheet.sections.length === 0 && (
                                <div className="rounded-2xl border border-dashed border-zinc-200 bg-white px-4 py-10 text-center text-sm text-zinc-400">
                                  No sections yet. Pick a roof type above, then
                                  add line items under it.
                                </div>
                              )}
                              {financialWorksheet.sections.map((sec) => {
                                const sub = sec.lines.reduce(
                                  (s, l) => s + (Number(l.amount) || 0),
                                  0
                                );
                                return (
                                  <div
                                    key={sec.id}
                                    className="rounded-2xl border border-zinc-200 bg-white overflow-hidden"
                                  >
                                    <div className="flex items-center gap-2 px-3 py-2 bg-zinc-50 border-b border-zinc-100">
                                      <input
                                        value={sec.title}
                                        onChange={(e) =>
                                          setFinancialWorksheet((w) => ({
                                            ...w,
                                            sections: w.sections.map((s) =>
                                              s.id === sec.id
                                                ? {
                                                    ...s,
                                                    title: e.target.value,
                                                  }
                                                : s
                                            ),
                                          }))
                                        }
                                        className="flex-1 bg-transparent text-sm font-semibold text-zinc-800 border-0 focus:outline-none"
                                        placeholder="Section title"
                                      />
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setFinancialWorksheet((w) => ({
                                            ...w,
                                            sections: w.sections.map((s) =>
                                              s.id === sec.id
                                                ? {
                                                    ...s,
                                                    lines: [
                                                      ...s.lines,
                                                      {
                                                        id: newFinId(),
                                                        label: '',
                                                        amount: 0,
                                                      },
                                                    ],
                                                  }
                                                : s
                                            ),
                                          }))
                                        }
                                        className="text-xs font-medium text-sky-700"
                                      >
                                        + Line
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setFinancialWorksheet((w) => ({
                                            ...w,
                                            sections: w.sections.filter(
                                              (s) => s.id !== sec.id
                                            ),
                                          }))
                                        }
                                        className="text-xs text-zinc-400 hover:text-red-600"
                                      >
                                        Remove
                                      </button>
                                    </div>
                                    <div className="divide-y divide-zinc-50">
                                      {sec.lines.length === 0 && (
                                        <div className="px-3 py-3 text-xs text-zinc-400">
                                          No line items
                                        </div>
                                      )}
                                      {sec.lines.map((line) => (
                                        <div
                                          key={line.id}
                                          className="flex items-center gap-2 px-3 py-2"
                                        >
                                          <input
                                            value={line.label}
                                            placeholder="RCV, estimate, discount…"
                                            onChange={(e) =>
                                              setFinancialWorksheet((w) => ({
                                                ...w,
                                                sections: w.sections.map((s) =>
                                                  s.id === sec.id
                                                    ? {
                                                        ...s,
                                                        lines: s.lines.map(
                                                          (l) =>
                                                            l.id === line.id
                                                              ? {
                                                                  ...l,
                                                                  label:
                                                                    e.target
                                                                      .value,
                                                                }
                                                              : l
                                                        ),
                                                      }
                                                    : s
                                                ),
                                              }))
                                            }
                                            className="flex-1 border border-zinc-200 rounded-lg px-2 py-1.5 text-sm"
                                          />
                                          <input
                                            type="number"
                                            step="0.01"
                                            value={
                                              line.amount
                                                ? String(line.amount)
                                                : ''
                                            }
                                            onChange={(e) =>
                                              setFinancialWorksheet((w) =>
                                                withAutoApproved({
                                                  ...w,
                                                  sections: w.sections.map(
                                                    (s) =>
                                                      s.id === sec.id
                                                        ? {
                                                            ...s,
                                                            lines: s.lines.map(
                                                              (l) =>
                                                                l.id === line.id
                                                                  ? {
                                                                      ...l,
                                                                      amount:
                                                                        parseFloat(
                                                                          e
                                                                            .target
                                                                            .value
                                                                        ) || 0,
                                                                    }
                                                                  : l
                                                            ),
                                                          }
                                                        : s
                                                  ),
                                                })
                                              )
                                            }
                                            className="w-28 border border-zinc-200 rounded-lg px-2 py-1.5 text-sm text-right"
                                          />
                                          <button
                                            type="button"
                                            onClick={() =>
                                              setFinancialWorksheet((w) =>
                                                withAutoApproved({
                                                  ...w,
                                                  sections: w.sections.map(
                                                    (s) =>
                                                      s.id === sec.id
                                                        ? {
                                                            ...s,
                                                            lines:
                                                              s.lines.filter(
                                                                (l) =>
                                                                  l.id !==
                                                                  line.id
                                                              ),
                                                          }
                                                        : s
                                                  ),
                                                })
                                              )
                                            }
                                            className="text-xs text-zinc-400 hover:text-red-600"
                                          >
                                            ✕
                                          </button>
                                        </div>
                                      ))}
                                    </div>
                                    <div className="px-3 py-2 border-t border-zinc-100 flex justify-between text-xs text-zinc-500">
                                      <span>Subtotal</span>
                                      <span className="font-semibold text-zinc-800 tabular-nums">
                                        $
                                        {sub.toLocaleString(undefined, {
                                          minimumFractionDigits: 2,
                                          maximumFractionDigits: 2,
                                        })}
                                      </span>
                                    </div>
                                  </div>
                                );
                              })}
                              {financialWorksheet.sections.length > 0 && (
                                <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 flex justify-between text-sm">
                                  <span className="font-semibold text-zinc-800">
                                    Grand total
                                  </span>
                                  <span className="font-semibold text-zinc-900 tabular-nums">
                                    $
                                    {jobSectionsTotal(
                                      financialWorksheet.sections
                                    ).toLocaleString(undefined, {
                                      minimumFractionDigits: 2,
                                      maximumFractionDigits: 2,
                                    })}
                                  </span>
                                </div>
                              )}
                            </div>
                            <div className="space-y-3">
                              <div className="rounded-2xl border-2 border-sky-700 bg-white p-4">
                                <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
                                  Approved job value
                                </div>
                                <div className="text-xl font-semibold text-zinc-900 tabular-nums">
                                  $
                                  {(
                                    financialWorksheet.approvedJobValue || 0
                                  ).toLocaleString(undefined, {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 2,
                                  })}
                                </div>
                                <p className="mt-1.5 text-[11px] text-zinc-400">
                                  Auto from worksheet grand total
                                </p>
                              </div>
                              <div className="rounded-2xl border border-zinc-200 bg-white p-4">
                                <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
                                  Collected
                                </div>
                                <input
                                  type="number"
                                  step="0.01"
                                  value={
                                    financialWorksheet.collected
                                      ? String(financialWorksheet.collected)
                                      : ''
                                  }
                                  onChange={(e) =>
                                    setFinancialWorksheet((w) => ({
                                      ...w,
                                      collected:
                                        parseFloat(e.target.value) || 0,
                                    }))
                                  }
                                  className="w-full text-lg font-semibold text-zinc-900 border-0 p-0 focus:outline-none"
                                  placeholder="0.00"
                                />
                              </div>
                              <div className="rounded-2xl border border-zinc-200 bg-white p-4">
                                <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
                                  Balance due
                                </div>
                                <div className="text-lg font-semibold text-zinc-900 tabular-nums">
                                  $
                                  {(
                                    (financialWorksheet.approvedJobValue ||
                                      0) -
                                    (financialWorksheet.collected || 0)
                                  ).toLocaleString(undefined, {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 2,
                                  })}
                                </div>
                              </div>
                              <div className="rounded-2xl border border-zinc-200 bg-white p-4">
                                <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
                                  Notes
                                </div>
                                <textarea
                                  value={financialWorksheet.notes || ''}
                                  onChange={(e) =>
                                    setFinancialWorksheet((w) => ({
                                      ...w,
                                      notes: e.target.value,
                                    }))
                                  }
                                  rows={3}
                                  className="w-full text-sm border-0 p-0 focus:outline-none resize-none"
                                  placeholder="Supplement pending, etc."
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {profileTab === 'insurance' && (
                        <section className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6">
                          <h2 className="text-lg font-semibold text-zinc-900 mb-1">
                            Insurance claim
                          </h2>
                          <p className="text-sm text-zinc-500 mb-5">
                            Full claim details for this property.
                          </p>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                              <div className={labelClass}>Insurance company</div>
                              <input
                                value={insuranceCompany}
                                onChange={(e) => setInsuranceCompany(e.target.value)}
                                className={fieldClass}
                              />
                            </div>
                            <div>
                              <div className={labelClass}>Claim number</div>
                              <input
                                value={claimNumber}
                                onChange={(e) => setClaimNumber(e.target.value)}
                                className={fieldClass}
                              />
                            </div>
                            <div>
                              <div className={labelClass}>Date of loss</div>
                              <input
                                type="date"
                                value={dateOfLoss}
                                onChange={(e) => setDateOfLoss(e.target.value)}
                                className={fieldClass}
                              />
                            </div>
                            <div>
                              <div className={labelClass}>Policy number</div>
                              <input
                                value={policyNumber}
                                onChange={(e) => setPolicyNumber(e.target.value)}
                                className={fieldClass}
                              />
                            </div>
                            <div className="sm:col-span-2">
                              <div className={labelClass}>Damage location</div>
                              <input
                                value={damageLocation}
                                onChange={(e) => setDamageLocation(e.target.value)}
                                className={fieldClass}
                                placeholder="e.g. entire roof, rear slope, etc."
                              />
                            </div>
                            <div className="sm:col-span-2">
                              <label className="flex items-center gap-2 text-sm text-zinc-700">
                                <input
                                  type="checkbox"
                                  checked={claimFiled}
                                  onChange={(e) => setClaimFiled(e.target.checked)}
                                  className="w-4 h-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-400"
                                />
                                Claim has been filed
                              </label>
                            </div>
                            <div>
                              <div className={labelClass}>Adjuster name</div>
                              <input
                                value={adjusterName}
                                onChange={(e) => setAdjusterName(e.target.value)}
                                className={fieldClass}
                              />
                            </div>
                            <div>
                              <div className={labelClass}>Adjuster phone</div>
                              <PhoneInput
                                value={adjusterPhone}
                                onChange={setAdjusterPhone}
                                className={fieldClass}
                                placeholder="(480) 555-0100"
                              />
                            </div>
                            <div>
                              <div className={labelClass}>Adjuster email</div>
                              <input
                                value={adjusterEmail}
                                onChange={(e) => setAdjusterEmail(e.target.value)}
                                className={fieldClass}
                                inputMode="email"
                              />
                            </div>
                            <div className="flex items-end pb-1">
                              <label className="flex items-center gap-2 text-sm text-zinc-700">
                                <input
                                  type="checkbox"
                                  checked={metAdjuster}
                                  onChange={(e) => setMetAdjuster(e.target.checked)}
                                  className="w-4 h-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-400"
                                />
                                Met with adjuster
                              </label>
                            </div>
                          </div>
                        </section>
                      )}

                      {profileTab === 'notes' && (
                        <section className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6">
                          <h2 className="text-lg font-semibold text-zinc-900 mb-1">
                            Notes / timeline
                          </h2>
                          <p className="text-sm text-zinc-500 mb-5">
                            Chronological activity for this lead.
                          </p>
                          <div className="flex flex-col sm:flex-row gap-2 mb-6">
                            <input
                              value={leadNoteDraft}
                              onChange={(e) => setLeadNoteDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  addLeadNote();
                                }
                              }}
                              placeholder="Add a note about this lead..."
                              className={`${fieldClass} flex-1`}
                            />
                            <button
                              type="button"
                              onClick={addLeadNote}
                              className="btn-primary px-6 py-3 rounded-2xl font-medium shrink-0"
                            >
                              Add note
                            </button>
                          </div>
                          <div className="space-y-3">
                            {profileNotes.length > 0 ? (
                              [...profileNotes].reverse().map((note, reverseIndex) => {
                                const noteIndex =
                                  profileNotes.length - 1 - reverseIndex;
                                return (
                                <div
                                  key={`${note.date}-${noteIndex}`}
                                  className="relative pl-6 border-l-2 border-zinc-200"
                                >
                                  <div className="absolute -left-[7px] top-1.5 w-3 h-3 rounded-full bg-zinc-400 border-2 border-white shadow" />
                                  <div className="bg-zinc-100 rounded-2xl p-4 text-sm">
                                    <div className="flex items-start justify-between gap-2 mb-1">
                                      <div className="text-zinc-500 text-xs font-medium">
                                        {note.date}
                                      </div>
                                      <button
                                        type="button"
                                        onClick={() => removeLeadNote(noteIndex)}
                                        className="text-xs font-semibold text-red-600 hover:text-red-700 shrink-0"
                                      >
                                        Delete
                                      </button>
                                    </div>
                                    <div className="whitespace-pre-wrap text-zinc-800">
                                      {note.text}
                                    </div>
                                  </div>
                                </div>
                                );
                              })
                            ) : (
                              <div className="text-zinc-400 py-10 text-center rounded-2xl border border-dashed border-zinc-200">
                                No notes yet — add the first update above.
                              </div>
                            )}
                          </div>
                        </section>
                      )}

                      {profileTab === 'estimates' && (
                        <section className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6">
                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-5">
                            <div>
                              <h2 className="text-lg font-semibold text-zinc-900">
                                Saved estimates
                              </h2>
                              <p className="text-sm text-zinc-500 mt-0.5">
                                Estimates use this lead&apos;s contact info. Create or open one
                                below.
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                startNewEstimate({ fromLeadId: currentLeadId })
                              }
                              className="btn-primary px-4 py-2.5 rounded-2xl text-sm font-semibold"
                            >
                              New estimate
                            </button>
                          </div>
                          {profileEstimates.length > 0 ? (
                            <div className="space-y-3">
                              {profileEstimates.map((est, index) => (
                                <div
                                  key={est.id ?? index}
                                  className="w-full border border-zinc-200 rounded-2xl p-5 hover:border-sky-300 hover:bg-zinc-100 transition-colors"
                                >
                                  <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
                                    <button
                                      type="button"
                                      className="text-left min-w-0 flex-1"
                                      onClick={() => loadEstimate(est)}
                                    >
                                      <div className="font-medium text-zinc-900">
                                        Estimate · {est.date}
                                      </div>
                                      <div className="text-sm text-zinc-500 mt-0.5">
                                        {est.squares || 0} squares ·{' '}
                                        {est.selectedShingle || 'No shingle'}
                                      </div>
                                    </button>
                                    <div className="flex items-center gap-3 shrink-0">
                                      <div className="text-xl font-semibold text-zinc-900">
                                        $
                                        {(
                                          est.negotiatedPrice ||
                                          est.total ||
                                          0
                                        ).toLocaleString()}
                                      </div>
                                      <button
                                        type="button"
                                        onClick={() => removeLeadEstimate(est.id)}
                                        className="text-xs font-semibold text-red-600 hover:text-red-700 px-2 py-1"
                                      >
                                        Delete
                                      </button>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="text-zinc-400 py-10 text-center rounded-2xl border border-dashed border-zinc-200">
                              No estimates saved yet.
                            </div>
                          )}
                        </section>
                      )}

                      {profileTab === 'photos' && (
                        <section className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6">
                          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-5">
                            <div>
                              <h2 className="text-lg font-semibold text-zinc-900">Photos</h2>
                            </div>
                            {profilePhotos.length > 0 && (
                              <div className="text-sm font-medium text-zinc-600 bg-zinc-100 border border-zinc-200 rounded-xl px-3 py-1.5 self-start">
                                {profilePhotos.length.toLocaleString()} photo
                                {profilePhotos.length !== 1 ? 's' : ''}
                              </div>
                            )}
                          </div>

                          <input
                            ref={photoInputRef}
                            type="file"
                            accept="image/*,.heic,.heif,image/heic,image/heif"
                            multiple
                            className="hidden"
                            onChange={(e) => {
                              if (e.target.files?.length) {
                                void handlePhotoFiles(e.target.files);
                                e.target.value = '';
                              }
                            }}
                          />
                          <input
                            ref={photoCameraInputRef}
                            type="file"
                            accept="image/*"
                            capture="environment"
                            className="hidden"
                            onChange={(e) => {
                              if (e.target.files?.length) {
                                void handlePhotoFiles(e.target.files);
                                e.target.value = '';
                              }
                            }}
                          />

                          <div
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                if (!photosUploading) photoInputRef.current?.click();
                              }
                            }}
                            onClick={() => {
                              if (!photosUploading) photoInputRef.current?.click();
                            }}
                            onDragEnter={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setPhotoDragOver(true);
                            }}
                            onDragOver={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setPhotoDragOver(true);
                            }}
                            onDragLeave={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setPhotoDragOver(false);
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setPhotoDragOver(false);
                              if (e.dataTransfer.files?.length) {
                                void handlePhotoFiles(e.dataTransfer.files);
                              }
                            }}
                            className={`rounded-3xl border-2 border-dashed px-6 py-8 sm:py-12 text-center cursor-pointer transition-colors ${
                              photoDragOver
                                ? 'border-slate-400 bg-slate-50/90 ring-1 ring-slate-300/30'
                                : 'border-zinc-200 bg-zinc-100 hover:border-sky-300'
                            } ${photosUploading ? 'opacity-70 pointer-events-none' : ''}`}
                          >
                            <div className="font-medium text-zinc-800">
                              {photosUploading
                                ? 'Uploading photos...'
                                : 'Drag and drop photos here'}
                            </div>
                            <div className="text-sm text-zinc-500 mt-1">
                              Select many images at once — grid scales for large albums
                            </div>
                            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                              <button
                                type="button"
                                disabled={photosUploading}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (!photosUploading) {
                                    photoCameraInputRef.current?.click();
                                  }
                                }}
                                className="px-5 py-2.5 rounded-2xl text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                              >
                                {photosUploading ? 'Working…' : 'Take photo'}
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openPhotoReportBuilder();
                                }}
                                className="px-4 py-2.5 rounded-2xl text-sm font-semibold border border-sky-300 bg-sky-50 text-sky-900 hover:bg-sky-100"
                              >
                                Create report
                              </button>
                              <button
                                type="button"
                                disabled={photosUploading}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  photoInputRef.current?.click();
                                }}
                                className="btn-primary px-5 py-2.5 rounded-2xl text-sm font-medium disabled:opacity-50"
                              >
                                {photosUploading ? 'Working…' : 'Upload photos'}
                              </button>
                            </div>
                          </div>

                          {profilePhotos.length > 0 ? (
                            <div className="mt-6">
                              <div className="flex items-center justify-between mb-3">
                                <div className="text-sm text-zinc-500">
                                  Thumbnail grid · tap to enlarge · Remove to delete
                                </div>
                              </div>
                              {/* Dense grid so hundreds of thumbs stay browsable */}
                              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-1.5 sm:gap-2 max-h-[min(70vh,720px)] overflow-y-auto overscroll-contain p-0.5 rounded-2xl">
                                {profilePhotos.map((photo) => (
                                  <div
                                    key={photo.id}
                                    className="group relative aspect-square rounded-xl overflow-hidden border border-zinc-200 bg-zinc-100"
                                  >
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                      src={photo.url || photo.dataUrl || ''}
                                      alt={photo.name}
                                      loading="lazy"
                                      decoding="async"
                                      className="w-full h-full object-cover cursor-pointer"
                                      onClick={() => setLightboxPhoto(photo)}
                                    />
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        removeLeadPhoto(photo.id);
                                      }}
                                      className="absolute top-1 right-1 px-2 h-7 rounded-full bg-zinc-900/70 text-white text-[10px] font-medium leading-none opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity hover:bg-zinc-700 flex items-center"
                                      aria-label={`Remove ${photo.name}`}
                                    >
                                      Remove
                                    </button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div className="mt-6 text-zinc-400 py-8 text-center text-sm">
                              No photos yet.
                            </div>
                          )}
                        </section>
                      )}

                      {profileTab === 'documents' && (
                        <section className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6">
                          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-5">
                            <div>
                              <h2 className="text-lg font-semibold text-zinc-900">
                                Documents
                              </h2>
                              <p className="text-sm text-zinc-500 mt-0.5">
                                Contracts, insurance letters, PDFs…
                              </p>
                            </div>
                            {profileDocuments.length > 0 && (
                              <div className="text-sm font-medium text-zinc-600 bg-zinc-100 border border-zinc-200 rounded-xl px-3 py-1.5 self-start">
                                {profileDocuments.length.toLocaleString()} document
                                {profileDocuments.length !== 1 ? 's' : ''}
                              </div>
                            )}
                          </div>

                          <input
                            ref={docInputRef}
                            type="file"
                            multiple
                            accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.heic,.txt,.csv,application/pdf"
                            className="hidden"
                            onChange={(e) => {
                              if (e.target.files?.length) {
                                void handleDocFiles(e.target.files);
                                e.target.value = '';
                              }
                            }}
                          />

                          <div className="mb-4 relative">
                            <button
                              type="button"
                              disabled={docsUploading}
                              onClick={() => setDocAddMenuOpen((o) => !o)}
                              className="px-5 py-2.5 rounded-2xl text-sm font-medium bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50"
                            >
                              {docsUploading ? 'Uploading…' : '+ Add'}
                            </button>
                            {docAddMenuOpen && (
                              <div className="absolute left-0 sm:left-auto sm:right-0 mt-2 w-64 rounded-2xl border border-zinc-200 bg-white shadow-lg z-20 py-1">
                                <button
                                  type="button"
                                  className="w-full text-left px-4 py-2.5 text-sm text-zinc-800 hover:bg-sky-50"
                                  onClick={() => {
                                    setDocAddMenuOpen(false);
                                    docInputRef.current?.click();
                                  }}
                                >
                                  Upload file
                                </button>
                                <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-wide text-zinc-400">
                                  From system
                                </div>
                                {SYSTEM_DOCUMENTS.map((doc) => (
                                  <button
                                    key={doc.id}
                                    type="button"
                                    className="w-full text-left px-4 py-2.5 text-sm text-zinc-800 hover:bg-sky-50"
                                    onClick={() => {
                                      setDocAddMenuOpen(false);
                                      if (doc.id === 'takeoff') {
                                        setProfileTab('takeoff');
                                        showToast(
                                          'Fill the Take-off sheet, then Save + add to Documents'
                                        );
                                      }
                                    }}
                                  >
                                    <div className="font-medium">{doc.name}</div>
                                    <div className="text-xs text-zinc-500 mt-0.5">
                                      {doc.description}
                                    </div>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>

                          {profileDocuments.length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-zinc-200 px-6 py-12 text-center">
                              <p className="text-sm font-medium text-zinc-800">
                                No documents yet
                              </p>
                              <p className="text-sm text-zinc-500 mt-2">
                                PDFs and signed paperwork will appear here.
                              </p>
                            </div>
                          ) : (
                            <ul className="space-y-2">
                              {profileDocuments.map((doc) => (
                                <li
                                  key={doc.id}
                                  className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white px-3 py-2.5"
                                >
                                  <div className="min-w-0">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const isPdf =
                                          doc.mimeType === 'application/pdf' ||
                                          /\.pdf$/i.test(doc.name);
                                        if (isPdf) {
                                          setMeasurementPdfUrl(doc.url);
                                          setMeasurementPdfName(doc.name);
                                        } else {
                                          window.open(doc.url, '_blank', 'noopener,noreferrer');
                                        }
                                      }}
                                      className="text-sm font-medium text-emerald-700 hover:underline truncate block text-left w-full"
                                    >
                                      {doc.name}
                                    </button>
                                    <div className="text-xs text-zinc-400 mt-0.5">
                                      {doc.createdAt}
                                      {doc.size != null
                                        ? ` · ${
                                            doc.size < 1024 * 1024
                                              ? `${Math.max(1, Math.round(doc.size / 1024))} KB`
                                              : `${(doc.size / (1024 * 1024)).toFixed(1)} MB`
                                          }`
                                        : ''}
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => removeLeadDocument(doc.id)}
                                    className="text-xs text-zinc-500 hover:text-red-600 shrink-0 px-2 py-1"
                                  >
                                    Remove
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}

                        </section>
                      )}

                      {profileTab === 'takeoff' && (
                        <section className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6">
                          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-5">
                            <div>
                              <h2 className="text-lg font-semibold text-zinc-900">
                                Take-off
                              </h2>
                              <p className="text-sm text-zinc-500 mt-0.5">
                                Site inspection sheet — roof, penetrations, and
                                interior notes.
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                onClick={() => saveTakeoff(false)}
                                className="px-4 py-2 rounded-xl bg-sky-600 text-white text-sm font-medium hover:bg-sky-700"
                              >
                                Save take-off
                              </button>
                              <button
                                type="button"
                                onClick={() => saveTakeoff(true)}
                                className="px-4 py-2 rounded-xl border border-zinc-200 bg-white text-sm font-medium text-zinc-800 hover:border-sky-300"
                              >
                                Save + add to Documents
                              </button>
                            </div>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {TAKEOFF_FIELD_LABELS.map(({ key, label }) =>
                              key === 'notes' ? (
                                <div key={key} className="md:col-span-2">
                                  <label className="text-xs text-zinc-500 mb-1 block">
                                    {label}
                                  </label>
                                  <textarea
                                    value={takeoffForm[key]}
                                    onChange={(e) =>
                                      setTakeoffForm((f) => ({
                                        ...f,
                                        [key]: e.target.value,
                                      }))
                                    }
                                    rows={3}
                                    className="w-full border border-zinc-200 rounded-xl px-3 py-2 text-sm text-zinc-900"
                                  />
                                </div>
                              ) : (
                                <div key={key}>
                                  <label className="text-xs text-zinc-500 mb-1 block">
                                    {label}
                                  </label>
                                  <input
                                    value={takeoffForm[key]}
                                    onChange={(e) =>
                                      setTakeoffForm((f) => ({
                                        ...f,
                                        [key]: e.target.value,
                                      }))
                                    }
                                    className="w-full border border-zinc-200 rounded-xl px-3 py-2 text-sm text-zinc-900"
                                  />
                                </div>
                              )
                            )}
                          </div>
                        </section>
                      )}

                    </div>
                  </div>

                  {/* Mobile sticky save — sits under app header chrome */}
                  <div className="sm:hidden sticky bottom-0 bg-white/95 backdrop-blur border-t border-zinc-200 p-3 z-20">
                    <button
                      type="button"
                      onClick={saveLeadProfile}
                      className="btn-primary w-full py-3.5 rounded-2xl font-semibold"
                    >
                      Save
                    </button>
                  </div>

                  {/* Photo lightbox */}
                  
      {photoReportOpen && currentLeadId != null && (() => {
        const lead = leads.find((l) => l.id === currentLeadId);
        const photos = lead?.photos || [];
        return (
          <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-6">
            <div className="bg-white w-full sm:max-w-2xl max-h-[92vh] overflow-hidden rounded-t-3xl sm:rounded-3xl shadow-xl flex flex-col">
              <div className="sticky top-0 bg-white border-b border-zinc-100 px-5 py-4 flex items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-lg text-zinc-900">Photo report</div>
                  <div className="text-xs text-zinc-500">Select photos, add captions, download PDF</div>
                </div>
                <button
                  type="button"
                  onClick={() => setPhotoReportOpen(false)}
                  className="text-sm text-zinc-500 hover:text-zinc-800 px-2 py-1"
                >
                  Close
                </button>
              </div>
              <div className="px-5 py-3 border-b border-zinc-50">
                <input
                  value={photoReportTitle}
                  onChange={(e) => setPhotoReportTitle(e.target.value)}
                  className="w-full border border-zinc-200 rounded-2xl px-4 py-2.5 text-sm text-zinc-900"
                  placeholder="Report title"
                />
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
                {photos.map((p) => {
                  const on = photoReportSelected.includes(p.id);
                  const src = p.url || p.dataUrl || '';
                  return (
                    <div
                      key={p.id}
                      className={`flex gap-3 p-3 rounded-2xl border ${
                        on ? 'border-sky-400 bg-sky-50/50' : 'border-zinc-200 bg-white'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => togglePhotoInReport(p.id)}
                        className="shrink-0 w-20 h-20 rounded-xl overflow-hidden bg-zinc-100 border border-zinc-200"
                      >
                        {src ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={src} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-[10px] text-zinc-400">
                            No preview
                          </div>
                        )}
                      </button>
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs text-zinc-500 truncate">{p.name}</div>
                          <button
                            type="button"
                            onClick={() => togglePhotoInReport(p.id)}
                            className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${
                              on
                                ? 'border-sky-400 bg-sky-50 text-sky-800'
                                : 'border-zinc-200 text-zinc-500'
                            }`}
                          >
                            {on ? 'In report' : 'Add'}
                          </button>
                        </div>
                        {on && (
                          <textarea
                            value={photoReportCaptions[p.id] || ''}
                            onChange={(e) =>
                              setPhotoReportCaptions((prev) => ({
                                ...prev,
                                [p.id]: e.target.value,
                              }))
                            }
                            rows={2}
                            placeholder="Caption / description..."
                            className="w-full border border-zinc-200 rounded-xl px-3 py-2 text-sm text-zinc-900 resize-none"
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="sticky bottom-0 border-t border-zinc-100 bg-white px-5 py-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => setPhotoReportOpen(false)}
                  className="flex-1 py-3 rounded-2xl text-sm font-semibold border border-zinc-200 text-zinc-700"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={photoReportBusy || photoReportSelected.length === 0}
                  onClick={() => void generatePhotoReportPdf()}
                  className="flex-1 py-3 rounded-2xl text-sm font-semibold btn-primary disabled:opacity-50"
                >
                  {photoReportBusy ? 'Building…' : 'Save report'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      
      {measurementPdfUrl && (
        <div className="fixed inset-0 z-[85] flex flex-col bg-black/50">
          <div className="flex items-center justify-between gap-3 px-4 py-3 bg-white border-b border-zinc-200">
            <div className="font-semibold text-zinc-900 truncate">{measurementPdfName || 'Measurement report'}</div>
            <div className="flex gap-2 shrink-0">
              <a
                href={measurementPdfUrl}
                target="_blank"
                rel="noreferrer"
                className="px-3 py-1.5 rounded-xl text-sm font-semibold border border-zinc-200 text-zinc-700"
              >
                Open tab
              </a>
              <button
                type="button"
                onClick={() => {
                  setMeasurementPdfUrl(null);
                  setMeasurementPdfName('');
                }}
                className="px-3 py-1.5 rounded-xl text-sm font-semibold bg-zinc-900 text-white"
              >
                Close
              </button>
            </div>
          </div>
          <iframe
            title="Measurement PDF"
            src={measurementPdfUrl}
            className="flex-1 w-full bg-zinc-100"
          />
        </div>
      )}

      {lightboxPhoto && (
                    <div
                      className="fixed inset-0 z-[70] bg-black/90 flex items-center justify-center p-4"
                      onClick={() => setLightboxPhoto(null)}
                    >
                      <button
                        type="button"
                        className="absolute top-4 right-4 px-3 h-10 rounded-full bg-white/10 text-white text-sm font-medium hover:bg-white/20"
                        onClick={() => setLightboxPhoto(null)}
                        aria-label="Close"
                      >
                        Close
                      </button>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={lightboxPhoto.url || lightboxPhoto.dataUrl || ''}
                        alt={lightboxPhoto.name}
                        className="max-w-full max-h-[85vh] object-contain rounded-lg"
                        onClick={(e) => e.stopPropagation()}
                      />
                      <div className="absolute bottom-6 left-0 right-0 text-center text-white/80 text-sm px-4">
                        {lightboxPhoto.name}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
      </div>
      )}
      </div>
    </div>
  );
}