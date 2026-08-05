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
import {
  loadCloudCompanySettings,
  loadCloudUserProfile,
  saveCloudCompanySettings,
  saveCloudUserProfile,
  loadCloudCalendarEvents,
  saveCloudCalendarEvents,
  loadCloudTasksBundle,
  saveCloudTasksBundle,
} from '@/lib/app-settings-sync';
import {
  createDefaultTaskList,
  DEFAULT_TASK_LIST_ID,
  newSummitTaskId,
  newSummitTaskListId,
  type SummitTask,
  type SummitTaskList,
} from '@/lib/google-tasks';
import {
  SUMMIT_CALENDAR_EVENTS_KEY,
  newSummitCalendarEventId,
  normalizeStoredCalendarEvents,
  mergeGoogleCalendarEventsIntoLocal,
  eventOccursOnDay,
  formatEventTimeLabel,
  defaultEndTime,
  leadDisplayFromParts,
  minutesFromMidnight,
  minutesToHhmm,
  snapMinutes,
  formatHourLabel,
  WEEK_VIEW_HOUR_PX,
  WEEK_VIEW_HOURS,
  WEEK_VIEW_SCROLL_HOUR,
  WEEK_VIEW_MIN_EVENT_PX,
  GOOGLE_EVENT_COLORS,
  GOOGLE_CALENDAR_DEFAULT_COLOR,
  eventChipColorStyle,
  eventBlockColorStyle,
  normalizeGoogleEventColorId,
  layoutOverlappingTimedEvents,
  timedEventMinutesOnDay,
  type GoogleEventColorId,
  type SummitCalendarEvent,
  type CalendarListColor,
} from '@/lib/summit-calendar';

const SUMMIT_CALENDAR_VIEW_KEY = 'summitCalendarView';
type CalendarViewMode = 'month' | 'week' | 'day';

function readStoredCalendarView(): CalendarViewMode {
  if (typeof window === 'undefined') return 'month';
  try {
    const v = localStorage.getItem(SUMMIT_CALENDAR_VIEW_KEY);
    if (v === 'week' || v === 'month' || v === 'day') return v;
  } catch {
    /* ignore */
  }
  return 'month';
}

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
  | 'tasks'
  | 'performance'
  | 'tools'
  | 'documents'
  | 'settings';
/** Customer estimate form vs internal financials (inside lead profile). */
type EstimateWorkspace = 'estimate' | 'internal';
/** Mitigation invoice form vs internal margin calc (no buffer). */
type MitigationWorkspace = 'invoice' | 'internal';

/** Primary app destinations (sidebar). Estimator stays lead-profile only. */
const APP_TABS: AppTab[] = [
  'home',
  'leads',
  'estimates',
  'invoices',
  'calendar',
  'tasks',
  'performance',
  'tools',
  'documents',
  'settings',
];

const SUMMIT_TASKS_KEY = 'summitTasks';
const SUMMIT_TASK_LISTS_KEY = 'summitTaskLists';
const SUMMIT_ACTIVE_TASK_LIST_KEY = 'summitActiveTaskListId';

function normalizeStoredTasks(raw: unknown): SummitTask[] {
  if (!Array.isArray(raw)) return [];
  const out: SummitTask[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Partial<SummitTask>;
    const title = typeof t.title === 'string' ? t.title.trim() : '';
    if (!title) continue;
    const id =
      typeof t.id === 'string' && t.id
        ? t.id
        : newSummitTaskId();
    const dueDate =
      typeof t.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate)
        ? t.dueDate
        : undefined;
    const now = new Date().toISOString();
    const listId =
      typeof t.listId === 'string' && t.listId.trim()
        ? t.listId.trim()
        : DEFAULT_TASK_LIST_ID;
    out.push({
      id,
      title,
      notes: typeof t.notes === 'string' && t.notes.trim() ? t.notes : undefined,
      dueDate,
      completed: Boolean(t.completed),
      completedAt:
        typeof t.completedAt === 'string' ? t.completedAt : undefined,
      googleTaskId:
        typeof t.googleTaskId === 'string' ? t.googleTaskId : undefined,
      listId,
      updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : now,
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : now,
    });
  }
  return out;
}

function normalizeStoredTaskLists(raw: unknown): SummitTaskList[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [createDefaultTaskList()];
  }
  const out: SummitTaskList[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const l = item as Partial<SummitTaskList>;
    const title = typeof l.title === 'string' ? l.title.trim() : '';
    if (!title) continue;
    const id =
      typeof l.id === 'string' && l.id.trim()
        ? l.id.trim()
        : newSummitTaskListId();
    const now = new Date().toISOString();
    out.push({
      id,
      title,
      googleListId:
        typeof l.googleListId === 'string' && l.googleListId.trim()
          ? l.googleListId.trim()
          : undefined,
      createdAt: typeof l.createdAt === 'string' ? l.createdAt : now,
      updatedAt: typeof l.updatedAt === 'string' ? l.updatedAt : now,
    });
  }
  if (out.length === 0) return [createDefaultTaskList()];
  if (!out.some((l) => l.id === DEFAULT_TASK_LIST_ID)) {
    // Keep a default slot so legacy tasks with listId "default" stay valid
    out.unshift(createDefaultTaskList());
  }
  return out;
}

const NEGOTIATION_BUFFER_CAP = 3500;
/** Mitigation discount room off list sell total (small field discounts). */
const MITIGATION_BUFFER_CAP = 500;
/** Desktop sidebar widths — expanded labels vs icon rail */
const SIDEBAR_WIDTH_EXPANDED = '15.5rem';
const SIDEBAR_WIDTH_COLLAPSED = '4.25rem';
const SIDEBAR_COLLAPSED_KEY = 'summitSidebarCollapsed';

const DEFAULT_USER_PROFILE = {
  name: '',
  title: '',
  company: '',
  phone: '',
  email: '',
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
  /** Saved estimate PDF (owned by Estimates — not duplicated in Documents) */
  pdfDocumentId?: string;
  pdfUrl?: string;
  pdfName?: string;
};

type LeadNote = {
  /** Stable id for list keys (older notes may omit until normalized) */
  id?: string;
  text: string;
  date: string;
  createdAt?: string;
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
    name: 'Take off sheet',
    description: '',
  },
  {
    id: 'pricing',
    name: 'Company pricing',
    description: '',
  },
  {
    id: 'mitigation',
    name: 'Mitigation invoice',
    description: '',
  },
  {
    id: 'emergency',
    name: 'Mitigation Service Agreement',
    description: 'Mitigation only · separate PDF',
  },
] as const;

/** Company / billing entity — filled in Settings (empty until configured). */
type CompanySettings = {
  /** Company display name (headers, nav when set). Was `brandName`. */
  company: string;
  /** Project manager name on estimates. Was `legalName`. */
  projectManager: string;
  /** Project manager phone on estimates. */
  projectManagerPhone: string;
  /** Project manager email on estimates / company docs (optional). */
  projectManagerEmail: string;
  /** Business address */
  address: string;
  /** Office phone */
  phone: string;
  /** Business fax */
  fax: string;
  /** Kept for older PDFs / localStorage; not shown in Settings. */
  email: string;
  /** ROC# */
  license: string;
  /**
   * Company logo: data URL (local preview) or public Storage URL after sync.
   * Empty → Summit mark.
   */
  logoDataUrl: string;
  /** Supabase Storage path in company-assets when logo is cloud-backed. */
  logoPath?: string;
};

const emptyCompanySettings = (): CompanySettings => ({
  company: '',
  projectManager: '',
  projectManagerPhone: '',
  projectManagerEmail: '',
  address: '',
  phone: '',
  fax: '',
  email: '',
  license: '',
  logoDataUrl: '',
  logoPath: '',
});

/** Normalize company settings from localStorage (supports legacy brandName/legalName). */
function normalizeCompanySettings(
  raw: Partial<CompanySettings> & {
    brandName?: string;
    legalName?: string;
  }
): CompanySettings {
  // New keys first; brandName → company. Legacy legalName was company entity text —
  // fold into company only when company is still empty (do not treat as PM name).
  const company =
    (typeof raw.company === 'string' && raw.company) ||
    (typeof raw.brandName === 'string' && raw.brandName) ||
    (typeof raw.legalName === 'string' && raw.legalName) ||
    '';
  const projectManager =
    typeof raw.projectManager === 'string' ? raw.projectManager : '';
  return {
    company,
    projectManager,
    projectManagerPhone:
      typeof raw.projectManagerPhone === 'string' ? raw.projectManagerPhone : '',
    projectManagerEmail:
      typeof raw.projectManagerEmail === 'string'
        ? raw.projectManagerEmail
        : '',
    address: typeof raw.address === 'string' ? raw.address : '',
    phone: typeof raw.phone === 'string' ? raw.phone : '',
    fax: typeof raw.fax === 'string' ? raw.fax : '',
    email: typeof raw.email === 'string' ? raw.email : '',
    license: typeof raw.license === 'string' ? raw.license : '',
    logoDataUrl: typeof raw.logoDataUrl === 'string' ? raw.logoDataUrl : '',
    logoPath: typeof raw.logoPath === 'string' ? raw.logoPath : '',
  };
}

/** Merge cloud company settings over local cache (cloud wins non-empty fields). */
function mergeCompanySettings(
  local: CompanySettings,
  cloud: CompanySettings | null
): CompanySettings {
  if (!cloud) return local;
  const pick = (c: string, l: string) => (c.trim() ? c : l);
  return {
    company: pick(cloud.company, local.company),
    projectManager: pick(cloud.projectManager, local.projectManager),
    projectManagerPhone: pick(
      cloud.projectManagerPhone,
      local.projectManagerPhone
    ),
    projectManagerEmail: pick(
      cloud.projectManagerEmail,
      local.projectManagerEmail
    ),
    address: pick(cloud.address, local.address),
    phone: pick(cloud.phone, local.phone),
    fax: pick(cloud.fax, local.fax),
    email: pick(cloud.email, local.email),
    license: pick(cloud.license, local.license),
    // Prefer cloud logo URL; keep local data URL until first successful Save upload.
    logoDataUrl: pick(cloud.logoDataUrl, local.logoDataUrl),
    logoPath: pick(cloud.logoPath || '', local.logoPath || ''),
  };
}

/** Mitigation billing: personal LLC vs company (ProWest) settings. */
type MitigationEntity = 'roslie' | 'prowest';

type EmergencyAgreementDraft = {
  /** Same billing entity as mitigation invoice (personal vs company). */
  entity: MitigationEntity;
  clientName: string;
  propertyAddress: string;
  phone: string;
  email: string;
  scope: string;
  serviceStart: string;
  serviceComplete: string;
  /** 'cash' | 'insurance' | '' */
  paymentMode: 'cash' | 'insurance' | '';
  paymentAmount: string;
  date: string;
  /** Printed / typed name under signature — hooks for email confirmation later. */
  signerName: string;
  clientSignatureDataUrl: string | null;
  /** ISO timestamp when signature was captured. */
  clientSignedAt: string | null;
};

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

/** Mitigation cost from Supabase mitigation_cost_sheet (internal calc twin) */
type MitigationCostRow = {
  item_key: string;
  label: string;
  category: string;
  unit: string | null;
  cost: number | null;
  notes: string | null;
  sort_order: number | null;
};

const MITIGATION_LINE_GROUPS: {
  group: string;
  items: { itemKey: string; label: string }[];
}[] = [
  {
    group: 'Trip charges',
    items: [
      { itemKey: 'trip_planned', label: 'Planned trip' },
      { itemKey: 'trip_emergency', label: 'Emergency trip' },
      { itemKey: 'trip_additional', label: 'Additional trip' },
    ],
  },
  {
    group: 'Tarps',
    items: [
      { itemKey: 'tarp_6x8', label: 'Tarp 6×8' },
      { itemKey: 'tarp_8x10', label: 'Tarp 8×10' },
      { itemKey: 'tarp_10x12', label: 'Tarp 10×12' },
      { itemKey: 'tarp_12x16', label: 'Tarp 12×16' },
      { itemKey: 'tarp_16x20', label: 'Tarp 16×20' },
      { itemKey: 'tarp_20x30', label: 'Tarp 20×30' },
      { itemKey: 'tarp_30x50', label: 'Tarp 30×50' },
      { itemKey: 'tarp_40x60', label: 'Tarp 40×60' },
    ],
  },
  {
    group: 'Obstruction',
    items: [
      { itemKey: 'obst_pipe_jack', label: 'Pipejack' },
      { itemKey: 'obst_ttop_vent', label: 'T-Top vent' },
      { itemKey: 'obst_hvac', label: 'HVAC unit' },
      { itemKey: 'obst_skylight', label: 'Skylight' },
    ],
  },
  {
    group: 'Install',
    items: [
      { itemKey: 'ridge_install', label: 'On ridge' },
      { itemKey: 'valley_install', label: 'In valley' },
      { itemKey: 'hip_install', label: 'Around hip' },
      { itemKey: 'eave_install', label: 'On eave' },
      { itemKey: 'rake_install', label: 'On rake' },
      { itemKey: 'shingle_tuck', label: 'Shingle tuck' },
      // Fascia edges — same dropdown, distinct from location “On eave / On rake”
      { itemKey: 'fascia_wrap:eave', label: 'Fascia wrap on eave' },
      { itemKey: 'fascia_wrap:rake', label: 'Fascia wrap on rake' },
      { itemKey: 'fascia_wrap:eave_rake', label: 'Fascia wrap on eave and rake' },
    ],
  },
  {
    group: 'Adders',
    items: [
      { itemKey: 'sandbag_25lb', label: 'Sandbag (25 lb)' },
      { itemKey: 'batten_furring_1x2x8', label: 'Batten — furring 1×2×8' },
      { itemKey: 'batten_pt_1x2x8', label: 'Batten — PT 1×2×8' },
      { itemKey: 'batten_select_1x2x8', label: 'Batten — select KD 1×2×8' },
      { itemKey: 'steep_7_12', label: 'Steep charge 7/12+' },
      { itemKey: 'two_plus_story', label: '2+ story' },
      { itemKey: 'adder_extreme_heat', label: 'Extreme heat' },
    ],
  },
];


type MitigationCatalogItem = { itemKey: string; label: string };

/** Fascia wrap edge — not a qty; eave+rake bills 2× rate, labeled clearly. */
type FasciaEdge = 'eave' | 'rake' | 'eave_rake';

/** Customer-facing description for mitigation lines (UI + printable PDF). */
function formatMitigationLineDescription(line: {
  itemKey: string;
  label?: string;
  qty?: number;
  tarpType?: 'blue' | 'brown' | null;
  fasciaEdge?: FasciaEdge | null;
}): string {
  const key = line.itemKey || '';
  const qty = Number(line.qty) || 1;
  const qtyPrefix = qty !== 1 ? `${qty}× ` : '';

  if (key.startsWith('tarp_')) {
    const size = key.replace(/^tarp_/, '').replace(/x/gi, '×');
    const material =
      line.tarpType === 'brown'
        ? 'brown heavy'
        : line.tarpType === 'blue'
          ? 'blue medium'
          : 'tarp';
    return `Installed ${qtyPrefix}${size} ${material} tarp`;
  }

  if (key.startsWith('batten_')) {
    const batten =
      key.includes('furring')
        ? 'furring 1×2×8 battens'
        : key.includes('pt')
          ? 'PT 1×2×8 battens'
          : key.includes('select')
            ? 'select KD 1×2×8 battens'
            : 'battens';
    return `Secured tarp from high winds with ${qtyPrefix}${batten}`;
  }

  if (key === 'fascia_wrap') {
    const where =
      line.fasciaEdge === 'eave'
        ? ' on eave'
        : line.fasciaEdge === 'rake'
          ? ' on rake'
          : line.fasciaEdge === 'eave_rake'
            ? ' on eave and rake'
            : '';
    return `Fascia wrap${where}`;
  }

  if (key === 'hip_install') {
    return qty === 1 ? 'Installed around 1 hip' : `Installed around ${qty} hips`;
  }

  if (key === 'shingle_tuck') {
    return qty !== 1 ? `Shingle tuck × ${qty}` : 'Shingle tuck';
  }

  if (key === 'sandbag_25lb') {
    return qty !== 1
      ? `Sandbags — 25 lb × ${qty}`
      : 'Sandbag — 25 lb';
  }

  if (key.startsWith('obst_') || key === 'obstruction') {
    const kind: Record<string, string> = {
      obst_pipe_jack: 'pipejack',
      obst_pipe: 'pipejack', // legacy
      obst_jack: 'pipejack', // legacy
      obst_ttop_vent: 'T-Top vent',
      obst_vent: 'vent',
      obst_hvac: 'HVAC unit',
      obst_skylight: 'skylight',
      obst_other: 'other',
      obstruction: 'obstruction',
    };
    const what = kind[key] || 'obstruction';
    const base =
      key === 'obstruction'
        ? 'Obstruction manipulation'
        : `Obstruction manipulation — ${what}`;
    return qty !== 1 ? `${base} × ${qty}` : base;
  }

  const narrative: Record<string, string> = {
    trip_planned: 'Planned service trip',
    trip_emergency: 'Emergency service trip',
    trip_additional: 'Additional service trip',
    eave_install: 'Installed on eave',
    rake_install: 'Installed on rake',
    // Legacy combined key (older invoices)
    eave_rake_install: 'Installed on eave / rake',
    ridge_install: 'Installed on ridge',
    valley_install: 'Installed in valley',
    steep_7_12: 'Steep charge 7/12+',
    two_plus_story: '2+ story access',
    adder_extreme_heat: 'Extreme heat adder',
  };

  const base = narrative[key] || line.label || key;
  return qty !== 1 ? `${base} × ${qty}` : base;
}

/** Estimate-style select + Add for non-tarp groups */
function MitigationGroupAddRow({
  items,
  onAdd,
}: {
  items: { itemKey: string; label: string }[];
  onAdd: (itemKey: string, label: string) => void;
}) {
  const [key, setKey] = useState('');
  return (
    <div className="flex items-center gap-2">
      <select
        value={key}
        onChange={(e) => setKey(e.target.value)}
        className="min-w-0 flex-1 border border-zinc-200 rounded-2xl px-3 py-2.5 text-sm text-zinc-900 bg-white"
      >
        <option value="">Select</option>
        {items.map((it) => (
          <option key={it.itemKey} value={it.itemKey}>
            {it.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => {
          const it = items.find((i) => i.itemKey === key);
          if (!it) return;
          onAdd(it.itemKey, it.label);
          setKey('');
        }}
        className="btn-primary shrink-0 px-8 py-3 rounded-full text-sm font-semibold"
      >
        Add
      </button>
    </div>
  );
}

/** Brown heavy only stocked through 20×30 — 30×50 / 40×60 are blue only. */
const BROWN_TARP_SIZES = new Set([
  'tarp_6x8',
  'tarp_8x10',
  'tarp_10x12',
  'tarp_12x16',
  'tarp_16x20',
  'tarp_20x30',
]);

/** Tarp size + blue/brown type (cost only) + Add */
function MitigationTarpAddRow({
  items,
  onAdd,
}: {
  items: { itemKey: string; label: string }[];
  onAdd: (itemKey: string, label: string, tarpType: 'blue' | 'brown') => void;
}) {
  const [key, setKey] = useState('');
  const [tarpType, setTarpType] = useState<'' | 'blue' | 'brown'>('');
  const sizeOptions =
    tarpType === 'brown'
      ? items.filter((it) => BROWN_TARP_SIZES.has(it.itemKey))
      : items;
  return (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
      <select
        value={tarpType}
        onChange={(e) => {
          const next = e.target.value as '' | 'blue' | 'brown';
          setTarpType(next);
          // Clear size if it isn't available for brown
          if (
            next === 'brown' &&
            key &&
            !BROWN_TARP_SIZES.has(key)
          ) {
            setKey('');
          }
        }}
        className="min-w-0 sm:w-40 border border-zinc-200 rounded-2xl px-3 py-2.5 text-sm text-zinc-900 bg-white"
      >
        <option value="">Color</option>
        <option value="blue">Blue medium</option>
        <option value="brown">Brown heavy</option>
      </select>
      <select
        value={key}
        onChange={(e) => setKey(e.target.value)}
        className="min-w-0 flex-1 border border-zinc-200 rounded-2xl px-3 py-2.5 text-sm text-zinc-900 bg-white"
      >
        <option value="">Size</option>
        {sizeOptions.map((it) => (
          <option key={it.itemKey} value={it.itemKey}>
            {it.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => {
          const it = sizeOptions.find((i) => i.itemKey === key);
          if (!it || !tarpType) return;
          onAdd(it.itemKey, it.label, tarpType);
          setKey('');
          setTarpType('');
        }}
        className="btn-primary shrink-0 px-8 py-3 rounded-full text-sm font-semibold"
      >
        Add
      </button>
    </div>
  );
}

type MitigationLineItem = {
  id: string;
  itemKey: string;
  label: string;
  qty: number;
  unitPrice: number;
  amount: number;
  /** Tarp material type — cost only, never on PDF */
  tarpType?: 'blue' | 'brown' | null;
  /** Ties install/fascia/tuck to a tarp job; null = house-level (trip, adders, etc.) */
  groupId?: string | null;
  /** Display name for tarp group on UI/PDF (e.g. Tarp 1) */
  groupLabel?: string | null;
  /** Fascia wrap edge selection */
  fasciaEdge?: FasciaEdge | null;
};

/** Keys that belong under a tarp group (not house-level). */
const MITIGATION_TARP_SCOPED_KEYS = new Set([
  'ridge_install',
  'valley_install',
  'hip_install',
  'eave_install',
  'rake_install',
  'eave_rake_install',
  'shingle_tuck',
  'fascia_wrap',
]);

function fasciaEdgeMultiplier(_edge?: FasciaEdge | null): number {
  // eave+rake uses dedicated sell rate (fascia_wrap_eave_rake), not 2×
  return 1;
}

function mitigationFasciaPriceKey(fasciaEdge?: FasciaEdge | null): string {
  return fasciaEdge === 'eave_rake' ? 'fascia_wrap_eave_rake' : 'fascia_wrap';
}

function mitigationLineAmount(
  unitPrice: number,
  qty: number,
  itemKey: string,
  fasciaEdge?: FasciaEdge | null
): number {
  const q = Number(qty) || 0;
  const unit = Number(unitPrice) || 0;
  if (itemKey === 'fascia_wrap')
    return unit * fasciaEdgeMultiplier(fasciaEdge) * (q || 1);
  return unit * q;
}

/** Saved invoice index (local; PDF also on lead documents). */
type AppInvoice = {
  id: string;
  createdAt: string;
  title: string;
  entity: MitigationEntity;
  rateMode: 'insurance' | 'cash';
  leadId: number | null;
  leadLabel: string;
  job: string;
  claimNumber: string;
  total: number;
  fileName: string;
  url: string;
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
  /** Obstruction Yes/No — null until user picks (neither pre-selected). */
  obstructionChoice?: 'yes' | 'no' | null;
  /** Negotiated total (list sell minus buffer discount). null = use line sell total. */
  negotiatedTotal?: number | null;
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
    card: 'bg-white border-zinc-200 hover:border-emerald-300/70 hover:shadow-sm transition-all',
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
    card: 'bg-white border-zinc-200 hover:border-emerald-400/60 hover:shadow-sm transition-all',
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
  /**
   * Legacy follow-up date — kept on stored leads for history, not shown or
   * used as a calendar source (Joe schedules follow-ups manually).
   */
  followUpDate?: string;
  /** Insurance adjuster appointment date (YYYY-MM-DD) — calendar + Google sync */
  adjustmentDate?: string;
  /** Optional adjustment time (HH:MM) */
  adjustmentTime?: string;
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
    id: raw.id ?? newLeadNumericId(),
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
    notes: normalizeLeadNotes(raw.notes),
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
    adjustmentDate: raw.adjustmentDate ?? '',
    adjustmentTime: raw.adjustmentTime ?? '',
    calendarEventId: raw.calendarEventId,
    calendarHtmlLink: raw.calendarHtmlLink,
    calendarSyncedAt: raw.calendarSyncedAt,
    supabaseId: raw.supabaseId,
  };
}

function newLeadNumericId(): number {
  // Avoid Date.now() collisions when creating multiple leads in the same ms
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

function newClientId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Repair duplicate lead.id values (causes React key warnings / broken lists). */
function uniquifyLeadIds(leads: Lead[]): Lead[] {
  const seen = new Set<number>();
  let changed = false;
  const next = leads.map((lead) => {
    if (Number.isFinite(lead.id) && !seen.has(lead.id)) {
      seen.add(lead.id);
      return lead;
    }
    changed = true;
    let id = newLeadNumericId();
    while (seen.has(id)) id = newLeadNumericId();
    seen.add(id);
    return { ...lead, id };
  });
  return changed ? next : leads;
}

/** Estimate PDFs used to be dual-written into Documents — detect those orphans. */
function isEstimatePdfDocument(doc: LeadDocument): boolean {
  if (doc.id.startsWith('est-')) return true;
  if (/\/estimates\//i.test(doc.url || '')) return true;
  if (/_Estimate_/i.test(doc.name || '')) return true;
  return false;
}

function storagePathFromLeadDocUrl(url: string): string | null {
  const marker = '/lead-docs/';
  const idx = url.indexOf(marker);
  if (idx < 0) return null;
  try {
    return decodeURIComponent(url.slice(idx + marker.length).split('?')[0]);
  } catch {
    return null;
  }
}

/**
 * Move estimate PDFs out of Documents onto the Estimate records (or drop orphans).
 * Estimates tab owns quotes; Documents stays for contracts / misc files.
 */
function detachEstimatePdfsFromDocuments(leads: Lead[]): Lead[] {
  let changed = false;
  const next = leads.map((lead) => {
    const docs = lead.documents || [];
    const estimateDocs = docs.filter(isEstimatePdfDocument);
    if (estimateDocs.length === 0) return lead;

    changed = true;
    const keepDocs = docs.filter((d) => !isEstimatePdfDocument(d));
    const estimates = [...(lead.estimates || [])];
    const unused = [...estimateDocs];

    // Prefer matching by already-linked id, then attach leftover PDFs to estimates missing a PDF (newest first)
    for (const est of estimates) {
      if (!est.pdfDocumentId && !est.pdfUrl) continue;
      const i = unused.findIndex(
        (d) => d.id === est.pdfDocumentId || d.url === est.pdfUrl
      );
      if (i >= 0) unused.splice(i, 1);
    }

    const needPdf = estimates
      .map((e, idx) => ({ e, idx }))
      .filter(({ e }) => !e.pdfUrl)
      .sort((a, b) => b.e.id - a.e.id);

    for (const { idx } of needPdf) {
      const doc = unused.shift();
      if (!doc) break;
      estimates[idx] = {
        ...estimates[idx],
        pdfDocumentId: doc.id,
        pdfUrl: doc.url,
        pdfName: doc.name,
      };
    }

    return { ...lead, documents: keepDocs, estimates };
  });
  return changed ? next : leads;
}

/** Repair duplicate Estimate.id values within each lead (same Date.now() collision bug). */
function uniquifyEstimateIds(leads: Lead[]): Lead[] {
  let changed = false;
  const next = leads.map((lead) => {
    const estimates = lead.estimates || [];
    if (estimates.length === 0) return lead;
    const seen = new Set<number>();
    let leadChanged = false;
    const fixed = estimates.map((est) => {
      if (Number.isFinite(est.id) && !seen.has(est.id)) {
        seen.add(est.id);
        return est;
      }
      leadChanged = true;
      let id = newLeadNumericId();
      while (seen.has(id)) id = newLeadNumericId();
      seen.add(id);
      return { ...est, id };
    });
    if (!leadChanged) return lead;
    changed = true;
    return { ...lead, estimates: fixed };
  });
  return changed ? next : leads;
}

/** Normalize string fields for estimate content comparison. */
function normEstimateField(v: unknown): string {
  return String(v ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Content fingerprint for exact-duplicate detection.
 * Ignores id/date/supabaseId/pdf* — same quote data = same estimate.
 */
function estimateContentKey(est: Partial<Estimate>): string {
  const neg = Number(est.negotiatedPrice) || 0;
  const tot = Number(est.total) || 0;
  const price = neg > 0 ? neg : tot;
  return [
    normEstimateField(est.squares),
    normEstimateField(est.layers),
    normEstimateField(est.waste),
    normEstimateField(est.pitch),
    normEstimateField(est.stories),
    normEstimateField(est.selectedShingle),
    normEstimateField(est.cambridgeColor),
    normEstimateField(est.dynastyColor),
    normEstimateField(est.armourshakeColor),
    normEstimateField(est.selectedUnderlayment),
    normEstimateField(est.fasciaMode),
    normEstimateField(est.deckingMode),
    normEstimateField(est.fasciaType),
    normEstimateField(est.modifiedBitumenSquares),
    normEstimateField(est.modifiedBitumenColor),
    normEstimateField(est.dripEdgeColor),
    String(price),
    normEstimateField(est.gutterMode || 'none'),
    normEstimateField(est.gutterLF),
    normEstimateField(est.ridgeVentLF),
    normEstimateField(est.fasciaLF),
    normEstimateField(est.deckingSheets),
    normEstimateField(est.deckingOsbSheets),
    normEstimateField(est.deckingCdxSheets),
    normEstimateField(est.solarPanels),
    normEstimateField(est.hvacUnits),
    normEstimateField(est.skylights),
  ].join('\u0001');
}

function findExactDuplicateEstimate(
  estimates: Estimate[],
  candidate: Partial<Estimate>,
  opts?: { excludeId?: number; excludeSupabaseId?: string }
): { estimate: Estimate; index: number } | null {
  const key = estimateContentKey(candidate);
  for (let i = 0; i < estimates.length; i++) {
    const e = estimates[i];
    if (opts?.excludeSupabaseId && e.supabaseId === opts.excludeSupabaseId) {
      continue;
    }
    if (
      opts?.excludeId != null &&
      e.id === opts.excludeId &&
      (!opts.excludeSupabaseId || !e.supabaseId)
    ) {
      continue;
    }
    if (estimateContentKey(e) === key) return { estimate: e, index: i };
  }
  return null;
}

/** Replace exactly one estimate row (prefer supabaseId, then first matching id). */
function replaceOneEstimate(
  prev: Estimate[],
  next: Estimate
): { estimates: Estimate[]; replaced: boolean } {
  let replaced = false;
  const estimates = prev.map((e) => {
    if (replaced) return e;
    if (next.supabaseId && e.supabaseId === next.supabaseId) {
      replaced = true;
      return next;
    }
    if (
      e.id === next.id &&
      (!next.supabaseId || !e.supabaseId || e.supabaseId === next.supabaseId)
    ) {
      replaced = true;
      return next;
    }
    return e;
  });
  return { estimates, replaced };
}

function sanitizeLeads(leads: Lead[]): Lead[] {
  return detachEstimatePdfsFromDocuments(
    uniquifyEstimateIds(uniquifyLeadIds(leads))
  );
}

function normalizeLeadNotes(raw: unknown): LeadNote[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((n, i) => {
    if (typeof n === 'string') {
      return {
        id: newClientId('note'),
        text: n,
        date: new Date().toLocaleString(),
      };
    }
    const note = (n || {}) as Partial<LeadNote>;
    return {
      id: note.id || newClientId('note'),
      text: String(note.text || ''),
      date: String(note.date || ''),
      createdAt: note.createdAt,
    };
  });
}

function createEmptyLead(overrides: Partial<Lead> = {}): Lead {
  return normalizeLead({
    id: newLeadNumericId(),
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
    notes: lead.notes || [],
    trash: lead.trash || [],
    takeoff: lead.takeoff || null,
    followUpDate: lead.followUpDate || '',
    adjustmentDate: lead.adjustmentDate || '',
    adjustmentTime: lead.adjustmentTime || '',
    calendarEventId: lead.calendarEventId || '',
    calendarHtmlLink: lead.calendarHtmlLink || '',
    calendarSyncedAt: lead.calendarSyncedAt || '',
    // Keep a stable React/client id across cloud reloads (UUID hash can collide)
    clientNumericId: lead.id,
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
  // Prefer first 13 hex chars of a UUID → ~52-bit unique id (safe integer)
  const hex = s.replace(/-/g, '');
  if (/^[0-9a-f]{32}$/i.test(hex)) {
    try {
      const n = Number(BigInt(`0x${hex.slice(0, 13)}`));
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
      /* fall through */
    }
  }
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
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
  let firstName =
    String(
      d.clientFirstName ??
        row.client_first_name ??
        row.first_name ??
        nameParts[0] ??
        ''
    ) || '';
  let lastName = String(
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

  // Recover wiped identity from nested estimate (e.g. name became "Unknown")
  const nestedEst =
    Array.isArray(d.estimates) && d.estimates.length > 0
      ? (d.estimates[0] as Record<string, unknown>)
      : null;
  if (
    nestedEst &&
    (!firstName ||
      firstName === 'Unknown' ||
      (!lastName && String(nestedEst.clientLastName || '').trim()))
  ) {
    const ef = String(nestedEst.clientFirstName || '').trim();
    const el = String(nestedEst.clientLastName || '').trim();
    if (ef && ef !== 'Unknown') firstName = ef;
    if (el) lastName = el;
    if (!address) address = String(nestedEst.clientAddress || '');
    if (!city) city = String(nestedEst.clientCity || '');
    if (!state) state = String(nestedEst.clientState || '');
    if (!zip) zip = String(nestedEst.clientZip || '');
    if (!email) email = String(nestedEst.clientEmail || '');
  }
  if (!firstName) firstName = 'Unknown';

  const phoneFromDetails = String(d.clientPhone ?? '').trim();
  const phoneFromEst = nestedEst
    ? String(nestedEst.clientPhone || '').trim()
    : '';
  const phone =
    phoneFromDetails ||
    phoneFromEst ||
    String(row.phone ?? row.client_phone ?? '');

  const jobFromEst = nestedEst
    ? String(nestedEst.clientJobNumber || '').trim()
    : '';
  const jobNumber = String(
    row.job_number ?? d.jobNumber ?? row.jobNumber ?? jobFromEst ?? ''
  );

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
  // Prefer structured notes in details (array). Fallback: legacy joined string column.
  let notes: LeadNote[] = [];
  if (Array.isArray(d.notes) && d.notes.length > 0) {
    notes = (d.notes as LeadNote[]).map((n: any, i: number) => ({
      id: String(n?.id ?? `note-${i}`),
      text: String(n?.text ?? n?.body ?? ''),
      date: String(n?.date ?? n?.createdAt ?? ''),
      createdAt: n?.createdAt ? String(n.createdAt) : undefined,
    }));
  } else if (typeof row.notes === 'string' && row.notes.trim()) {
    // Legacy: one joined blob — split on blank lines so multi-note history isn't one card
    const parts = String(row.notes)
      .split(/\n{2,}/)
      .map((s) => s.trim())
      .filter(Boolean);
    const fallbackDate = createdAt
      ? new Date(String(createdAt)).toLocaleDateString()
      : new Date().toLocaleDateString();
    notes = (parts.length > 1 ? parts : [String(row.notes).trim()]).map(
      (t, i) => ({
        id: `legacy-${i}`,
        text: t,
        date: fallbackDate,
      })
    );
  }

  const dbId = row.id != null ? String(row.id) : undefined;
  const storedClientId = Number(d.clientNumericId);
  const resolvedId =
    Number.isFinite(storedClientId) && storedClientId > 0
      ? storedClientId
      : stableLeadIdFromDb(row.id);

  return normalizeLead({
    id: resolvedId,
    clientFirstName: firstName,
    clientLastName: lastName,
    clientAddress: address,
    clientCity: city,
    clientState: state,
    clientZip: zip,
    clientPhone: phone,
    clientEmail: email,
    company: String(row.company ?? d.company ?? ''),
    jobNumber,
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
    adjustmentDate: String(d.adjustmentDate ?? ''),
    adjustmentTime: String(d.adjustmentTime ?? ''),
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
  /** Where to return after estimator / mitigation / takeoff / pricing */
  const [leadToolReturnTab, setLeadToolReturnTab] =
    useState<ProfileTab>('documents');
  /** When set, Save updates this estimate instead of appending a new one */
  const [editingEstimateId, setEditingEstimateId] = useState<number | null>(
    null
  );
  const [takeoffForm, setTakeoffForm] = useState<TakeoffSheet>(emptyTakeoff());
  const [photoDragOver, setPhotoDragOver] = useState(false);
  const [photosUploading, setPhotosUploading] = useState(false);
  const [docsUploading, setDocsUploading] = useState(false);
  const [docAddMenuOpen, setDocAddMenuOpen] = useState(false);
  const [systemDocPreview, setSystemDocPreview] = useState<string | null>(null);
  const [systemDocWorkspace, setSystemDocWorkspace] = useState<
    | null
    | 'takeoff'
    | 'pricing'
    | 'mitigation'
    | 'mitigation_personal'
    | 'mitigation_company'
    | 'emergency'
  >(null);
  const [emergencyDraft, setEmergencyDraft] =
    useState<EmergencyAgreementDraft | null>(null);
  const [emergencyPreview, setEmergencyPreview] = useState(false);
  const emergencySigPadRef = useRef<HTMLCanvasElement | null>(null);
  const emergencySigDrawing = useRef(false);
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
  /** CompanyCam-style: include logo + company on photo report (can turn off for bland LLC jobs). */
  const [photoReportIncludeBranding, setPhotoReportIncludeBranding] =
    useState(true);
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
  const [solarMeasuring, setSolarMeasuring] = useState(false);
  const [humanOrdering, setHumanOrdering] = useState(false);
  const [measureMoreOpen, setMeasureMoreOpen] = useState(false);
  const [humanOrders, setHumanOrders] = useState<
    Array<{
      id: string;
      leadId: string | null;
      status: string;
      reportUrl: string | null;
      address: string | null;
      createdAt: string;
      failureReason: string | null;
    }>
  >([]);
  /** Shown while tracer is open after Auto-measure (Solar area locked on Save). */
  const [autoMeasureHint, setAutoMeasureHint] = useState<string | null>(null);
  /**
   * When Auto-measure seeds the tracer from Google Solar, keep Solar squares
   * as the area source of truth on Save (outline is for perimeter / adjust).
   */
  const solarAreaOverrideRef = useRef<{
    squares: number;
    footprintSqFt: number;
    surfaceSqFt: number;
    pitch: string;
    secondaryPitch?: string;
    secondaryFraction?: number;
    waste?: number;
    measureSource: RoofMeasurement['measureSource'];
  } | null>(null);
  const [activeMeasurementId, setActiveMeasurementId] = useState<string | null>(null);
  const [mapCenter, setMapCenter] = useState<LatLngPoint | null>(null);
  const [showMeasureAddressModal, setShowMeasureAddressModal] = useState(false);
  /** Home / nav: pick a lead (or saved estimate) before opening estimator */
  const [showEstimatePicker, setShowEstimatePicker] = useState(false);
  /** When true, estimate picker is used to choose a lead for a new mitigation invoice */
  const [invoicePickerMode, setInvoicePickerMode] = useState(false);
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
  /** Prevents double-insert of the same estimate when persistLeads races */
  const estimateSyncInFlightRef = useRef(new Set<string>());
  /** Local leadId:estimateId keys that need a cloud UPDATE (not insert) */
  const dirtyEstimateKeysRef = useRef(new Set<string>());
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
  /** Mitigation cost sheet (internal calc twin of sell rates) */
  const [mitigationCosts, setMitigationCosts] = useState<MitigationCostRow[]>(
    []
  );
  const [mitigationCostsReady, setMitigationCostsReady] = useState(false);
  const [showMitigationInvoice, setShowMitigationInvoice] = useState(false);
  /** Preview twin of estimate “See Estimate” */
  const [showMitigationPreview, setShowMitigationPreview] = useState(false);
  const [mitigationWorkspace, setMitigationWorkspace] =
    useState<MitigationWorkspace>('invoice');
  const [showMitigationCostBreakdown, setShowMitigationCostBreakdown] =
    useState(false);
  const [mitigationDraft, setMitigationDraft] =
    useState<MitigationInvoiceDraft | null>(null);
  /** Which tarp group receives the next install / fascia / tuck */
  const [activeTarpGroupId, setActiveTarpGroupId] = useState<string | null>(
    null
  );
  const [appInvoices, setAppInvoices] = useState<AppInvoice[]>([]);
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
  /** Company billing entity (ProWest) — used on company mitigation + estimates when set. */
  const [companySettings, setCompanySettings] = useState<CompanySettings>(
    emptyCompanySettings
  );
  /** Company logo flattened onto white for PDFs (jsPDF often paints PNG alpha as black). */
  const companyLogoPdfRef = useRef('');
  const [themePref, setThemePref] = useState<ThemePreference>('auto');
  const [themeMode, setThemeMode] = useState<ThemeMode>('day');
  /** Google Calendar connection (from /api/google/calendar/status) */
  const [, setGcalConfigured] = useState(false);
  const [gcalConnected, setGcalConnected] = useState(false);
  const [gcalEmail, setGcalEmail] = useState<string | null>(null);
  const [gcalName, setGcalName] = useState<string | null>(null);
  const [gcalBusy, setGcalBusy] = useState(false);
  const [gcalLastSync, setGcalLastSync] = useState<string | null>(null);
  const [adjustmentDate, setAdjustmentDate] = useState('');
  const [adjustmentTime, setAdjustmentTime] = useState('');
  /** Summit Calendar cursor (drives month / week grid) */
  const [calendarCursor, setCalendarCursor] = useState(() => new Date());
  const [calendarSelectedDay, setCalendarSelectedDay] = useState<string | null>(
    null
  );
  const [calendarViewMode, setCalendarViewMode] = useState<CalendarViewMode>(
    'month'
  );
  const calendarWeekScrollRef = useRef<HTMLDivElement>(null);
  /** Live events pulled from connected Google Calendar */
  const [googleCalendarEvents, setGoogleCalendarEvents] = useState<
    Array<{
      id: string;
      summary: string;
      htmlLink?: string;
      location?: string;
      description?: string;
      colorId?: string;
      calendarId?: string;
      calendarBackground?: string;
      calendarForeground?: string;
      organizer?: { email?: string; displayName?: string; self?: boolean };
      start: { dateTime?: string; date?: string };
      end: { dateTime?: string; date?: string };
      updated?: string;
      extendedProperties?: {
        private?: Record<string, string>;
      };
    }>
  >([]);
  /** calendarList id → background/foreground (re-resolve on refresh) */
  const [googleCalendarColorMap, setGoogleCalendarColorMap] = useState<
    Record<string, { bg: string; fg: string }>
  >({});
  /** Writable calendars from calendarList (for create picker) */
  const [googleCalendarList, setGoogleCalendarList] = useState<
    Array<{
      id: string;
      summary: string;
      primary?: boolean;
      backgroundColor?: string;
      foregroundColor?: string;
    }>
  >([]);
  const [gcalCalendarListNeedsReconnect, setGcalCalendarListNeedsReconnect] =
    useState(false);
  const [googleEventsLoading, setGoogleEventsLoading] = useState(false);
  const calendarCloudSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const tasksCloudSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  /** Manual Summit calendar events (localStorage + optional Google sync) */
  const [calendarEvents, setCalendarEvents] = useState<SummitCalendarEvent[]>(
    []
  );
  /** Google-style create / edit event dialog */
  const [calEventModal, setCalEventModal] = useState<null | {
    mode: 'create' | 'edit';
    eventId?: string;
  }>(null);
  const [calEventDraft, setCalEventDraft] = useState({
    title: '',
    notes: '',
    startDate: '',
    endDate: '',
    startTime: '09:00',
    endTime: '10:00',
    allDay: false,
    leadId: null as number | null,
    leadSearch: '',
    calendarId: 'primary' as string,
    colorId: undefined as GoogleEventColorId | undefined,
  });
  const [calEventBusy, setCalEventBusy] = useState(false);
  /** Local + Google Tasks (Google Tasks-style lists + calendar chips) */
  const [tasks, setTasks] = useState<SummitTask[]>([]);
  const [taskLists, setTaskLists] = useState<SummitTaskList[]>(() => [
    createDefaultTaskList(),
  ]);
  const [activeTaskListId, setActiveTaskListId] = useState(DEFAULT_TASK_LIST_ID);
  const [tasksBusy, setTasksBusy] = useState(false);
  const [gtasksNeedsReconnect, setGtasksNeedsReconnect] = useState(false);
  const [gtasksLastError, setGtasksLastError] = useState<string | null>(null);
  const [gtasksErrorKind, setGtasksErrorKind] = useState<
    'scope' | 'api' | 'auth' | 'other' | null
  >(null);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDue, setNewTaskDue] = useState('');
  const [newTaskNotes, setNewTaskNotes] = useState('');
  const [taskListDraftTitle, setTaskListDraftTitle] = useState('');
  const [renamingTaskListId, setRenamingTaskListId] = useState<string | null>(
    null
  );
  const [renameTaskListTitle, setRenameTaskListTitle] = useState('');
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /** Desktop: icon rail vs full labels. Mobile uses drawer (`sidebarOpen`). */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarDocPrevCollapsed = useRef<boolean | null>(null);
  const [sidebarProfileOpen, setSidebarProfileOpen] = useState(false);
  /** Estimate picker opens estimate vs internal workspace after lead pick */
  const [estimatePickerMode, setEstimatePickerMode] =
    useState<EstimateWorkspace>('estimate');
  /** In-app leave guard (replaces window.confirm for unsaved estimate) */
  const [pendingLeave, setPendingLeave] = useState<null | {
    kind: 'estimator' | 'nav';
    returnToLead?: boolean;
    targetTab?: AppTab;
    newTab?: AppTab;
  }>(null);
  /** Apply saved roof measurement when starting a new estimate */
  const [pendingApplyMeasurement, setPendingApplyMeasurement] = useState<null | {
    leadId: number;
    name: string;
    workspace: EstimateWorkspace;
    measurement: RoofMeasurement;
    resolvedLead: Lead;
  }>(null);
  /** Soft-delete photo confirm (in-app) */
  const [pendingTrashPhotoId, setPendingTrashPhotoId] = useState<string | null>(
    null
  );
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

  const persistAppInvoices = (next: AppInvoice[]) => {
    setAppInvoices(next);
    try {
      localStorage.setItem('summitAppInvoices', JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const scheduleCloudCalendarSave = (events: SummitCalendarEvent[]) => {
    if (!supabaseEnabled || !supabase) return;
    if (calendarCloudSaveTimer.current) {
      clearTimeout(calendarCloudSaveTimer.current);
    }
    calendarCloudSaveTimer.current = setTimeout(() => {
      void saveCloudCalendarEvents(supabase, events).catch((err) => {
        console.error('Calendar cloud save failed:', err);
      });
    }, 800);
  };

  const scheduleCloudTasksSave = (
    nextTasks: SummitTask[],
    nextLists: SummitTaskList[],
    nextActiveId: string
  ) => {
    if (!supabaseEnabled || !supabase) return;
    if (tasksCloudSaveTimer.current) {
      clearTimeout(tasksCloudSaveTimer.current);
    }
    tasksCloudSaveTimer.current = setTimeout(() => {
      void saveCloudTasksBundle(supabase, {
        tasks: nextTasks,
        lists: nextLists,
        activeListId: nextActiveId,
      }).catch((err) => {
        console.error('Tasks cloud save failed:', err);
      });
    }, 800);
  };

  const persistTasks = (next: SummitTask[]) => {
    const safe = Array.isArray(next) ? next : [];
    setTasks(safe);
    try {
      localStorage.setItem(SUMMIT_TASKS_KEY, JSON.stringify(safe));
    } catch {
      /* ignore */
    }
    scheduleCloudTasksSave(safe, taskLists, activeTaskListId);
  };

  const persistCalendarEvents = (next: SummitCalendarEvent[]) => {
    const safe = Array.isArray(next) ? next : [];
    setCalendarEvents(safe);
    try {
      localStorage.setItem(SUMMIT_CALENDAR_EVENTS_KEY, JSON.stringify(safe));
    } catch {
      /* ignore */
    }
    scheduleCloudCalendarSave(safe);
  };

  const persistTaskLists = (next: SummitTaskList[]) => {
    const safe = next.length > 0 ? next : [createDefaultTaskList()];
    setTaskLists(safe);
    try {
      localStorage.setItem(SUMMIT_TASK_LISTS_KEY, JSON.stringify(safe));
    } catch {
      /* ignore */
    }
    scheduleCloudTasksSave(tasks, safe, activeTaskListId);
  };

  const persistActiveTaskListId = (listId: string) => {
    setActiveTaskListId(listId);
    try {
      localStorage.setItem(SUMMIT_ACTIVE_TASK_LIST_KEY, listId);
    } catch {
      /* ignore */
    }
  };

  const activeTaskList =
    taskLists.find((l) => l.id === activeTaskListId) || taskLists[0];
  const googleListIdFor = (list: SummitTaskList | undefined) =>
    list?.googleListId || (list?.id === DEFAULT_TASK_LIST_ID ? '@default' : '');

  /** Remove invoice from Invoices index (+ matching lead doc / Storage when possible). */
  const removeAppInvoice = (invoiceId: string) => {
    const inv = appInvoices.find((i) => i.id === invoiceId);
    if (!inv) return;
    if (
      !confirm(
        `Remove invoice for “${inv.leadLabel || 'lead'}” from Invoices?`
      )
    ) {
      return;
    }

    persistAppInvoices(appInvoices.filter((i) => i.id !== invoiceId));

    // Drop matching document on the lead (if lead still exists)
    if (inv.leadId != null) {
      const updated = leads.map((l) => {
        if (l.id !== inv.leadId) return l;
        const docs = l.documents || [];
        const nextDocs = docs.filter(
          (d) => d.id !== inv.id && d.url !== inv.url
        );
        if (nextDocs.length === docs.length) return l;
        return { ...l, documents: nextDocs };
      });
      const changed = updated.some((l, i) => l !== leads[i]);
      if (changed) persistLeads(updated);
    }

    // Purge Storage object for durable PDFs
    if (supabaseEnabled && supabase && inv.url) {
      try {
        const marker = '/lead-docs/';
        const idx = inv.url.indexOf(marker);
        if (idx >= 0) {
          const objectPath = decodeURIComponent(
            inv.url.slice(idx + marker.length).split('?')[0]
          );
          void supabase.storage.from('lead-docs').remove([objectPath]);
        }
      } catch {
        /* ignore */
      }
    }

    showToast('Invoice removed');
  };

  const mitigationPersonalBrand = () => userCompany.trim() || '';

  /** Display name for company billing entity (Settings → Company). */
  const companyBrandName = () => (companySettings.company || '').trim();

  const companySettingsConfigured = () =>
    Boolean(
      (companySettings.company || '').trim() ||
        (companySettings.projectManager || '').trim() ||
        (companySettings.projectManagerPhone || '').trim() ||
        (companySettings.projectManagerEmail || '').trim() ||
        (companySettings.address || '').trim() ||
        (companySettings.phone || '').trim() ||
        (companySettings.fax || '').trim() ||
        (companySettings.email || '').trim() ||
        (companySettings.license || '').trim() ||
        (companySettings.logoDataUrl || '').trim()
    );

  /** Nav / login / chrome product name — company when set, else Summit. */
  const appDisplayName = () => companyBrandName() || 'Summit';

  const appLogoDataUrl = () => (companySettings.logoDataUrl || '').trim();

  /** Project Manager block on estimates (company settings, else profile). */
  const estimatePmName = () =>
    (companySettings.projectManager || '').trim() || userName.trim() || '';

  const estimatePmPhone = () => {
    const fromCompany = (companySettings.projectManagerPhone || '').trim();
    if (fromCompany) return displayPhoneUS(fromCompany) || fromCompany;
    return displayPhoneUS(userPhone) || userPhone || '';
  };

  /** Company PM email when set; else profile email (estimates). Blank if neither. */
  const estimatePmEmail = () => {
    const fromCompany = (companySettings.projectManagerEmail || '').trim();
    if (fromCompany) return fromCompany;
    return (userEmail || '').trim();
  };

  /** Settings PM filled — company-branded mitigation / photo docs should show the block. */
  const companyPmFieldsFilled = () =>
    Boolean(
      (companySettings.projectManager || '').trim() ||
        (companySettings.projectManagerPhone || '').trim() ||
        (companySettings.projectManagerEmail || '').trim()
    );

  /** Show PM on company-billed mitigation / branded photo PDFs when Settings PM is set. */
  const showCompanyPmOnDoc = (entity?: MitigationEntity) => {
    if (entity === 'roslie') return false;
    return companyPmFieldsFilled();
  };

  const mitigationBillingBrand = (entity: MitigationEntity) =>
    entity === 'prowest'
      ? companyBrandName() || 'Company name'
      : mitigationPersonalBrand();

  const mitigationPayableTo = (entity: MitigationEntity) =>
    mitigationBillingBrand(entity);

  /**
   * Party role on mitigation docs only:
   * personal LLC → "Service Provider"; company (ProWest) → "Contractor".
   * Estimates always use "Contractor" (company does the roofing) — never Service provider.
   */
  const mitigationPartyRole = (entity: MitigationEntity) =>
    entity === 'prowest' ? 'Contractor' : 'Service Provider';

  /** UI / fallback casing (signature column, empty legal name). */
  const mitigationPartyRoleLabel = (entity: MitigationEntity) =>
    entity === 'prowest' ? 'Contractor' : 'Service provider';

  const mitigationInvoiceTitle = (_entity: MitigationEntity) =>
    'Mitigation invoice';

  /** Subline under brand name — company license only; personal LLC has no "Joe · phone" brand row. */
  const mitigationBrandSub = (entity: MitigationEntity) => {
    if (entity === 'prowest') {
      const lic = (companySettings.license || '').trim();
      if (lic) return `ROC# ${lic}`;
      return companySettingsConfigured() ? '' : 'Company · fill in Settings';
    }
    return '';
  };

  const mitigationBrandPhone = (entity: MitigationEntity) => {
    if (entity === 'prowest') {
      const office = (companySettings.phone || '').trim();
      return displayPhoneUS(office) || office || '';
    }
    return displayPhoneUS(userPhone) || userPhone || '';
  };

  /**
   * PDF header logo: uploaded company logo (contain-fit), else Summit "S" mark.
   * Returns the occupied width (mm) so callers can place brand text after the mark.
   */
  const drawDocLogo = (
    doc: jsPDF,
    x: number,
    y: number,
    opts?: { show?: boolean; logoDataUrl?: string | null }
  ): number => {
    if (opts?.show === false) return 0;
    // Tall enough for circular emblems; wide enough for wordmarks — never stretch.
    const maxW = 28;
    const maxH = 18;
    // Explicit '' (e.g. personal entity) must not fall back to company logo.
    const requested = (
      (opts?.logoDataUrl !== undefined
        ? opts.logoDataUrl
        : companySettings.logoDataUrl) || ''
    ).trim();
    const companyLogo = (companySettings.logoDataUrl || '').trim();
    const logo =
      requested &&
      requested === companyLogo &&
      companyLogoPdfRef.current
        ? companyLogoPdfRef.current
        : requested;
    if (logo) {
      try {
        const fmt = logo.startsWith('data:image/png')
          ? 'PNG'
          : logo.startsWith('data:image/webp')
            ? 'WEBP'
            : 'JPEG';
        let drawW = Math.min(maxW, maxH);
        let drawH = drawW;
        try {
          const { width: iw, height: ih } = doc.getImageProperties(logo);
          if (iw > 0 && ih > 0) {
            const scale = Math.min(maxW / iw, maxH / ih);
            drawW = iw * scale;
            drawH = ih * scale;
          }
        } catch {
          /* props unavailable — assume square emblem, never stretch to maxW×maxH */
        }
        // Left-align; vertically center in the header band.
        const drawY = y + (maxH - drawH) / 2;
        doc.addImage(logo, fmt, x, drawY, drawW, drawH);
        return drawW;
      } catch {
        /* fall through to Summit mark */
      }
    }
    const boxW = 14;
    const boxH = 14;
    const markY = y + (maxH - boxH) / 2;
    doc.setFillColor(24, 24, 27);
    doc.roundedRect(x, markY, boxW, boxH, 1, 1, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('S', x + boxW / 2, markY + 9.2, { align: 'center' });
    return boxW;
  };

  /** Company header contact: office phone · fax · ROC#. */
  const companyContactLine = () => {
    const office = (companySettings.phone || '').trim();
    const fax = (companySettings.fax || '').trim();
    const lic = (companySettings.license || '').trim();
    return [
      office ? displayPhoneUS(office) || office : '',
      fax ? `Fax ${displayPhoneUS(fax) || fax}` : '',
      lic ? `ROC# ${lic}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  };

  /** UI chrome mark: company logo or Summit "S". */
  const renderAppMark = (opts?: {
    size?: 'sm' | 'md' | 'lg' | 'xl';
    className?: string;
    imgClassName?: string;
  }) => {
    const size = opts?.size ?? 'md';
    const box =
      size === 'sm'
        ? 'w-8 h-8'
        : size === 'lg'
          ? 'h-14 w-14'
          : size === 'xl'
            ? 'w-20 h-20'
            : 'w-8 h-8';
    const text =
      size === 'sm'
        ? 'text-sm'
        : size === 'lg'
          ? 'text-xl'
          : size === 'xl'
            ? 'text-6xl'
            : 'text-lg';
    const radius =
      size === 'xl' ? 'rounded-3xl' : size === 'lg' ? 'rounded-xl' : 'rounded-xl';
    const logo = appLogoDataUrl();
    if (logo) {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logo}
          alt=""
          className={
            opts?.imgClassName ||
            `${box} ${radius} object-contain border border-zinc-200 bg-white shrink-0 ${opts?.className || ''}`
          }
        />
      );
    }
    return (
      <div
        className={`${box} ${radius} bg-zinc-900 flex items-center justify-center shrink-0 ring-1 ring-zinc-700/40 ${opts?.className || ''}`}
      >
        <span
          className={`text-white ${text} font-bold tracking-tight${size === 'xl' ? ' tracking-tighter' : ''}`}
        >
          S
        </span>
      </div>
    );
  };

  const handleCompanyLogoFile = async (file: File) => {
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);
        img.onload = () => {
          try {
            const max = 1024;
            let w = img.naturalWidth;
            let h = img.naturalHeight;
            if (w > max || h > max) {
              const s = max / Math.max(w, h);
              w = Math.round(w * s);
              h = Math.round(h * s);
            }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              reject(new Error('canvas'));
              return;
            }
            // Flatten transparency onto white so PDFs don't get black corner boxes.
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            URL.revokeObjectURL(objectUrl);
            const out = canvas.toDataURL('image/png');
            companyLogoPdfRef.current = out;
            resolve(out);
          } catch (e) {
            URL.revokeObjectURL(objectUrl);
            reject(e);
          }
        };
        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          reject(new Error('load'));
        };
        img.src = objectUrl;
      });
      setCompanySettings({
        ...companySettings,
        logoDataUrl: dataUrl,
        logoPath: '',
      });
      showToast('Logo updated — save Settings to keep');
    } catch {
      showToast('Could not read logo image');
    }
  };

  /**
   * New invoice: always tied to a lead (same idea as estimates).
   * Only skip the picker when the lead profile is currently open.
   */
  const startNewInvoice = () => {
    setDocAddMenuOpen(false);
    setShowProfessionalEstimate(false);
    setShowMeasureAddressModal(false);
    if (isEditingLead && currentLeadId != null) {
      openMitigationWorkspace('personal', currentLeadId);
      return;
    }
    // No open lead profile → force lead picker (never open blank invoice)
    setInvoicePickerMode(true);
    setEstimatePickerQuery('');
    setShowEstimatePicker(true);
  };

  // Flatten stored company logo onto white for PDF drawing (fixes PNG alpha → black).
  useEffect(() => {
    const src = (companySettings.logoDataUrl || '').trim();
    if (!src) {
      companyLogoPdfRef.current = '';
      return;
    }
    let cancelled = false;
    const img = new Image();
    // Needed so canvas can export https Storage logos without tainting.
    if (/^https?:\/\//i.test(src)) img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      try {
        const max = 1024;
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        if (w > max || h > max) {
          const s = max / Math.max(w, h);
          w = Math.round(w * s);
          h = Math.round(h * s);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          companyLogoPdfRef.current = src;
          return;
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        companyLogoPdfRef.current = canvas.toDataURL('image/png');
      } catch {
        companyLogoPdfRef.current = src;
      }
    };
    img.onerror = () => {
      if (!cancelled) companyLogoPdfRef.current = src;
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
  }, [companySettings.logoDataUrl]);

  // Persist mitigation invoice workspace across refresh
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('summitMitigationWorkspace');
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed?.workspace === 'mitigation' && parsed?.draft) {
        setSystemDocWorkspace('mitigation');
        setMitigationDraft(parsed.draft);
      }
    } catch (e) {}
  }, []);

  // Poll Instant Roofer human orders while on Measurements (field notification path)
  useEffect(() => {
    if (!isEditingLead || profileTab !== 'measurements' || !currentLeadId) return;
    void refreshHumanOrders(currentLeadId);
    const id = window.setInterval(() => {
      void refreshHumanOrders(currentLeadId);
    }, 30000);
    return () => window.clearInterval(id);
  }, [isEditingLead, profileTab, currentLeadId]);

  useEffect(() => {
    try {
      if (
        systemDocWorkspace === 'mitigation' ||
        systemDocWorkspace === 'mitigation_personal' ||
        systemDocWorkspace === 'mitigation_company'
      ) {
        sessionStorage.setItem(
          'summitMitigationWorkspace',
          JSON.stringify({ workspace: 'mitigation', draft: mitigationDraft })
        );
      }
    } catch (e) {}
  }, [systemDocWorkspace, mitigationDraft]);

  useEffect(() => {
    try {
      if (
        systemDocWorkspace !== 'mitigation' &&
        systemDocWorkspace !== 'mitigation_personal' &&
        systemDocWorkspace !== 'mitigation_company'
      ) {
        // cleared workspace
        if (mitigationDraft == null) {
          sessionStorage.removeItem('summitMitigationWorkspace');
        }
      }
    } catch (e) {}
  }, [systemDocWorkspace, mitigationDraft]);


  const openSystemDoc = (id: 'takeoff' | 'pricing') => {
    setDocAddMenuOpen(false);
    try {
      setShowMitigationInvoice(false);
    } catch (e) {}
    setMitigationDraft(null);
    // Stay in lead context — don't hijack sidebar to Documents hub
    if (isEditingLead && profileTab !== 'estimator') {
      setLeadToolReturnTab(profileTab);
    } else {
      setLeadToolReturnTab('documents');
    }
    if (currentLeadId != null) {
      setIsEditingLead(true);
      setActiveTab('leads');
    }
    if (id === 'takeoff') {
      setTakeoffForm(emptyTakeoff());
      setTakeoffAssignOpen(false);
      setTakeoffAssignSearch('');
    }
    setSystemDocPreview(null);
    setSystemDocWorkspace(id);
  };

  /** One exit contract for mitigation / takeoff / pricing / emergency → back on the lead */
  const exitLeadDocumentWorkspace = (opts?: { returnTab?: ProfileTab }) => {
    const raw = opts?.returnTab ?? leadToolReturnTab ?? 'documents';
    const returnTab: ProfileTab =
      raw === 'estimator' ? 'documents' : raw;
    setSystemDocWorkspace(null);
    setTakeoffAssignOpen(false);
    setShowMitigationInvoice(false);
    setShowMitigationPreview(false);
    setMitigationDraft(null);
    setMitigationWorkspace('invoice');
    setShowMitigationCostBreakdown(false);
    setActiveTarpGroupId(null);
    setEmergencyDraft(null);
    setEmergencyPreview(false);
    try {
      sessionStorage.removeItem('summitMitigationWorkspace');
    } catch {
      /* ignore */
    }
    if (currentLeadId != null) {
      setIsEditingLead(true);
      setActiveTab('leads');
      setProfileTab(returnTab);
    }
  };

  const openMitigationWorkspace = (
    _kind: 'personal' | 'company' = 'personal',
    fromLeadId?: number | null
  ) => {
    const leadId =
      fromLeadId != null
        ? fromLeadId
        : currentLeadId != null
          ? currentLeadId
          : null;
    // Hard require a lead — never show the form without one
    if (leadId == null) {
      setSystemDocWorkspace(null);
      setMitigationDraft(null);
    try { sessionStorage.removeItem('summitMitigationWorkspace'); } catch (e) {}
      setInvoicePickerMode(true);
      setEstimatePickerQuery('');
      setShowEstimatePicker(true);
      showToast('Select or create a lead first, then create the invoice');
      return;
    }
    const lead = leads.find((l) => l.id === leadId) || null;
    if (!lead) {
      showToast('Lead not found');
      setInvoicePickerMode(true);
      setShowEstimatePicker(true);
      return;
    }
    const name = [lead.clientFirstName, lead.clientLastName]
      .filter(Boolean)
      .join(' ');
    const addr = [
      lead.clientAddress,
      lead.clientCity,
      lead.clientState,
      lead.clientZip,
    ]
      .filter(Boolean)
      .join(', ');
    setCurrentLeadId(leadId);
    // Remember where we came from; keep lead chrome alive under the tool
    if (isEditingLead && profileTab !== 'estimator') {
      setLeadToolReturnTab(profileTab);
    } else {
      setLeadToolReturnTab('documents');
    }
    setActiveTab('leads');
    setIsEditingLead(true);
    const draft: MitigationInvoiceDraft = {
      entity: 'roslie',
      rateMode: 'insurance',
      invoiceFor: name,
      location: addr,
      job: lead.jobNumber || '',
      claimNumber: '',
      date: new Date().toLocaleDateString(),
      lines: [],
      notes:
        'Work performed to mitigate any further damages.\nLabor is included — price covers materials, labor, and roof access / set up.\nPlease forward to Insurance Company for reimbursement.',
    };
    setMitigationDraft(draft);
    setMitigationWorkspace('invoice');
    setShowMitigationCostBreakdown(false);
    setActiveTarpGroupId(null);
    setShowMitigationPreview(false);
    setSystemDocWorkspace('mitigation');
    setShowMitigationInvoice(false);
    setDocAddMenuOpen(false);
    setInvoicePickerMode(false);
    setShowEstimatePicker(false);
  };

  const openEmergencyAgreement = (fromLeadId?: number | null) => {
    const leadId =
      fromLeadId != null
        ? fromLeadId
        : currentLeadId != null
          ? currentLeadId
          : null;
    if (leadId == null) {
      setSystemDocWorkspace(null);
      setEmergencyDraft(null);
      setInvoicePickerMode(true);
      setEstimatePickerQuery('');
      setShowEstimatePicker(true);
      showToast(
        'Select a lead first — Mitigation Service Agreement is for mitigation jobs'
      );
      return;
    }
    const lead = leads.find((l) => l.id === leadId) || null;
    if (!lead) {
      showToast('Lead not found');
      return;
    }
    const name = [lead.clientFirstName, lead.clientLastName]
      .filter(Boolean)
      .join(' ');
    const addr = [
      lead.clientAddress,
      lead.clientCity,
      lead.clientState,
      lead.clientZip,
    ]
      .filter(Boolean)
      .join(', ');

    // Prefer open mitigation draft lines for scope; else blank for field entry
    let scope = '';
    if (
      mitigationDraft &&
      Array.isArray(mitigationDraft.lines) &&
      mitigationDraft.lines.length > 0
    ) {
      scope = mitigationDraft.lines
        .map((ln) => formatMitigationLineDescription(ln))
        .join('\n');
    }

    const listSell =
      mitigationDraft && mitigationDraft.lines.length > 0
        ? mitigationDraft.lines.reduce(
            (s, ln) => s + (Number(ln.amount) || 0),
            0
          )
        : 0;
    const negotiated =
      mitigationDraft?.negotiatedTotal != null &&
      Number.isFinite(Number(mitigationDraft.negotiatedTotal))
        ? Number(mitigationDraft.negotiatedTotal)
        : listSell;
    const amountFromMit =
      negotiated > 0 ? String(Math.round(negotiated * 100) / 100) : '';
    const paymentModeFromMit =
      mitigationDraft?.rateMode === 'cash' ? 'cash' : 'insurance';

    setCurrentLeadId(leadId);
    if (isEditingLead && profileTab !== 'estimator') {
      setLeadToolReturnTab(profileTab);
    } else {
      setLeadToolReturnTab('documents');
    }
    setActiveTab('leads');
    setIsEditingLead(true);
    setShowMitigationPreview(false);
    const entityFromMit: MitigationEntity =
      mitigationDraft?.entity === 'prowest' ? 'prowest' : 'roslie';
    setEmergencyDraft({
      entity: entityFromMit,
      clientName: name,
      propertyAddress: addr,
      phone: lead.clientPhone || '',
      email: lead.clientEmail || '',
      scope,
      serviceStart: '',
      serviceComplete: '',
      paymentMode: paymentModeFromMit,
      paymentAmount: amountFromMit,
      date: new Date().toLocaleDateString(),
      signerName: name,
      clientSignatureDataUrl: null,
      clientSignedAt: null,
    });
    setEmergencyPreview(false);
    setSystemDocWorkspace('emergency');
    setDocAddMenuOpen(false);
    setInvoicePickerMode(false);
    setShowEstimatePicker(false);
  };

  const clearEmergencySignaturePad = () => {
    const canvas = emergencySigPadRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#18181b';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  };

  const commitEmergencySignature = () => {
    const canvas = emergencySigPadRef.current;
    if (!canvas || !emergencyDraft) return;
    const signer =
      emergencyDraft.signerName.trim() ||
      emergencyDraft.clientName.trim() ||
      '';
    if (!signer) {
      showToast('Enter the signer’s full legal name first');
      return;
    }
    const dataUrl = canvas.toDataURL('image/png');
    // Ignore blank-ish pads
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] < 250 || pixels[i + 1] < 250 || pixels[i + 2] < 250) {
          ink++;
          if (ink > 40) break;
        }
      }
      if (ink <= 40) {
        showToast('Draw a signature first');
        return;
      }
    }
    const signedAt = new Date().toISOString();
    setEmergencyDraft({
      ...emergencyDraft,
      signerName: signer,
      clientSignatureDataUrl: dataUrl,
      clientSignedAt: signedAt,
    });
    showToast('Electronically signed');
  };

  const formatSignedAtDisplay = (iso: string | null | undefined) => {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return iso;
    return new Date(t).toLocaleString();
  };

  const generateEmergencyAgreementPdf = async (opts?: {
    download?: boolean;
    save?: boolean;
  }) => {
    if (!emergencyDraft) {
      showToast('Open the agreement first');
      return;
    }
    const d = emergencyDraft;
    const entity: MitigationEntity = d.entity || 'roslie';
    const wantDownload = opts?.download !== false && opts?.save !== true
      ? true
      : opts?.download === true;
    const wantSave = opts?.save === true;
    const doDownload = opts == null ? true : wantDownload;

    // Twin of generateMitigationPdf: letter, same margins / header / footer pattern
    const doc = new jsPDF({ unit: 'mm', format: 'letter' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const left = 18;
    const right = pageW - 18;
    const ink = { r: 28, g: 28, b: 30 };
    const muted = { r: 100, g: 100, b: 105 };
    const rule = { r: 190, g: 190, b: 195 };
    const brandName = mitigationBillingBrand(entity);
    const brandSub = mitigationBrandSub(entity);
    const brandPhone = mitigationBrandPhone(entity);
    const partyRole = mitigationPartyRole(entity);
    const billingPartyLegal =
      entity === 'prowest'
        ? companyBrandName() || brandName
        : mitigationPersonalBrand();
    const providerLabel =
      billingPartyLegal.trim() || mitigationPartyRoleLabel(entity);
    const signedAtDisp =
      formatSignedAtDisplay(d.clientSignedAt) || d.date || '';

    // --- Header: company logo only for company billing; else Summit ---
    let y = 16;
    const logoW = drawDocLogo(doc, left, y, {
      logoDataUrl:
        entity === 'prowest' ? (companySettings.logoDataUrl || '').trim() : '',
    });
    const textX = left + logoW + 4;

    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text(brandName, textX, y + 5.5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(muted.r, muted.g, muted.b);
    const agreementSubBits = [brandSub, brandPhone].filter(Boolean);
    if (agreementSubBits[0]) {
      doc.text(agreementSubBits[0], textX, y + 10.5);
    }
    if (agreementSubBits[1]) {
      doc.text(agreementSubBits[1], textX, y + 14.5);
    } else if (
      entity === 'prowest' &&
      (companySettings.address || '').trim() &&
      !brandSub
    ) {
      doc.text((companySettings.address || '').trim(), textX, y + 10.5);
      if (brandPhone) doc.text(brandPhone, textX, y + 14.5);
    }

    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('AGREEMENT', right, y + 6, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.text('Mitigation Service Agreement', right, y + 11.5, {
      align: 'right',
    });
    doc.text(d.date || new Date().toLocaleDateString(), right, y + 16, {
      align: 'right',
    });

    y = 38;
    doc.setDrawColor(rule.r, rule.g, rule.b);
    doc.setLineWidth(0.4);
    doc.line(left, y, right, y);
    y += 8;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.text('Mitigation Service Agreement', left, y);
    y += 6;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(muted.r, muted.g, muted.b);
    const intro = doc.splitTextToSize(
      `This Mitigation Service Agreement ("Agreement") is entered into as of the date electronically signed below between ${providerLabel} ("${partyRole}") and the Client named below.`,
      right - left
    );
    doc.text(intro, left, y);
    y += intro.length * 4 + 4;

    // --- Client / billed-by meta (twin of invoice bill-to layout) ---
    const metaLeft = left;
    const metaRight = pageW / 2 + 4;
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text('CLIENT', metaLeft, y);
    doc.text('BILLED BY', metaRight, y);
    y += 5;
    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(d.clientName || '—', metaLeft, y);
    doc.text(providerLabel, metaRight, y);
    y += 5;
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.setFontSize(9);
    doc.text(d.phone || '—', metaLeft, y);
    doc.text(brandPhone || '—', metaRight, y);
    y += 5;
    doc.text(d.email || '—', metaLeft, y);
    if (entity === 'prowest' && (companySettings.email || '').trim()) {
      doc.text((companySettings.email || '').trim(), metaRight, y);
    } else if (entity !== 'prowest') {
      doc.text(userEmail || '—', metaRight, y);
    }
    y += 8;
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text('PROPERTY', metaLeft, y);
    const showPm = showCompanyPmOnDoc(entity);
    if (showPm) {
      doc.text('PROJECT MANAGER', metaRight, y);
    }
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(ink.r, ink.g, ink.b);
    const propLines = doc.splitTextToSize(
      d.propertyAddress || '—',
      showPm ? pageW / 2 - 28 : right - left
    );
    const propY = y;
    doc.text(propLines, metaLeft, propY);
    if (showPm) {
      const pmName = estimatePmName();
      const pmPhone = estimatePmPhone();
      const pmEmail = (companySettings.projectManagerEmail || '').trim();
      doc.text(pmName || '—', metaRight, propY);
      doc.setTextColor(muted.r, muted.g, muted.b);
      doc.setFontSize(9);
      let pmOff = 5;
      if (pmPhone) {
        doc.text(pmPhone, metaRight, propY + pmOff);
        pmOff += 4;
      }
      if (pmEmail) {
        doc.text(pmEmail, metaRight, propY + pmOff);
      }
      doc.setTextColor(ink.r, ink.g, ink.b);
      doc.setFontSize(10);
    }
    y =
      propY +
      Math.max(showPm ? 12 : 5, propLines.length * 5) +
      6;

    const ensureSpace = (need: number) => {
      if (y > pageH - need) {
        doc.addPage();
        y = 20;
      }
    };

    ensureSpace(40);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.text('1. Scope of Work', left, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(muted.r, muted.g, muted.b);
    const scopeIntro = doc.splitTextToSize(
      `${partyRole} agrees to perform mitigation / emergency roofing services as deemed necessary to prevent further property damage. Services may include tarping, patching, sealing, or temporary structural reinforcement.`,
      right - left
    );
    doc.text(scopeIntro, left, y);
    y += scopeIntro.length * 3.6 + 3;
    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.setFontSize(9);
    const scopeLines = doc.splitTextToSize(
      d.scope.trim() || '________________',
      right - left
    );
    doc.text(scopeLines, left, y);
    y += Math.min(28, scopeLines.length * 4 + 4);
    doc.setFontSize(8);
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.text(`Est. start: ${d.serviceStart || '—'}`, left, y);
    y += 4;
    doc.text(`Est. complete: ${d.serviceComplete || '—'}`, left, y);
    y += 7;

    ensureSpace(35);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.text('2. Payment Terms', left, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(ink.r, ink.g, ink.b);
    const payCash =
      d.paymentMode === 'cash'
        ? `[X] Cash / insurance proceeds upon completion: $${d.paymentAmount || '________'}`
        : `[ ] Cash / insurance proceeds upon completion: $${d.paymentAmount || '________'}`;
    const payIns =
      d.paymentMode === 'insurance'
        ? '[X] Payment upon insurance claim approval / disbursement (direct pay authorized if applicable).'
        : '[ ] Payment upon insurance claim approval / disbursement (direct pay authorized if applicable).';
    doc.text(payCash, left, y);
    y += 4;
    doc.text(payIns, left, y);
    y += 4;
    doc.setTextColor(muted.r, muted.g, muted.b);
    const payNote = doc.splitTextToSize(
      'Client remains financially responsible if the insurance provider denies or reduces the claim. Payment is due Net 15 of completed work.',
      right - left
    );
    doc.text(payNote, left, y);
    y += payNote.length * 3.6 + 5;

    ensureSpace(35);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.text('3. Limitation of Liability', left, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(muted.r, muted.g, muted.b);
    const lim = doc.splitTextToSize(
      `Mitigation / emergency repairs are temporary and intended to prevent further damage until permanent repairs can be made. ${partyRole} is not liable for pre-existing damage or consequential / incidental damages from weather, pre-existing conditions, or limitations of temporary repairs. Client agrees to hold harmless and indemnify ${partyRole} from claims arising from performance of these services.`,
      right - left
    );
    doc.text(lim, left, y);
    y += lim.length * 3.6 + 5;

    ensureSpace(25);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.text('4. Access and Authorization', left, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.text(
      `Client grants ${partyRole} access to the property and authorizes actions needed to perform mitigation work.`,
      left,
      y
    );
    y += 7;

    ensureSpace(25);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.text('5. Entire Agreement · Electronic signature', left, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(muted.r, muted.g, muted.b);
    const entire = doc.splitTextToSize(
      'This Agreement constitutes the full understanding between the parties and supersedes prior agreements. By signing below, Client agrees that an electronic signature (including a drawn signature captured on a device) is the legal equivalent of a handwritten signature.',
      right - left
    );
    doc.text(entire, left, y);
    y += entire.length * 3.6 + 10;

    ensureSpace(55);
    const sigW = (right - left - 10) / 2;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.text('CLIENT — ELECTRONIC SIGNATURE', left, y);
    doc.text(partyRole.toUpperCase(), left + sigW + 10, y);
    y += 3;
    if (d.clientSignatureDataUrl) {
      try {
        doc.addImage(d.clientSignatureDataUrl, 'PNG', left, y, sigW, 18);
      } catch {
        doc.setDrawColor(rule.r, rule.g, rule.b);
        doc.line(left, y + 16, left + sigW, y + 16);
      }
    } else {
      doc.setDrawColor(rule.r, rule.g, rule.b);
      doc.line(left, y + 16, left + sigW, y + 16);
    }
    doc.setDrawColor(rule.r, rule.g, rule.b);
    doc.line(left + sigW + 10, y + 16, right, y + 16);
    y += 20;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(ink.r, ink.g, ink.b);
    const signerLabel =
      d.signerName.trim() || d.clientName.trim() || '__________';
    doc.text(`Signed by: ${signerLabel}`, left, y);
    doc.text(brandName, left + sigW + 10, y);
    y += 4;
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.text(
      d.clientSignatureDataUrl
        ? `Electronically signed ${signedAtDisp || '__________'}`
        : `Date: ${d.date || '__________'}`,
      left,
      y
    );
    doc.text(`Date: ${d.date || '__________'}`, left + sigW + 10, y);

    // Footer — same placement as mitigation invoice
    doc.setFontSize(7);
    doc.setTextColor(160, 160, 165);
    const footerBits = [
      'Mitigation Service Agreement',
      entity === 'prowest' && (companySettings.address || '').trim()
        ? (companySettings.address || '').trim()
        : '',
      entity === 'prowest' && (companySettings.phone || '').trim()
        ? displayPhoneUS(companySettings.phone) ||
          (companySettings.phone || '').trim()
        : '',
      entity === 'prowest' && (companySettings.fax || '').trim()
        ? `Fax ${displayPhoneUS(companySettings.fax) || (companySettings.fax || '').trim()}`
        : '',
      entity === 'prowest' && (companySettings.license || '').trim()
        ? `ROC# ${(companySettings.license || '').trim()}`
        : '',
    ].filter(Boolean);
    doc.text(footerBits.join(' · ') || 'Mitigation Service Agreement', pageW / 2, pageH - 10, {
      align: 'center',
    });

    const safeName =
      d.clientName.replace(/[^\w]+/g, '_').replace(/^_|_$/g, '') || 'Client';
    const fileName = `Mitigation_Service_Agreement_${safeName}.pdf`;
    const blob = doc.output('blob');

    if (doDownload) {
      doc.save(fileName);
      if (!wantSave) showToast('Mitigation Service Agreement PDF downloaded');
    }

    if (!wantSave) return;

    const leadIdAtSave = currentLeadId;
    if (leadIdAtSave == null) {
      showToast('Select a lead before saving');
      doc.save(fileName);
      return;
    }
    if (!supabaseEnabled || !supabase) {
      showToast('Cloud offline — downloading PDF instead');
      doc.save(fileName);
      return;
    }
    try {
      const lead = leads.find((l) => l.id === leadIdAtSave);
      if (!lead) {
        showToast('Lead not found');
        return;
      }
      const folderKey = lead.supabaseId?.trim() || String(leadIdAtSave);
      const id = `esa-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const storagePath = `${folderKey}/agreements/${id}-${fileName}`;
      const { error: upErr } = await supabase.storage
        .from('lead-docs')
        .upload(storagePath, blob, {
          cacheControl: '3600',
          upsert: false,
          contentType: 'application/pdf',
        });
      if (upErr) {
        console.error(upErr);
        showToast('Cloud save failed — downloading PDF instead');
        doc.save(fileName);
        return;
      }
      const { data: pub } = supabase.storage
        .from('lead-docs')
        .getPublicUrl(storagePath);
      const stamp = new Date().toISOString();
      const docEntry: LeadDocument = {
        id,
        name: fileName,
        url: pub.publicUrl,
        size: blob.size,
        mimeType: 'application/pdf',
        createdAt: stamp,
      };
      const updated = leads.map((l) =>
        l.id === leadIdAtSave
          ? { ...l, documents: [...(l.documents || []), docEntry] }
          : l
      );
      persistLeads(updated);
      showToast('Mitigation Service Agreement saved to lead Documents');
      exitLeadDocumentWorkspace({ returnTab: 'documents' });
    } catch (err) {
      console.error(err);
      showToast('Save failed — downloading PDF instead');
      doc.save(fileName);
    }
  };

  // If workspace is set without a draft (e.g. stale state), re-init with lead
  useEffect(() => {
    if (
      (systemDocWorkspace === 'mitigation' ||
        systemDocWorkspace === 'mitigation_personal' ||
        systemDocWorkspace === 'mitigation_company') &&
      !mitigationDraft
    ) {
      if (currentLeadId != null) {
        openMitigationWorkspace('personal', currentLeadId);
      } else {
        setSystemDocWorkspace(null);
        setInvoicePickerMode(true);
        setShowEstimatePicker(true);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- init draft once when workspace opens empty
  }, [systemDocWorkspace]);

  const openMitigationInvoice = (
    kind: 'personal' | 'company',
    opts?: { blank?: boolean }
  ) => {
    const lead =
      currentLeadId != null
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
    const entity: MitigationEntity =
      kind === 'company' ? 'prowest' : 'roslie';
    const draft: MitigationInvoiceDraft = {
      entity,
      rateMode: 'insurance',
      invoiceFor: name,
      location: addr,
      job: lead?.jobNumber || '',
      claimNumber: '',
      date: new Date().toLocaleDateString(),
      lines: [],
      notes:
        'Work performed to mitigate any further damages.\nLabor is included — price covers materials, labor, and roof access / set up.\nPlease forward to Insurance Company for reimbursement.',
    };
    setMitigationDraft(draft);
    setActiveTarpGroupId(null);
    if (opts?.blank) {
      // blank PDF only (company library / quick download)
      setTimeout(() => generateMitigationPdf({ blank: true, entity }), 0);
      return;
    }
    // Full-page workspace (not popup)
    setSystemDocWorkspace('mitigation');
    setShowMitigationInvoice(false);
  };

  /** Alias used by phase-1 entry points */
  const startMitigationInvoice = (leadId?: number | null) => {
    if (leadId != null && leadId !== currentLeadId) {
      setCurrentLeadId(leadId);
    }
    openMitigationWorkspace('personal');
  };

  const repriceMitigationLines = (
    draft: MitigationInvoiceDraft,
    mode: 'insurance' | 'cash'
  ): MitigationInvoiceDraft => {
    const lines = (draft.lines || []).map((ln) => {
      const priceKey =
        ln.itemKey === 'fascia_wrap'
          ? mitigationFasciaPriceKey(ln.fasciaEdge)
          : ln.itemKey;
      const row = mitigationPriceForKey(priceKey);
      const unit = row
        ? mode === 'cash'
          ? Number(row.cash_retail) || 0
          : Number(row.insurance_rate) || 0
        : ln.unitPrice;
      const qty = Number(ln.qty) || 0;
      return {
        ...ln,
        unitPrice: unit,
        amount: mitigationLineAmount(unit, qty, ln.itemKey, ln.fasciaEdge),
        label: formatMitigationLineDescription({
          itemKey: ln.itemKey,
          label: ln.label,
          qty,
          tarpType: ln.tarpType,
          fasciaEdge: ln.fasciaEdge,
        }),
      };
    });
    return { ...draft, rateMode: mode, lines };
  };

  const setMitigationRateMode = (mode: 'insurance' | 'cash') => {
    if (!mitigationDraft) return;
    setMitigationDraft(repriceMitigationLines(mitigationDraft, mode));
  };

  
  const mitigationPriceForKey = (itemKey: string) => {
    const aliases: Record<string, string[]> = {
      trip_planned: ['trip_planned', 'trip', 'planned_trip', 'trip_standard'],
      trip_emergency: [
        'trip_emergency',
        'trip_after_hours',
        'emergency_trip',
        'after_hours_trip',
      ],
      trip_additional: ['trip_additional', 'trip_extra', 'additional_trip'],
      eave_install: ['eave_install', 'eave_rake_install'],
      rake_install: ['rake_install', 'eave_rake_install'],
      hip_install: ['hip_install', 'eave_rake_install', 'ridge_install'],
      // Only used if shingle_tuck row missing — prefer dedicated $100/$75 after SQL
      shingle_tuck: ['shingle_tuck'],
      obst_pipe_jack: ['obst_pipe_jack', 'obstruction'],
      obst_ttop_vent: ['obst_ttop_vent', 'obst_vent', 'obstruction'],
      obst_hvac: ['obst_hvac', 'obstruction'],
      obst_skylight: ['obst_skylight', 'obstruction'],
      sandbag_25lb: ['sandbag_25lb'],
      fascia_wrap_eave_rake: ['fascia_wrap_eave_rake', 'fascia_wrap'],
    };
    const keys = aliases[itemKey] || [itemKey];
    for (const k of keys) {
      const row = mitigationPrices.find((r) => r.item_key === k);
      if (row) return row;
    }
    return undefined;
  };

  const mitigationCostForKey = (itemKey: string): number | null => {
    if (!itemKey) return null;
    const row = mitigationCosts.find((r) => r.item_key === itemKey);
    if (!row || row.cost == null || Number.isNaN(Number(row.cost))) return null;
    return Number(row.cost);
  };

  const mitigationCostKeyForLine = (line: {
    itemKey: string;
    tarpType?: 'blue' | 'brown' | null;
  }) => {
    if (
      line.itemKey?.startsWith('tarp_') &&
      (line.tarpType === 'blue' || line.tarpType === 'brown')
    ) {
      // sell key tarp_6x8 → cost key tarp_blue_6x8 / tarp_brown_6x8
      const size = line.itemKey.replace(/^tarp_/, '');
      return `tarp_${line.tarpType}_${size}`;
    }
    return line.itemKey;
  };

  const mitigationLineCost = (line: {
    itemKey: string;
    qty: number;
    tarpType?: 'blue' | 'brown' | null;
  }) => {
    const key = mitigationCostKeyForLine(line);
    const unit = mitigationCostForKey(key);
    if (unit == null) return null;
    return unit * (Number(line.qty) || 0);
  };

  const mitigationSellTotal = (mitigationDraft?.lines || []).reduce(
    (s, l) => s + (Number(l.amount) || 0),
    0
  );
  const mitigationCostTotal = (mitigationDraft?.lines || []).reduce((s, l) => {
    const c = mitigationLineCost(l);
    return s + (c == null ? 0 : c);
  }, 0);
  /** List sell (line items) vs negotiated (after buffer discount). */
  const mitigationListSell = mitigationSellTotal;
  const mitigationNegotiated =
    mitigationDraft?.negotiatedTotal != null &&
    Number.isFinite(Number(mitigationDraft.negotiatedTotal))
      ? Number(mitigationDraft.negotiatedTotal)
      : mitigationListSell;
  const mitigationBufferUsed = Math.max(
    0,
    mitigationListSell - mitigationNegotiated
  );
  const mitigationBufferRemaining = Math.max(
    0,
    MITIGATION_BUFFER_CAP - mitigationBufferUsed
  );
  const mitigationBufferUsedPct = Math.min(
    100,
    Math.round((mitigationBufferUsed / MITIGATION_BUFFER_CAP) * 100)
  );
  /** Margin uses negotiated sell (what customer pays). */
  const mitigationMargin = mitigationNegotiated - mitigationCostTotal;

  const applyMitigationNegotiatedTotal = () => {
    if (!mitigationDraft) return;
    const floor = Math.max(0, mitigationListSell - MITIGATION_BUFFER_CAP);
    const next = Math.round(
      Math.min(
        mitigationListSell,
        Math.max(floor, Number(mitigationDraft.negotiatedTotal) || 0)
      )
    );
    setMitigationDraft({ ...mitigationDraft, negotiatedTotal: next });
    showToast(
      next < mitigationListSell
        ? `Discount applied — $${(mitigationListSell - next).toLocaleString()}`
        : 'Using full list sell total'
    );
  };

  const addMitigationCatalogLine = (
    itemKey: string,
    label: string,
    tarpType?: 'blue' | 'brown' | null,
    opts?: {
      groupId?: string | null;
      fasciaEdge?: FasciaEdge | null;
    }
  ) => {
    if (!mitigationDraft) return;

    // Combined install dropdown uses fascia_wrap:eave | :rake | :eave_rake
    let resolvedKey = itemKey;
    let fasciaEdge = opts?.fasciaEdge ?? null;
    if (itemKey.startsWith('fascia_wrap:')) {
      const edge = itemKey.slice('fascia_wrap:'.length) as FasciaEdge;
      resolvedKey = 'fascia_wrap';
      fasciaEdge = edge;
    }

    const row = mitigationPriceForKey(
      resolvedKey === 'fascia_wrap'
        ? mitigationFasciaPriceKey(fasciaEdge)
        : resolvedKey
    );
    const mode = mitigationDraft.rateMode || 'insurance';
    const unit = row
      ? mode === 'cash'
        ? Number(row.cash_retail) || 0
        : Number(row.insurance_rate) || 0
      : 0;
    const isTarp = resolvedKey.startsWith('tarp_');
    const needsGroup =
      isTarp || MITIGATION_TARP_SCOPED_KEYS.has(resolvedKey);

    let groupId = opts?.groupId ?? null;
    let groupLabel: string | null = null;

    if (isTarp) {
      groupId = `tg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const tarpCount =
        (mitigationDraft.lines || []).filter((l) =>
          l.itemKey.startsWith('tarp_')
        ).length + 1;
      groupLabel = `Tarp ${tarpCount}`;
    } else if (needsGroup) {
      groupId =
        opts?.groupId ||
        activeTarpGroupId ||
        [...(mitigationDraft.lines || [])]
          .reverse()
          .find((l) => l.itemKey.startsWith('tarp_'))?.groupId ||
        null;
      if (!groupId) {
        showToast('Add a tarp first — installs attach to that tarp');
        return;
      }
      const tarpLine = (mitigationDraft.lines || []).find(
        (l) => l.groupId === groupId && l.itemKey.startsWith('tarp_')
      );
      groupLabel = tarpLine?.groupLabel || null;
    }

    if (resolvedKey === 'fascia_wrap' && !fasciaEdge) {
      showToast('Choose fascia wrap edge — eave, rake, or both');
      return;
    }

    const qty = 1;
    const line: MitigationLineItem = {
      id: newClientId(`mit-${resolvedKey}`),
      itemKey: resolvedKey,
      label: formatMitigationLineDescription({
        itemKey: resolvedKey,
        label: row?.label || label,
        qty,
        tarpType: isTarp ? tarpType || 'blue' : null,
        fasciaEdge,
      }),
      qty,
      unitPrice: unit,
      amount: mitigationLineAmount(unit, qty, resolvedKey, fasciaEdge),
      tarpType: isTarp ? tarpType || 'blue' : null,
      groupId,
      groupLabel,
      fasciaEdge,
    };

    if (isTarp || (needsGroup && groupId)) {
      setActiveTarpGroupId(groupId);
    }

    setMitigationDraft((prev) => {
      if (!prev) return prev;
      if (resolvedKey === 'obstruction' || resolvedKey.startsWith('obst_')) {
        return {
          ...prev,
          obstructionChoice: 'yes',
          lines: [...prev.lines, line],
        };
      }
      return { ...prev, lines: [...prev.lines, line] };
    });
  };

  const addMitigationLine = (itemKey: string) => {
    if (!mitigationDraft) return;
    const row = mitigationPriceForKey(itemKey);
    if (!row) return;
    const unit =
      mitigationDraft.rateMode === 'cash'
        ? Number(row.cash_retail) || 0
        : Number(row.insurance_rate) || 0;
    const line: MitigationLineItem = {
      id: `${Date.now()}-${itemKey}`,
      itemKey,
      label: formatMitigationLineDescription({
        itemKey,
        label: row.label,
        qty: 1,
      }),
      qty: 1,
      unitPrice: unit,
      amount: unit,
      groupId: null,
    };
    setMitigationDraft({
      ...mitigationDraft,
      lines: [...mitigationDraft.lines, line],
    });
  };

  const updateMitigationLineQty = (id: string, qty: number) => {
    if (!mitigationDraft) return;
    const q = Math.max(0, qty);
    setMitigationDraft({
      ...mitigationDraft,
      lines: mitigationDraft.lines.map((ln) =>
        ln.id === id
          ? {
              ...ln,
              qty: q,
              amount: mitigationLineAmount(
                ln.unitPrice,
                q,
                ln.itemKey,
                ln.fasciaEdge
              ),
              label: formatMitigationLineDescription({
                itemKey: ln.itemKey,
                label: ln.label,
                qty: q,
                tarpType: ln.tarpType,
                fasciaEdge: ln.fasciaEdge,
              }),
            }
          : ln
      ),
    });
  };

  const removeMitigationLine = (id: string) => {
    if (!mitigationDraft) return;
    const removed = mitigationDraft.lines.find((ln) => ln.id === id);
    // Removing a tarp removes its whole group
    const dropGroup =
      removed?.itemKey?.startsWith('tarp_') && removed.groupId
        ? removed.groupId
        : null;
    const nextLines = mitigationDraft.lines.filter((ln) => {
      if (ln.id === id) return false;
      if (dropGroup && ln.groupId === dropGroup) return false;
      return true;
    });
    setMitigationDraft({
      ...mitigationDraft,
      lines: nextLines,
      obstructionChoice:
        removed?.itemKey === 'obstruction' ||
        removed?.itemKey?.startsWith('obst_')
          ? nextLines.some(
              (l) =>
                l.itemKey === 'obstruction' || l.itemKey.startsWith('obst_')
            )
            ? 'yes'
            : null
          : mitigationDraft.obstructionChoice,
    });
    if (dropGroup && activeTarpGroupId === dropGroup) {
      const nextActive = [...nextLines]
        .reverse()
        .find((l) => l.itemKey.startsWith('tarp_'))?.groupId;
      setActiveTarpGroupId(nextActive || null);
    }
  };

  const removeMitigationTarpGroup = (groupId: string) => {
    if (!mitigationDraft || !groupId) return;
    const nextLines = mitigationDraft.lines.filter(
      (ln) => ln.groupId !== groupId
    );
    setMitigationDraft({ ...mitigationDraft, lines: nextLines });
    if (activeTarpGroupId === groupId) {
      const nextActive = [...nextLines]
        .reverse()
        .find((l) => l.itemKey.startsWith('tarp_'))?.groupId;
      setActiveTarpGroupId(nextActive || null);
    }
  };

  const generateMitigationPdf = (opts?: {
    blank?: boolean;
    entity?: MitigationEntity;
    /** Browser file download */
    download?: boolean;
    /** Append PDF to lead Documents + Invoices index */
    save?: boolean;
  }) => {
    const entity: MitigationEntity =
      opts?.entity || mitigationDraft?.entity || 'roslie';
    const d = mitigationDraft;
    const blank = opts?.blank === true;
    // Explicit flags from UI; blank template = download only
    // Legacy no-opts call: both download + save
    const legacyBoth =
      !blank && opts?.download === undefined && opts?.save === undefined;
    const wantDownload = blank || opts?.download === true || legacyBoth;
    const wantSave = !blank && (opts?.save === true || legacyBoth);
    const doc = new jsPDF({ unit: 'mm', format: 'letter' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const left = 18;
    const right = pageW - 18;
    const ink = { r: 28, g: 28, b: 30 };
    const muted = { r: 100, g: 100, b: 105 };
    const rule = { r: 190, g: 190, b: 195 };
    const title = mitigationInvoiceTitle(entity);
    const payable = mitigationPayableTo(entity);
    const brandName = mitigationBillingBrand(entity);
    const brandSub = mitigationBrandSub(entity);
    const brandPhone = mitigationBrandPhone(entity);
    const money = (n: number) =>
      `$${Number(n).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;

    // --- Header: company logo only for company billing; else Summit ---
    let y = 16;
    const logoW = drawDocLogo(doc, left, y, {
      logoDataUrl:
        entity === 'prowest' ? (companySettings.logoDataUrl || '').trim() : '',
    });
    const textX = left + logoW + 4;

    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text(brandName, textX, y + 5.5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(muted.r, muted.g, muted.b);
    const mitSubBits = [brandSub, brandPhone].filter(Boolean);
    if (mitSubBits[0]) doc.text(mitSubBits[0], textX, y + 10.5);
    if (mitSubBits[1]) doc.text(mitSubBits[1], textX, y + 14.5);
    else if (
      entity === 'prowest' &&
      (companySettings.address || '').trim() &&
      !brandSub
    ) {
      doc.text((companySettings.address || '').trim(), textX, y + 10.5);
      if (brandPhone) doc.text(brandPhone, textX, y + 14.5);
    }

    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('INVOICE', right, y + 6, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.text(title, right, y + 11.5, { align: 'right' });
    doc.text(
      d?.date || new Date().toLocaleDateString(),
      right,
      y + 16,
      { align: 'right' }
    );

    y = 38;
    doc.setDrawColor(rule.r, rule.g, rule.b);
    doc.setLineWidth(0.4);
    doc.line(left, y, right, y);
    y += 8;

    // --- Bill-to / job meta ---
    const metaLeft = left;
    const metaRight = pageW / 2 + 4;
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text('INVOICE FOR', metaLeft, y);
    doc.text('PAYABLE TO', metaRight, y);
    y += 5;
    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(blank ? '—' : d?.invoiceFor || '—', metaLeft, y);
    doc.text(payable, metaRight, y);
    y += 8;
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text('LOCATION', metaLeft, y);
    doc.text('JOB / CLAIM', metaRight, y);
    y += 5;
    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const locLines = doc.splitTextToSize(
      blank ? '—' : d?.location || '—',
      pageW / 2 - 28
    );
    doc.text(locLines, metaLeft, y);
    doc.text(`Job: ${blank ? '—' : d?.job || '—'}`, metaRight, y);
    doc.text(
      `Claim: ${blank ? '—' : d?.claimNumber || '—'}`,
      metaRight,
      y + 5
    );
    y += Math.max(12, locLines.length * 5 + 6);

    // Company billing: Project Manager from Settings (1099 PM under ProWest)
    if (showCompanyPmOnDoc(entity)) {
      const pmName = estimatePmName();
      const pmPhone = estimatePmPhone();
      const pmEmail = (companySettings.projectManagerEmail || '').trim();
      doc.setTextColor(muted.r, muted.g, muted.b);
      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');
      doc.text('PROJECT MANAGER', metaLeft, y);
      y += 5;
      doc.setTextColor(ink.r, ink.g, ink.b);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.text(pmName || '—', metaLeft, y);
      doc.setTextColor(muted.r, muted.g, muted.b);
      doc.setFontSize(9);
      let pmY = y + 5;
      if (pmPhone) {
        doc.text(pmPhone, metaLeft, pmY);
        pmY += 4;
      }
      if (pmEmail) {
        doc.text(pmEmail, metaLeft, pmY);
        pmY += 4;
      }
      y = pmPhone || pmEmail ? pmY + 2 : y + 6;
      y += 2;
    }

    // --- Line table header ---
    doc.setFillColor(245, 245, 246);
    doc.rect(left, y - 4, right - left, 8, 'F');
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.text('DESCRIPTION', left + 2, y + 1);
    doc.text('AMOUNT', right - 2, y + 1, { align: 'right' });
    y += 8;
    doc.setDrawColor(rule.r, rule.g, rule.b);
    doc.setLineWidth(0.25);
    doc.line(left, y, right, y);
    y += 6;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(ink.r, ink.g, ink.b);
    let total = 0;
    if (blank || !d?.lines?.length) {
      doc.setTextColor(muted.r, muted.g, muted.b);
      doc.text(
        blank
          ? 'Blank template — fill as needed'
          : 'No line items',
        left + 2,
        y
      );
      doc.setTextColor(ink.r, ink.g, ink.b);
      y += 10;
    } else {
      // Order: each tarp group (tarp first, then installs), then house-level lines
      const lines = d.lines;
      const groupOrder: string[] = [];
      for (const ln of lines) {
        if (ln.groupId && !groupOrder.includes(ln.groupId)) {
          groupOrder.push(ln.groupId);
        }
      }
      const ordered: typeof lines = [];
      for (const gid of groupOrder) {
        const inGroup = lines.filter((l) => l.groupId === gid);
        const tarp = inGroup.filter((l) => l.itemKey.startsWith('tarp_'));
        const rest = inGroup.filter((l) => !l.itemKey.startsWith('tarp_'));
        ordered.push(...tarp, ...rest);
      }
      ordered.push(...lines.filter((l) => !l.groupId));

      let lastGroup: string | null | undefined = undefined;
      for (const line of ordered) {
        const gid = line.groupId || null;
        if (gid && gid !== lastGroup) {
          if (lastGroup !== undefined) y += 3;
          const gLabel =
            line.groupLabel ||
            lines.find((l) => l.groupId === gid && l.groupLabel)?.groupLabel ||
            '';
          if (gLabel) {
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(8);
            doc.setTextColor(muted.r, muted.g, muted.b);
            doc.text(gLabel.toUpperCase(), left + 2, y);
            y += 5;
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(10);
            doc.setTextColor(ink.r, ink.g, ink.b);
          }
          lastGroup = gid;
        } else if (!gid && lastGroup) {
          y += 3;
          lastGroup = null;
        }

        const label = formatMitigationLineDescription(line);
        const wrapped = doc.splitTextToSize(label, right - left - 40);
        doc.text(wrapped, left + 2, y);
        doc.text(money(Number(line.amount) || 0), right - 2, y, {
          align: 'right',
        });
        total += Number(line.amount) || 0;
        y += Math.max(7, wrapped.length * 4.8);
        if (y > pageH - 70) {
          doc.addPage();
          y = 20;
        }
      }
    }

    y += 4;
    doc.setDrawColor(rule.r, rule.g, rule.b);
    doc.line(left, y, right, y);
    y += 8;

    // --- Notes ---
    const notesText =
      d?.notes ||
      'Work performed to mitigate any further damages.\nLabor is included — price covers materials, labor, and roof access / set up.\nPlease forward to Insurance Company for reimbursement.';
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.text('NOTES', left, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(ink.r, ink.g, ink.b);
    for (const n of notesText.split('\n')) {
      const wrapped = doc.splitTextToSize(n, right - left);
      doc.text(wrapped, left, y);
      y += Math.max(4.5, wrapped.length * 4.2);
    }
    y += 8;

    // --- Totals ---
    const listTotal = total;
    const negotiatedRaw =
      d?.negotiatedTotal != null && Number.isFinite(Number(d.negotiatedTotal))
        ? Number(d.negotiatedTotal)
        : listTotal;
    const finalTotal = Math.min(listTotal, Math.max(0, negotiatedRaw));
    const discount = Math.max(0, listTotal - finalTotal);
    const totalsX = right - 70;
    if (discount > 0) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(muted.r, muted.g, muted.b);
      doc.text('List total', totalsX, y);
      doc.text(money(listTotal), right - 2, y, { align: 'right' });
      y += 5;
      doc.text('Special discount', totalsX, y);
      doc.text(`−${money(discount).slice(1)}`, right - 2, y, {
        align: 'right',
      });
      y += 7;
    }
    doc.setDrawColor(ink.r, ink.g, ink.b);
    doc.setLineWidth(0.5);
    doc.line(totalsX, y - 2, right, y - 2);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.text('Total amount due', totalsX, y + 4);
    doc.text(blank ? '—' : money(finalTotal), right - 2, y + 4, {
      align: 'right',
    });
    y += 16;

    // --- Signature ---
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.text('Authorized signature', left, y);
    y += 10;
    doc.setDrawColor(rule.r, rule.g, rule.b);
    doc.setLineWidth(0.35);
    doc.line(left, y, left + 70, y);
    y += 5;
    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.setFontSize(9);
    doc.text(brandName, left, y);
    y += 4;
    const sigSub = [brandSub, brandPhone].filter(Boolean).join('  ·  ');
    if (sigSub) {
      doc.setTextColor(muted.r, muted.g, muted.b);
      doc.setFontSize(8);
      doc.text(sigSub, left, y);
    }

    // Footer
    doc.setFontSize(7);
    doc.setTextColor(160, 160, 165);
    doc.text(
      'Mitigation invoice · costs are internal and not shown on this document',
      pageW / 2,
      pageH - 10,
      { align: 'center' }
    );

    const fileName = `${title.replace(/\s+/g, '_')}_${
      blank ? 'BLANK' : d?.job || 'draft'
    }.pdf`;
    const blob = doc.output('blob');

    if (wantDownload) {
      doc.save(fileName);
    }

    if (blank) {
      showToast('Blank template downloaded');
      return;
    }

    if (wantSave) {
      if (currentLeadId == null) {
        showToast('Select a lead before saving the invoice');
        return;
      }
      const lead = leads.find((l) => l.id === currentLeadId);
      if (!lead) {
        showToast('Lead not found');
        return;
      }
      const leadLabel =
        [lead.clientFirstName, lead.clientLastName]
          .filter(Boolean)
          .join(' ') ||
        lead.jobNumber ||
        'Lead';
      const leadIdAtSave = currentLeadId;
      const entityAtSave = entity;
      const totalAtSave = finalTotal;
      const draftSnap = d;

      void (async () => {
        try {
          if (!supabaseEnabled || !supabase) {
            showToast('Cloud offline — downloading PDF instead');
            doc.save(fileName);
            return;
          }

          const folderKey = lead.supabaseId?.trim() || String(leadIdAtSave);
          const id = `inv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
          const storagePath = `${folderKey}/invoices/${id}-${fileName}`;
          const { error: upErr } = await supabase.storage
            .from('lead-docs')
            .upload(storagePath, blob, {
              cacheControl: '3600',
              upsert: false,
              contentType: 'application/pdf',
            });
          if (upErr) {
            console.error('Mitigation invoice upload error', upErr);
            showToast('Cloud save failed — downloading PDF instead');
            doc.save(fileName);
            return;
          }

          const { data: pub } = supabase.storage
            .from('lead-docs')
            .getPublicUrl(storagePath);
          const durableUrl = pub.publicUrl;
          const stamp = new Date().toISOString();

          const docEntry: LeadDocument = {
            id,
            name: fileName,
            url: durableUrl,
            size: blob.size,
            mimeType: 'application/pdf',
            createdAt: stamp,
          };
          const updated = leads.map((l) =>
            l.id === leadIdAtSave
              ? { ...l, documents: [...(l.documents || []), docEntry] }
              : l
          );
          persistLeads(updated);

          const inv: AppInvoice = {
            id: docEntry.id,
            createdAt: stamp,
            title,
            entity: entityAtSave,
            rateMode: draftSnap?.rateMode || 'insurance',
            leadId: leadIdAtSave,
            leadLabel,
            job: draftSnap?.job || '',
            claimNumber: draftSnap?.claimNumber || '',
            total: totalAtSave,
            fileName,
            url: durableUrl,
          };
          persistAppInvoices([inv, ...appInvoices]);
          showToast('Saved to lead Documents + Invoices');

          exitLeadDocumentWorkspace({ returnTab: 'documents' });
        } catch (err) {
          console.error('Mitigation save error', err);
          showToast('Save failed — downloading PDF instead');
          doc.save(fileName);
        }
      })();
      return;
    }

    if (wantDownload) {
      showToast('PDF downloaded');
    }
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

      let localProfile = {
        name: '',
        title: '',
        company: '',
        phone: '',
        email: '',
      };
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
          localProfile = {
            name: p.name || '',
            title: p.title || '',
            company: p.company || '',
            phone: p.phone || '',
            email: p.email || '',
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

      let localCompany = emptyCompanySettings();
      try {
        const cs = localStorage.getItem('summitCompanySettings');
        if (cs) {
          const c = JSON.parse(cs) as Partial<CompanySettings> & {
            brandName?: string;
            legalName?: string;
          };
          localCompany = normalizeCompanySettings(c);
          setCompanySettings(localCompany);
        }
      } catch {
        /* ignore */
      }

      // Cloud merge (keeps local cache; does not wipe until round-trip works)
      if (supabaseEnabled && supabase) {
        void (async () => {
          try {
            const [cloudProfile, cloudCompany] = await Promise.all([
              loadCloudUserProfile(supabase),
              loadCloudCompanySettings(supabase),
            ]);
            if (cloudProfile) {
              const name = (cloudProfile.name || '').trim() || localProfile.name;
              const title =
                (cloudProfile.title || '').trim() || localProfile.title;
              const company =
                (cloudProfile.company || '').trim() || localProfile.company;
              const phone =
                (cloudProfile.phone || '').trim() || localProfile.phone;
              const email =
                (cloudProfile.email || '').trim() || localProfile.email;
              if (name) setUserName(name);
              if (title) setUserTitle(title);
              if (company) setUserCompany(company);
              if (phone) setUserPhone(displayPhoneUS(phone));
              if (email) setUserEmail(email);
              try {
                localStorage.setItem(
                  'summitUserProfile',
                  JSON.stringify({ name, title, company, phone, email })
                );
              } catch {
                /* ignore */
              }
            }
            if (cloudCompany) {
              const merged = mergeCompanySettings(
                localCompany,
                normalizeCompanySettings(cloudCompany)
              );
              setCompanySettings(merged);
              try {
                localStorage.setItem(
                  'summitCompanySettings',
                  JSON.stringify(merged)
                );
              } catch {
                /* ignore */
              }
            }
          } catch (err) {
            console.error('Settings cloud load failed:', err);
          }
        })();
      }

      const storedTheme = readStoredThemePref();
      setThemePref(storedTheme);
      const mode = resolveThemeMode(storedTheme);
      setThemeMode(mode);
      applyThemeMode(mode);

      try {
        const savedLists = localStorage.getItem(SUMMIT_TASK_LISTS_KEY);
        const lists = normalizeStoredTaskLists(
          savedLists ? JSON.parse(savedLists) : null
        );
        persistTaskLists(lists);
        const savedActive = localStorage.getItem(SUMMIT_ACTIVE_TASK_LIST_KEY);
        const activeId =
          savedActive && lists.some((l) => l.id === savedActive)
            ? savedActive
            : lists[0]?.id || DEFAULT_TASK_LIST_ID;
        persistActiveTaskListId(activeId);
        const savedTasks = localStorage.getItem(SUMMIT_TASKS_KEY);
        if (savedTasks) {
          persistTasks(normalizeStoredTasks(JSON.parse(savedTasks)));
        }
        const savedCalEvents = localStorage.getItem(SUMMIT_CALENDAR_EVENTS_KEY);
        if (savedCalEvents) {
          persistCalendarEvents(
            normalizeStoredCalendarEvents(JSON.parse(savedCalEvents))
          );
        }
        setCalendarViewMode(readStoredCalendarView());

        // Cloud backup for calendar + tasks (merge over local when present)
        if (supabaseEnabled && supabase) {
          void (async () => {
            try {
              const [cloudEvents, cloudTasks] = await Promise.all([
                loadCloudCalendarEvents(supabase),
                loadCloudTasksBundle(supabase),
              ]);
              if (cloudEvents && cloudEvents.length) {
                const normalized = normalizeStoredCalendarEvents(cloudEvents);
                if (normalized.length) {
                  setCalendarEvents(normalized);
                  try {
                    localStorage.setItem(
                      SUMMIT_CALENDAR_EVENTS_KEY,
                      JSON.stringify(normalized)
                    );
                  } catch {
                    /* ignore */
                  }
                }
              } else {
                // Seed cloud from this device when backup is empty
                try {
                  const raw = localStorage.getItem(SUMMIT_CALENDAR_EVENTS_KEY);
                  const local = normalizeStoredCalendarEvents(
                    raw ? JSON.parse(raw) : []
                  );
                  if (local.length) {
                    await saveCloudCalendarEvents(supabase, local);
                  }
                } catch {
                  /* ignore */
                }
              }
              if (cloudTasks) {
                const lists = normalizeStoredTaskLists(cloudTasks.lists);
                if (lists.length) {
                  setTaskLists(lists);
                  try {
                    localStorage.setItem(
                      SUMMIT_TASK_LISTS_KEY,
                      JSON.stringify(lists)
                    );
                  } catch {
                    /* ignore */
                  }
                }
                const t = normalizeStoredTasks(cloudTasks.tasks);
                if (t.length) {
                  setTasks(t);
                  try {
                    localStorage.setItem(SUMMIT_TASKS_KEY, JSON.stringify(t));
                  } catch {
                    /* ignore */
                  }
                }
                if (
                  cloudTasks.activeListId &&
                  lists.some((l) => l.id === cloudTasks.activeListId)
                ) {
                  persistActiveTaskListId(cloudTasks.activeListId);
                }
                const cloudEmpty =
                  !(cloudTasks.tasks && cloudTasks.tasks.length) &&
                  !(cloudTasks.lists && cloudTasks.lists.length);
                if (cloudEmpty) {
                  try {
                    const rawT = localStorage.getItem(SUMMIT_TASKS_KEY);
                    const rawL = localStorage.getItem(SUMMIT_TASK_LISTS_KEY);
                    const localT = normalizeStoredTasks(
                      rawT ? JSON.parse(rawT) : []
                    );
                    const localL = normalizeStoredTaskLists(
                      rawL ? JSON.parse(rawL) : null
                    );
                    if (localT.length || localL.length) {
                      await saveCloudTasksBundle(supabase, {
                        tasks: localT,
                        lists: localL,
                        activeListId:
                          localStorage.getItem(SUMMIT_ACTIVE_TASK_LIST_KEY) ||
                          DEFAULT_TASK_LIST_ID,
                      });
                    }
                  } catch {
                    /* ignore */
                  }
                }
              } else {
                try {
                  const rawT = localStorage.getItem(SUMMIT_TASKS_KEY);
                  const rawL = localStorage.getItem(SUMMIT_TASK_LISTS_KEY);
                  const localT = normalizeStoredTasks(
                    rawT ? JSON.parse(rawT) : []
                  );
                  const localL = normalizeStoredTaskLists(
                    rawL ? JSON.parse(rawL) : null
                  );
                  if (localT.length || localL.length) {
                    await saveCloudTasksBundle(supabase, {
                      tasks: localT,
                      lists: localL,
                      activeListId:
                        localStorage.getItem(SUMMIT_ACTIVE_TASK_LIST_KEY) ||
                        DEFAULT_TASK_LIST_ID,
                    });
                  }
                } catch {
                  /* ignore */
                }
              }
            } catch (err) {
              console.error('Calendar/tasks cloud load failed:', err);
            }
          })();
        }
      } catch {
        /* ignore */
      }

      const savedLeads = localStorage.getItem('summitLeads');
      const savedTrash = localStorage.getItem('summitTrash');
      // Cloud is source of truth when Supabase is configured — skip stale local leads
      if (!supabaseEnabled) {
        if (savedLeads) {
          try {
            const parsed = JSON.parse(savedLeads) as Array<
              Partial<Lead> & { clientJobNumber?: string }
            >;
            const nextLeads = sanitizeLeads(parsed.map(normalizeLead));
            setLeads(nextLeads);
            try {
              localStorage.setItem('summitLeads', JSON.stringify(nextLeads));
            } catch {
              /* ignore */
            }
          } catch {
            /* ignore */
          }
        }
      }

      // App invoices index (mitigation PDFs)
      try {
        const rawInv = localStorage.getItem('summitAppInvoices');
        if (rawInv) {
          const parsed = JSON.parse(rawInv);
          if (Array.isArray(parsed)) setAppInvoices(parsed as AppInvoice[]);
        }
      } catch {
        /* ignore */
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
              .is('deleted_at', null)
              .order('created_at', { ascending: false });

            // Soft-deleted leads in cloud → keep Trash in sync (source of truth)
            try {
              const { data: trashedRows } = await supabase
                .from('leads')
                .select('*')
                .not('deleted_at', 'is', null)
                .order('deleted_at', { ascending: false });
              if (trashedRows && trashedRows.length > 0) {
                setTrash((prev) => {
                  const next = [...prev];
                  for (const row of trashedRows) {
                    const lead = mapDbLeadToApp(row as Record<string, unknown>);
                    const cloudId = lead.supabaseId?.trim();
                    if (!cloudId) continue;
                    const already = next.some(
                      (t) =>
                        t.kind === 'lead' &&
                        t.lead.supabaseId?.trim() === cloudId
                    );
                    if (already) continue;
                    const deletedAtRaw = (row as Record<string, unknown>)
                      .deleted_at;
                    next.unshift({
                      id: `lead-cloud-${cloudId}`,
                      kind: 'lead',
                      deletedAt:
                        typeof deletedAtRaw === 'string'
                          ? new Date(deletedAtRaw).toLocaleString()
                          : new Date().toLocaleString(),
                      lead,
                    });
                  }
                  try {
                    localStorage.setItem('summitTrash', JSON.stringify(next));
                  } catch {
                    /* ignore */
                  }
                  return next;
                });
              }
            } catch (e) {
              console.error('Supabase trashed leads fetch error:', e);
            }

            if (leadErr) {
              console.error('Supabase leads fetch error:', leadErr);
              const msg = String(leadErr.message || leadErr);
              if (/deleted_at/i.test(msg)) {
                showToast(
                  'Run soft_delete_leads.sql in Supabase SQL Editor, then refresh'
                );
              }
              // Offline fallback: use local cache only if cloud fetch fails
              if (savedLeads) {
                try {
                  const parsed = JSON.parse(savedLeads) as Array<
                    Partial<Lead> & { clientJobNumber?: string }
                  >;
                  const nextLeads = sanitizeLeads(parsed.map(normalizeLead));
                  setLeads(nextLeads);
                  try {
                    localStorage.setItem(
                      'summitLeads',
                      JSON.stringify(nextLeads)
                    );
                  } catch {
                    /* ignore */
                  }
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
              /** Per-lead client ids already claimed while hydrating cloud rows */
              const claimedIdsByLead: Record<string, Set<number>> = {};
              for (const row of estRows) {
                const r = row as Record<string, unknown>;
                const leadKey = r.lead_id != null ? String(r.lead_id) : '';
                if (!leadKey) continue;
                if (!claimedIdsByLead[leadKey]) {
                  claimedIdsByLead[leadKey] = new Set();
                }
                const claimed = claimedIdsByLead[leadKey];
                const rawData = (r.data && typeof r.data === 'object'
                  ? r.data
                  : r) as Partial<Estimate> & { selectedShingle?: string };
                // Never reuse a colliding data.id from another row on this lead
                const fromData =
                  typeof rawData.id === 'number' && Number.isFinite(rawData.id)
                    ? rawData.id
                    : null;
                const fromCloud = stableLeadIdFromDb(r.id);
                let clientId =
                  fromData != null && !claimed.has(fromData)
                    ? fromData
                    : fromCloud;
                if (claimed.has(clientId)) {
                  clientId = newLeadNumericId();
                  while (claimed.has(clientId)) clientId = newLeadNumericId();
                }
                claimed.add(clientId);
                const est: Estimate = {
                  id: clientId,
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
                  pdfDocumentId: rawData.pdfDocumentId
                    ? String(rawData.pdfDocumentId)
                    : undefined,
                  pdfUrl: rawData.pdfUrl ? String(rawData.pdfUrl) : undefined,
                  pdfName: rawData.pdfName
                    ? String(rawData.pdfName)
                    : undefined,
                  supabaseId: r.id != null ? String(r.id) : undefined,
                };
                if (!byLead[leadKey]) byLead[leadKey] = [];
                byLead[leadKey].push(est);
              }
              for (const lead of fromDb) {
                const key = lead.supabaseId || String(lead.id);
                if (byLead[key]?.length) {
                  const prevById = new Map(
                    (lead.estimates || []).map((e) => [e.id, e])
                  );
                  lead.estimates = byLead[key].map((e) => {
                    const prev = prevById.get(e.id);
                    return {
                      ...e,
                      pdfDocumentId: e.pdfDocumentId || prev?.pdfDocumentId,
                      pdfUrl: e.pdfUrl || prev?.pdfUrl,
                      pdfName: e.pdfName || prev?.pdfName,
                    };
                  });
                }
              }
            }

            const safeFromDb = sanitizeLeads(fromDb);
            setLeads(safeFromDb);
            try {
              localStorage.setItem('summitLeads', JSON.stringify(safeFromDb));
            } catch {
              /* ignore quota */
            }
            console.log(
              'Loaded',
              safeFromDb.length,
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

        // mitigation costs (internal only — never on invoice/PDF)
        void (async () => {
          try {
            const { data, error } = await supabase
              .from('mitigation_cost_sheet')
              .select(
                'item_key, label, category, unit, cost, notes, sort_order'
              )
              .eq('active', true)
              .order('sort_order', { ascending: true });
            if (error) throw error;
            setMitigationCosts(
              Array.isArray(data)
                ? data.map(
                    (r: {
                      item_key?: string;
                      label?: string;
                      category?: string;
                      unit?: string | null;
                      cost?: number | null;
                      notes?: string | null;
                      sort_order?: number | null;
                    }) => ({
                      item_key: String(r.item_key || ''),
                      label: String(r.label || r.item_key || ''),
                      category: String(r.category || ''),
                      unit: r.unit == null ? null : String(r.unit),
                      cost: r.cost == null ? null : Number(r.cost),
                      notes: r.notes == null ? null : String(r.notes),
                      sort_order:
                        r.sort_order == null ? null : Number(r.sort_order),
                    })
                  )
                : []
            );
            console.log(
              'Loaded',
              Array.isArray(data) ? data.length : 0,
              'mitigation costs from Supabase'
            );
          } catch (e) {
            console.error('mitigation_cost_sheet fetch', e);
            setMitigationCosts([]);
          } finally {
            setMitigationCostsReady(true);
          }
        })();
      } else {
        setPricesReady(true);
        setCostsReady(true);
        setMitigationPricesReady(true);
        setMitigationCostsReady(true);
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

  useEffect(() => {
    if (!sessionReady) return;
    try {
      localStorage.setItem(
        'summitCompanySettings',
        JSON.stringify(companySettings)
      );
    } catch {
      /* ignore */
    }
  }, [sessionReady, companySettings]);

  useEffect(() => {
    if (!sessionReady) return;
    const name = (companySettings.company || '').trim();
    document.title = name || 'Summit';
  }, [sessionReady, companySettings.company]);

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

  // Quiet Google sync: app open / Calendar tab / month change / focus (debounced)
  useEffect(() => {
    if (!sessionReady || !gcalConnected) return;

    const runQuietSync = (opts?: { cursor?: Date }) => {
      void refreshFromGoogle({
        silent: true,
        cursor: opts?.cursor ?? calendarCursor,
      });
    };

    if (activeTab === 'calendar') {
      runQuietSync({ cursor: calendarCursor });
    } else if (activeTab === 'tasks') {
      void syncTasksWithGoogle({ silent: true, pullOnly: true });
    }

    let focusTimer: number | undefined;
    const scheduleFocusSync = () => {
      if (activeTab !== 'calendar') return;
      window.clearTimeout(focusTimer);
      focusTimer = window.setTimeout(() => {
        runQuietSync({ cursor: calendarCursor });
      }, 1200);
    };
    const onFocus = () => scheduleFocusSync();
    const onVis = () => {
      if (document.visibilityState === 'visible') scheduleFocusSync();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- quiet sync on tab/month/connect/focus
  }, [
    sessionReady,
    gcalConnected,
    activeTab,
    calendarCursor.getFullYear(),
    calendarCursor.getMonth(),
  ]);

  // One quiet sync when Google first connects / app hydrates (any tab)
  useEffect(() => {
    if (!sessionReady || !gcalConnected) return;
    void refreshFromGoogle({ silent: true, cursor: calendarCursor });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per connect/hydrate
  }, [sessionReady, gcalConnected]);

  // Remember Month | Week preference
  useEffect(() => {
    if (!sessionReady) return;
    try {
      localStorage.setItem(SUMMIT_CALENDAR_VIEW_KEY, calendarViewMode);
    } catch {
      /* ignore */
    }
  }, [sessionReady, calendarViewMode]);

  // Week view: scroll time grid to morning when opened
  useEffect(() => {
    if (activeTab !== 'calendar' || calendarViewMode !== 'week') return;
    const el = calendarWeekScrollRef.current;
    if (!el) return;
    const id = window.requestAnimationFrame(() => {
      el.scrollTop = WEEK_VIEW_SCROLL_HOUR * WEEK_VIEW_HOUR_PX;
    });
    return () => window.cancelAnimationFrame(id);
  }, [activeTab, calendarViewMode, calendarCursor]);

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

  /** Explicit save for Profile settings (profile + company + appearance). */
  const saveUserSettings = async () => {
    const profile = {
      name: userName,
      title: userTitle,
      company: userCompany,
      phone: userPhone,
      email: userEmail,
    };
    try {
      localStorage.setItem('summitUserProfile', JSON.stringify(profile));
      localStorage.setItem(
        'summitCompanySettings',
        JSON.stringify(companySettings)
      );
      localStorage.setItem('summitThemePref', themePref);
      const mode = resolveThemeMode(themePref);
      setThemeMode(mode);
      applyThemeMode(mode);
    } catch {
      showToast('Could not save settings');
      return;
    }

    if (!supabaseEnabled || !supabase) {
      showToast('Settings saved (this device)');
      return;
    }

    try {
      await saveCloudUserProfile(supabase, profile);
      const cloudCompany = await saveCloudCompanySettings(
        supabase,
        companySettings
      );
      const nextCompany = normalizeCompanySettings(cloudCompany);
      setCompanySettings(nextCompany);
      try {
        localStorage.setItem(
          'summitCompanySettings',
          JSON.stringify(nextCompany)
        );
      } catch {
        /* ignore */
      }
      showToast('Settings saved');
    } catch (err) {
      console.error('Settings cloud save failed:', err);
      showToast(
        'Saved on this device — cloud sync failed (run company_user_settings_sync.sql?)'
      );
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

  const saveCurrentEstimate = async (opts?: {
    /** Also generate/store PDF on the estimate (preview Save) */
    savePdf?: boolean;
  }) => {
    const client = resolveEstimatorClient();
    const linkId = currentLeadId ?? estimatorSourceLeadId ?? client.lead?.id ?? null;
    const leadEstimates =
      linkId != null
        ? leads.find((l) => l.id === linkId)?.estimates || []
        : [];

    const editingExisting =
      editingEstimateId != null &&
      leadEstimates.some((e) => e.id === editingEstimateId);

    const draftFields: Partial<Estimate> = {
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
      total: estimatorTotalPrice,
      negotiatedPrice,
    };

    // New save (not editing a loaded estimate): block exact duplicates
    let targetEst: Estimate | undefined = editingExisting
      ? leadEstimates.find((e) => e.id === editingEstimateId)
      : undefined;
    let isUpdate = editingExisting;
    if (!editingExisting && linkId != null) {
      const dup = findExactDuplicateEstimate(leadEstimates, draftFields);
      if (dup) {
        targetEst = dup.estimate;
        isUpdate = true;
      }
    }

    const estimateId = targetEst?.id ?? editingEstimateId ?? newLeadNumericId();

    const currentEstimate: Estimate = {
      id: estimateId,
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
      supabaseId: targetEst?.supabaseId,
      pdfDocumentId: targetEst?.pdfDocumentId,
      pdfUrl: targetEst?.pdfUrl,
      pdfName: targetEst?.pdfName,
    };

    let updatedLeads = [...leads];
    let savedLeadId = linkId;
    if (linkId != null) {
      updatedLeads = updatedLeads.map((lead) => {
        if (lead.id !== linkId) return lead;
        const prev = lead.estimates || [];
        if (!isUpdate) {
          return { ...lead, estimates: [...prev, currentEstimate] };
        }
        const { estimates, replaced } = replaceOneEstimate(
          prev,
          currentEstimate
        );
        if (replaced) return { ...lead, estimates };
        // Fallback: replace by content fingerprint (never insert a twin)
        const contentKey = estimateContentKey(currentEstimate);
        const dupIdx = prev.findIndex(
          (e) => estimateContentKey(e) === contentKey
        );
        if (dupIdx >= 0) {
          const copy = [...prev];
          copy[dupIdx] = {
            ...currentEstimate,
            id: prev[dupIdx].id,
            supabaseId: prev[dupIdx].supabaseId || currentEstimate.supabaseId,
            pdfDocumentId:
              currentEstimate.pdfDocumentId || prev[dupIdx].pdfDocumentId,
            pdfUrl: currentEstimate.pdfUrl || prev[dupIdx].pdfUrl,
            pdfName: currentEstimate.pdfName || prev[dupIdx].pdfName,
          };
          return { ...lead, estimates: copy };
        }
        return { ...lead, estimates: [...prev, currentEstimate] };
      });
      dirtyEstimateKeysRef.current.add(`${linkId}:${estimateId}`);
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
      savedLeadId = newLead.id;
      dirtyEstimateKeysRef.current.add(`${newLead.id}:${estimateId}`);
      setCurrentLeadId(newLead.id);
      setEstimatorSourceLeadId(newLead.id);
    }
    persistLeads(updatedLeads);
    setEditingEstimateId(estimateId);
    setHasUnsavedChanges(false);

    if (opts?.savePdf && savedLeadId != null) {
      await generatePDF({
        download: false,
        save: true,
        leadId: savedLeadId,
        estimateId,
        leadsSnapshot: updatedLeads,
      });
      return;
    }

    showToast(isUpdate ? 'Estimate updated' : 'Estimate saved');
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
    const capped = Math.min(0.28, Math.max(0, v));
    // Snap to select options
    const opts = [
      0, 0.05, 0.06, 0.07, 0.08, 0.09, 0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16,
      0.18, 0.2, 0.22, 0.25, 0.28,
    ];
    let best = 0.1;
    let bestDist = Infinity;
    for (const o of opts) {
      const d = Math.abs(o - capped);
      if (d < bestDist) {
        bestDist = d;
        best = o;
      }
    }
    return best === 0 ? '' : best.toFixed(2);
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
    // EagleView lengths stay on the measurement for reference — do NOT auto-fill
    // ridgeVentLF / fasciaLF. Partial ridge vent and partial fascia are common;
    // those costs should only appear when the user opts in.
    // ≤3/12 (primary or secondary portion) → double-underlayment awareness
    const primaryRise = Number(String(m.pitch || '').split('/')[0]);
    const secRise = m.secondaryPitch
      ? Number(String(m.secondaryPitch).split('/')[0])
      : NaN;
    const secFrac = Number(m.secondaryFraction) || 0;
    const primaryLow =
      Number.isFinite(primaryRise) && primaryRise > 0 && primaryRise <= 3;
    const secondaryLow =
      Number.isFinite(secRise) && secRise > 0 && secRise <= 3 && secFrac > 0;
    if (primaryLow || secondaryLow) {
      if (!selectedUnderlayment) setSelectedUnderlayment('high-temp');
      if (secondaryLow) {
        setLowSlopeMode((prev) => (prev === 'none' ? 'attached' : prev));
      }
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
    solarAreaOverrideRef.current = null;
    setAutoMeasureHint(null);
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
    initialPoints?: LatLngPoint[];
    pitch?: string;
    pitchAuto?: boolean;
    waste?: number;
    wasteAuto?: boolean;
  }) => {
    const pts = opts?.initialPoints?.filter(
      (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)
    ) || [];
    setTracePoints(pts);
    setSelectedMeasurementId(null);
    setDraftSections([]);
    const pitch = opts?.pitch || '6/12';
    const asFlat = pitch === 'Flat';
    sectionKindRef.current = asFlat ? 'flat' : 'pitched';
    setSectionKind(asFlat ? 'flat' : 'pitched');
    setMeasurePitch(asFlat ? 'Flat' : pitch);
    setMeasurePitchAuto(opts?.pitchAuto ?? !opts?.pitch);
    setMeasureWaste(opts?.waste ?? (asFlat ? 0.05 : 0.1));
    setMeasureWasteAuto(opts?.wasteAuto ?? opts?.waste == null);
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
    setInvoicePickerMode(false);
    if (mode) setEstimatePickerMode(mode);
    setEstimatePickerQuery('');
    setShowEstimatePicker(true);
  };

  const allEstimates = (): Array<{
    lead: Lead;
    estimate: Estimate;
    leadName: string;
    estimateIndex: number;
  }> => {
    const items: Array<{
      lead: Lead;
      estimate: Estimate;
      leadName: string;
      estimateIndex: number;
    }> = [];
    for (const lead of leads) {
      const name =
        [lead.clientFirstName, lead.clientLastName].filter(Boolean).join(' ') ||
        lead.clientAddress ||
        'Unassigned lead';
      (lead.estimates || []).forEach((estimate, estimateIndex) => {
        items.push({ lead, estimate, leadName: name, estimateIndex });
      });
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
   * Auto-measure — accuracy first:
   * 1) Instant Roofer AI (~$1–3, sandbox free credits) when INSTANT_ROOFER_API_KEY is set
   * 2) Else Google Solar squares/pitch only (no fake outline)
   *
   * Free OSM / Solar bounding-box outlines were removed — they looked auto but
   * were not roof-accurate. Trace manually, or add Instant Roofer for AI measure.
   * Ridge/hip/rake stay blank until field entry or Human Certified.
   */
  const runSolarAutoMeasure = async () => {
    if (!currentLeadId) {
      showToast('Open a lead first');
      return;
    }
    const street = clientAddress.trim();
    const city = clientCity.trim();
    const state = clientState.trim();
    const zip = clientZip.trim();
    if (!street && !city && !zip) {
      showToast('Add a property address under Overview first');
      setProfileTab('overview');
      return;
    }

    setSolarMeasuring(true);
    solarAreaOverrideRef.current = null;
    setAutoMeasureHint(null);
    try {
      let center = mapCenter;
      if (!center) {
        center = await geocodeStructuredAddress({
          street: street || city,
          city,
          state,
          zip,
        });
      }
      if (!center) {
        showToast('Could not locate address for auto-measure');
        return;
      }

      const qs = `lat=${encodeURIComponent(String(center.lat))}&lng=${encodeURIComponent(String(center.lng))}`;

      // 1) Instant Roofer AI (accurate) when configured
      const irRes = await fetch(`/api/instant-roofer/measure?${qs}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      const ir = (await irRes.json()) as {
        ok?: boolean;
        error?: string;
        message?: string;
        pitch?: string;
        waste?: number;
        squares?: number;
        footprintSqFt?: number;
        surfaceSqFt?: number;
        perimeterLF?: number;
        confidence?: { score?: number | null; label?: string | null };
        center?: { lat: number; lng: number };
        outlinePoints?: LatLngPoint[];
        outlineImage?: string | null;
      };

      if (irRes.ok && ir.ok && (Number(ir.squares) || 0) > 0) {
        const squares = Number(ir.squares) || 0;
        const pitch = ir.pitch || '6/12';
        const waste = ir.waste ?? 0.1;
        const isFlat = pitch === 'Flat';
        const mapCenterPt = ir.center || center;
        const outlinePoints = Array.isArray(ir.outlinePoints)
          ? ir.outlinePoints.filter(
              (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)
            )
          : [];
        const conf =
          ir.confidence?.label ||
          (ir.confidence?.score != null
            ? `score ${ir.confidence.score}`
            : null);

        // Only seed map when Instant Roofer returns real LiDAR outline points
        if (outlinePoints.length >= 3) {
          solarAreaOverrideRef.current = {
            squares: isFlat ? 0 : squares,
            footprintSqFt: Number(ir.footprintSqFt) || squares * 100,
            surfaceSqFt: Number(ir.surfaceSqFt) || squares * 100,
            pitch,
            waste,
            measureSource: 'instant_roofer',
          };
          setAutoMeasureHint(
            `Instant Roofer · ${squares} sq · ${pitch}${
              conf ? ` · ${conf}` : ''
            } — nudge outline if needed, then Save`
          );
          beginNewMeasurementSession({
            prefillLabel: `${street || 'Roof'} · Instant Roofer`,
            center: mapCenterPt,
            initialPoints: outlinePoints,
            pitch: isFlat ? 'Flat' : pitch,
            pitchAuto: false,
            waste,
            wasteAuto: false,
          });
          showToast(
            `Instant Roofer · ${squares} sq · ${pitch}${
              conf ? ` · ${conf}` : ''
            }`
          );
          return;
        }

        const measurement = normalizeMeasurement({
          id: `ir-${Date.now()}`,
          createdAt: new Date().toLocaleString(),
          label: `${street || 'Roof'} · Instant Roofer`,
          points: [],
          roofType: isFlat ? 'flat-modified-bitumen' : 'pitched-shingles',
          pitch,
          pitchAuto: true,
          waste,
          wasteAuto: false,
          footprintSqFt: Number(ir.footprintSqFt) || squares * 100,
          surfaceSqFt: Number(ir.surfaceSqFt) || squares * 100,
          squares: isFlat ? 0 : squares,
          flatSquares: isFlat ? squares : 0,
          perimeterLF: Number(ir.perimeterLF) || 0,
          edgeLengthsLF: [],
          ridgeLF: 0,
          hipLF: 0,
          eaveLF: 0,
          rakeLF: 0,
          valleyLF: 0,
          center: mapCenterPt,
          measureSource: 'instant_roofer',
          edgesVerified: false,
        });
        if (!measurement) {
          showToast('Could not build measurement from Instant Roofer');
          return;
        }
        const updated = leads.map((lead) =>
          lead.id === currentLeadId
            ? {
                ...lead,
                measurements: [...(lead.measurements || []), measurement],
              }
            : lead
        );
        persistLeads(updated);
        setSelectedMeasurementId(measurement.id);
        setMapCenter(mapCenterPt);
        showToast(
          `Instant Roofer · ${squares} sq · ${pitch}${
            conf ? ` · ${conf}` : ''
          } — Open map to trace outline; ridge/hip blank`
        );
        return;
      }

      // 2) Google Solar — squares/pitch only (no OSM/box outline — those were inaccurate)
      if (ir.error !== 'instant_roofer_not_configured' && !irRes.ok) {
        console.warn('instant-roofer failed, trying Solar', ir.message);
      }

      const solarRes = await fetch(`/api/solar/measure?${qs}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      const solar = (await solarRes.json()) as {
        ok?: boolean;
        error?: string;
        message?: string;
        pitch?: string;
        secondaryPitch?: string | null;
        secondaryFraction?: number | null;
        waste?: number;
        squares?: number;
        footprintSqFt?: number;
        surfaceSqFt?: number;
        center?: { lat: number; lng: number };
      };

      const solarOk =
        solarRes.ok && solar.ok && (Number(solar.squares) || 0) > 0;

      if (!solarOk) {
        if (ir.error === 'instant_roofer_not_configured') {
          showToast(
            'Accurate auto-measure needs Instant Roofer (INSTANT_ROOFER_API_KEY) — or Open map to trace by hand'
          );
        } else if (solar.error === 'solar_not_configured') {
          showToast(
            ir.message ||
              'Auto-measure unavailable — add INSTANT_ROOFER_API_KEY, or Open map to trace'
          );
        } else {
          showToast(
            ir.message ||
              solar.message ||
              'Auto-measure failed — Open map to trace'
          );
        }
        return;
      }

      const squares = Number(solar.squares) || 0;
      const pitch = solar.pitch || '6/12';
      const waste = solar.waste ?? 0.1;
      const isFlat = pitch === 'Flat' || pitch === '1/12' || pitch === '2/12';
      const mapCenterPt = solar.center || center;

      const measurement = normalizeMeasurement({
        id: `solar-${Date.now()}`,
        createdAt: new Date().toLocaleString(),
        label: `${street || 'Roof'} · Solar auto`,
        points: [],
        roofType: isFlat ? 'flat-modified-bitumen' : 'pitched-shingles',
        pitch,
        pitchAuto: true,
        waste,
        wasteAuto: true,
        secondaryPitch: solar.secondaryPitch || undefined,
        secondaryFraction: solar.secondaryFraction ?? undefined,
        footprintSqFt: Number(solar.footprintSqFt) || squares * 100,
        surfaceSqFt: Number(solar.surfaceSqFt) || squares * 100,
        squares: isFlat ? 0 : squares,
        flatSquares: isFlat ? squares : 0,
        perimeterLF: 0,
        edgeLengthsLF: [],
        ridgeLF: 0,
        hipLF: 0,
        eaveLF: 0,
        rakeLF: 0,
        valleyLF: 0,
        center: mapCenterPt,
        measureSource: 'google_solar',
        edgesVerified: false,
      });
      if (!measurement) {
        showToast('Could not build measurement from Solar data');
        return;
      }

      const updated = leads.map((lead) =>
        lead.id === currentLeadId
          ? {
              ...lead,
              measurements: [...(lead.measurements || []), measurement],
            }
          : lead
      );
      persistLeads(updated);
      setSelectedMeasurementId(measurement.id);
      setMapCenter(mapCenterPt);
      showToast(
        `Solar · ${squares} sq · ${pitch} — numbers only; Open map to trace the real outline`
      );
    } catch (err) {
      console.error('auto-measure', err);
      showToast('Auto-measure failed');
    } finally {
      setSolarMeasuring(false);
    }
  };

  const refreshHumanOrders = async (leadId?: number | null) => {
    try {
      const qs =
        leadId != null ? `?leadId=${encodeURIComponent(String(leadId))}` : '';
      const res = await fetch(`/api/instant-roofer/human${qs}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      const data = (await res.json()) as {
        ok?: boolean;
        orders?: Array<{
          id: string;
          leadId: string | null;
          status: string;
          reportUrl: string | null;
          address: string | null;
          createdAt: string;
          failureReason: string | null;
        }>;
      };
      if (res.ok && data.ok && Array.isArray(data.orders)) {
        setHumanOrders(data.orders);
        // Phone-friendly: browser notification when a report completes
        for (const o of data.orders) {
          if (o.status === 'completed' && o.reportUrl && typeof Notification !== 'undefined') {
            if (Notification.permission === 'granted') {
              // Avoid spamming: only if freshly seen via sessionStorage
              const key = `ir-notified-${o.id}`;
              if (!sessionStorage.getItem(key)) {
                sessionStorage.setItem(key, '1');
                new Notification('Human roof report ready', {
                  body: o.address || 'Instant Roofer Human Certified is ready',
                });
              }
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
  };

  /** Instant Roofer Human Certified (~$10, ~1 hr) — edges for materials. */
  const orderHumanCertifiedMeasure = async () => {
    if (!currentLeadId) {
      showToast('Open a lead first');
      return;
    }
    const street = clientAddress.trim();
    const city = clientCity.trim();
    const state = clientState.trim();
    const zip = clientZip.trim();
    if (!street && !city && !zip) {
      showToast('Add a property address under Overview first');
      setProfileTab('overview');
      return;
    }

    setHumanOrdering(true);
    try {
      let center = mapCenter;
      if (!center) {
        center = await geocodeStructuredAddress({
          street: street || city,
          city,
          state,
          zip,
        });
      }
      if (!center) {
        showToast('Could not locate address for human measure');
        return;
      }

      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        void Notification.requestPermission();
      }

      const address = [street, city, state, zip].filter(Boolean).join(', ');
      const customerName = [clientFirstName, clientLastName]
        .filter(Boolean)
        .join(' ')
        .trim();

      const res = await fetch('/api/instant-roofer/human', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lat: center.lat,
          lng: center.lng,
          leadId: currentLeadId,
          address,
          customerName: customerName || undefined,
          contractorName:
            companyBrandName() ||
            userCompany.trim() ||
            userName.trim() ||
            undefined,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        showToast(data.message || 'Could not order Human Certified report');
        return;
      }
      showToast(
        'Human Certified ordered (~1 hr). We’ll flag it here when ready — set Instant Roofer webhook for phone alerts.'
      );
      await refreshHumanOrders(currentLeadId);
    } catch (err) {
      console.error('human order', err);
      showToast('Human Certified order failed');
    } finally {
      setHumanOrdering(false);
    }
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

    const solarOv = solarAreaOverrideRef.current;
    const totalOverrides =
      solarOv && sectionKindRef.current !== 'flat' && (solarOv.squares || 0) > 0
        ? {
            squares: solarOv.squares,
            footprintSqFt: solarOv.footprintSqFt,
            surfaceSqFt: solarOv.surfaceSqFt,
          }
        : solarOv && (solarOv.squares || 0) <= 0 && solarOv.footprintSqFt > 0
          ? {
              flatSquares: Math.round((solarOv.surfaceSqFt / 100) * 10) / 10,
              footprintSqFt: solarOv.footprintSqFt,
              surfaceSqFt: solarOv.surfaceSqFt,
            }
          : undefined;

    const measurement = {
      ...aggregateSectionsToMeasurement(sections, {
        label: measureLabel.trim() || clientAddress || 'Roof',
        center: mapCenter || undefined,
        totalOverrides,
        measureSource: solarOv?.measureSource || 'trace',
        edgesVerified: false,
      }),
      ...(solarOv?.secondaryPitch
        ? {
            secondaryPitch: solarOv.secondaryPitch,
            secondaryFraction: solarOv.secondaryFraction,
          }
        : {}),
    };
    solarAreaOverrideRef.current = null;
    setAutoMeasureHint(null);

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
          : `Saved · ${pitched} pitched squares · enter ridge/hip on estimate after field check`
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

  /**
   * Soft-delete a single estimate → app trash.
   * Prefer index so duplicate Date.now() ids never wipe the whole list.
   */
  const removeLeadEstimate = (estimateId: number, estimateIndex?: number) => {
    if (!currentLeadId) return;
    if (!confirm('Move this estimate to trash?')) return;
    const lead = leads.find((l) => l.id === currentLeadId);
    if (!lead) return;
    const list = lead.estimates || [];
    const idx =
      typeof estimateIndex === 'number' &&
      estimateIndex >= 0 &&
      estimateIndex < list.length &&
      list[estimateIndex]?.id === estimateId
        ? estimateIndex
        : list.findIndex((e) => e.id === estimateId);
    if (idx < 0) return;
    const estimate = list[idx];
    if (!estimate) return;

    const pdfId = estimate.pdfDocumentId;
    const pdfUrl = estimate.pdfUrl;
    dirtyEstimateKeysRef.current.delete(`${currentLeadId}:${estimateId}`);
    const updated = leads.map((l) => {
      if (l.id !== currentLeadId) return l;
      return {
        ...l,
        // Remove exactly one row (by index), never every matching id
        estimates: (l.estimates || []).filter((_, i) => i !== idx),
        documents: (l.documents || []).filter((d) => {
          if (pdfId && d.id === pdfId) return false;
          if (pdfUrl && d.url === pdfUrl) return false;
          return true;
        }),
      };
    });
    persistLeads(updated);

    // Drop the cloud row immediately so bootstrap cannot resurrect it
    if (supabaseEnabled && supabase && estimate.supabaseId) {
      const cloudEstId = estimate.supabaseId;
      void (async () => {
        try {
          const { error } = await supabase
            .from('estimates')
            .delete()
            .eq('id', cloudEstId);
          if (error) console.error('Supabase estimate trash error:', error);
        } catch (err) {
          console.error('Supabase estimate trash error:', err);
        }
      })();
    }

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
    // Remember lead tab to restore on Back (default Estimates)
    if (isEditingLead && profileTab !== 'estimator') {
      setLeadToolReturnTab(profileTab);
    } else {
      setLeadToolReturnTab('estimates');
    }
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
    if (measurements.length > 0 && workspace === 'estimate') {
      const latest = measurements[measurements.length - 1];
      setPendingApplyMeasurement({
        leadId: fromId,
        name,
        workspace,
        measurement: latest,
        resolvedLead,
      });
      return;
    }

    resetEstimatorFields(true);
    fillLeadContact();
    showToast(
      workspace === 'internal'
        ? `Internal for ${name}`
        : `New estimate for ${name}`
    );
    enterLeadEstimator(fromId, workspace);
    setEditingEstimateId(null);
  };

  const finishStartEstimateBlank = () => {
    const pending = pendingApplyMeasurement;
    if (!pending) return;
    const { leadId, name, workspace, resolvedLead } = pending;
    setPendingApplyMeasurement(null);
    resetEstimatorFields(true);
    setClientFirstName(resolvedLead.clientFirstName || '');
    setClientLastName(resolvedLead.clientLastName || '');
    setClientAddress(resolvedLead.clientAddress || '');
    setClientCity(resolvedLead.clientCity || '');
    setClientState(resolvedLead.clientState || '');
    setClientZip(resolvedLead.clientZip || '');
    setClientPhone(displayPhoneUS(resolvedLead.clientPhone || ''));
    setClientEmail(resolvedLead.clientEmail || '');
    setClientJobNumber(resolvedLead.jobNumber || '');
    showToast(
      workspace === 'internal'
        ? `Internal for ${name}`
        : `New estimate for ${name}`
    );
    enterLeadEstimator(leadId, workspace);
    setEditingEstimateId(null);
  };

  const finishStartEstimateWithMeasurement = () => {
    const pending = pendingApplyMeasurement;
    if (!pending) return;
    const { leadId, name, workspace, measurement, resolvedLead } = pending;
    setPendingApplyMeasurement(null);
    resetEstimatorFields(true);
    setClientFirstName(resolvedLead.clientFirstName || '');
    setClientLastName(resolvedLead.clientLastName || '');
    setClientAddress(resolvedLead.clientAddress || '');
    setClientCity(resolvedLead.clientCity || '');
    setClientState(resolvedLead.clientState || '');
    setClientZip(resolvedLead.clientZip || '');
    setClientPhone(displayPhoneUS(resolvedLead.clientPhone || ''));
    setClientEmail(resolvedLead.clientEmail || '');
    setClientJobNumber(resolvedLead.jobNumber || '');
    applyMeasurementToEstimator(measurement, resolvedLead);
    const pitched = Number(measurement.squares) || 0;
    const flat = Number(measurement.flatSquares) || 0;
    showToast(
      flat > 0 && pitched > 0
        ? `Estimate for ${name} · ${pitched} pitched + ${flat} flat sq`
        : flat > 0
          ? `Estimate for ${name} · ${flat} flat squares`
          : `Estimate for ${name} · ${pitched || 0} pitched squares`
    );
    enterLeadEstimator(leadId, workspace);
    setEditingEstimateId(null);
  };

  const handleTabChange = (newTab: AppTab) => {
    // Leaving in-profile estimate with dirty changes
    if (
      hasUnsavedChanges &&
      isEditingLead &&
      profileTab === 'estimator' &&
      !(newTab === 'leads' && isEditingLead)
    ) {
      setPendingLeave({ kind: 'nav', newTab });
      return;
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

  /**
   * Open a lead and load a saved estimate into the lead estimator.
   * Used from Estimates hub / picker so we never land in a dead shell.
   */
  const openLeadEstimate = (
    leadId: number,
    estimate: Estimate,
    leadOverride?: Lead
  ) => {
    const lead = leadOverride ?? leads.find((l) => l.id === leadId);
    if (!lead) {
      showToast('Lead not found');
      return;
    }
    // Clear overlays that can leave a blank / partial state under the lead
    setShowEstimatePicker(false);
    setShowProfessionalEstimate(false);
    setShowMeasureAddressModal(false);
    setHubReport(null);
    setInvoicePickerMode(false);
    if (systemDocWorkspace) {
      setSystemDocWorkspace(null);
      setTakeoffAssignOpen(false);
      setEmergencyDraft(null);
      setEmergencyPreview(false);
      setMitigationDraft(null);
      setMitigationWorkspace('invoice');
      setShowMitigationCostBreakdown(false);
      setShowMitigationInvoice(false);
      setShowMitigationPreview(false);
    }
    applyLeadFields(lead);
    setIsEditingLead(true);
    setActiveTab('leads');
    loadEstimate(estimate, { leadId: lead.id });
  };

  /** Open lead profile on Estimates tab (from Estimates hub “Lead” control). */
  const openLead = (leadId: number, leadOverride?: Lead, tab?: ProfileTab) => {
    const lead = leadOverride ?? leads.find((l) => l.id === leadId);
    if (!lead) {
      showToast('Lead not found');
      return;
    }
    setShowEstimatePicker(false);
    setShowProfessionalEstimate(false);
    setShowMeasureAddressModal(false);
    setHubReport(null);
    applyLeadFields(lead);
    setProfileTab(tab ?? 'overview');
    setIsEditingLead(true);
    setActiveTab('leads');
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
    setEditingEstimateId(estimate.id);
    setHasUnsavedChanges(false);
    setShowEstimatePicker(false);
    setShowProfessionalEstimate(false);
    setHubReport(null);
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
      setActiveTab('leads');
      setEstimateFlow('estimate');
      setProfileTab('estimator');
      setEstimateWorkspace('estimate');
      setEstimatorSourceLeadId(null);
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

  // Restore desktop sidebar collapse preference
  useEffect(() => {
    try {
      if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1') {
        setSidebarCollapsed(true);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const isDocumentWorkspace =
    systemDocWorkspace === 'takeoff' ||
    systemDocWorkspace === 'pricing' ||
    systemDocWorkspace === 'mitigation' ||
    systemDocWorkspace === 'mitigation_personal' ||
    systemDocWorkspace === 'mitigation_company' ||
    systemDocWorkspace === 'emergency';

  // Document workspaces: collapse to icon rail for focus; restore on exit
  useEffect(() => {
    if (isDocumentWorkspace) {
      setSidebarCollapsed((current) => {
        if (sidebarDocPrevCollapsed.current === null) {
          sidebarDocPrevCollapsed.current = current;
        }
        return true;
      });
      return;
    }
    if (sidebarDocPrevCollapsed.current !== null) {
      const restore = sidebarDocPrevCollapsed.current;
      sidebarDocPrevCollapsed.current = null;
      setSidebarCollapsed(restore);
    }
  }, [isDocumentWorkspace]);

  const persistSidebarCollapsed = (next: boolean) => {
    setSidebarCollapsed(next);
    if (sidebarDocPrevCollapsed.current !== null) {
      // While in a document workspace, remember the user's toggle for restore
      sidebarDocPrevCollapsed.current = next;
    }
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const toggleSidebarCollapsed = () => {
    persistSidebarCollapsed(!sidebarCollapsed);
  };

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
    const safe = sanitizeLeads(updated);
    setLeads(safe);
    try {
      localStorage.setItem('summitLeads', JSON.stringify(safe));
    } catch {
      /* ignore quota */
    }

    // Best-effort cloud write: leads (+ new estimates only)
    if (supabaseEnabled && supabase) {
      void (async () => {
        for (const lead of safe) {
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

            for (const est of lead.estimates) {
              const dirtyKey = `${lead.id}:${est.id}`;
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

              // Update existing cloud row when this estimate was explicitly dirtied
              if (est.supabaseId) {
                if (!dirtyEstimateKeysRef.current.has(dirtyKey)) continue;
                const syncKey = `upd:${est.supabaseId}`;
                if (estimateSyncInFlightRef.current.has(syncKey)) continue;
                estimateSyncInFlightRef.current.add(syncKey);
                dirtyEstimateKeysRef.current.delete(dirtyKey);
                try {
                  const { error: estErr } = await supabase
                    .from('estimates')
                    .update(estPayload)
                    .eq('id', est.supabaseId);
                  if (estErr) {
                    console.error('Supabase estimate update error:', estErr);
                    dirtyEstimateKeysRef.current.add(dirtyKey);
                  }
                } catch (e) {
                  console.error('Estimate update sync error:', e);
                  dirtyEstimateKeysRef.current.add(dirtyKey);
                } finally {
                  estimateSyncInFlightRef.current.delete(syncKey);
                }
                continue;
              }

              // Insert estimates that have not been synced yet
              const syncKey = `ins:${cloudLeadId}:${est.id}`;
              if (estimateSyncInFlightRef.current.has(syncKey)) continue;
              estimateSyncInFlightRef.current.add(syncKey);
              dirtyEstimateKeysRef.current.delete(dirtyKey);
              try {
                const { data: estRow, error: estErr } = await supabase
                  .from('estimates')
                  .insert(estPayload)
                  .select('id')
                  .single();
                if (estErr) {
                  console.error('Supabase estimate insert error:', estErr);
                  dirtyEstimateKeysRef.current.add(dirtyKey);
                  continue;
                }
                if (estRow?.id) {
                  const estCloudId = String(estRow.id);
                  setLeads((prev) => {
                    const next = prev.map((l) => {
                      if (l.id !== lead.id) return l;
                      let patched = false;
                      return {
                        ...l,
                        supabaseId: l.supabaseId || cloudLeadId,
                        // Patch exactly one local row (duplicate ids must not share one cloud id)
                        estimates: (l.estimates || []).map((e) => {
                          if (patched || e.supabaseId || e.id !== est.id) {
                            return e;
                          }
                          patched = true;
                          return { ...e, supabaseId: estCloudId };
                        }),
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
                dirtyEstimateKeysRef.current.add(dirtyKey);
              } finally {
                estimateSyncInFlightRef.current.delete(syncKey);
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
        ensureBrowserGcalSession,
        loadGoogleIdentityScript,
        browserSessionHasTasksScope,
        probeGoogleTasksAccess,
      } = await import('@/lib/gcal-browser');
      setGcalConfigured(isBrowserGcalConfigured());
      void loadGoogleIdentityScript().catch(() => undefined);
      let session = readBrowserGcalSession();
      if (!session) {
        // Survives browser restart: silent-refresh expired localStorage token
        session = await ensureBrowserGcalSession();
      }
      if (session) {
        setGcalConnected(true);
        setGcalEmail(session.email ?? null);
        setGcalName(null);
        if (!browserSessionHasTasksScope(session)) {
          setGtasksNeedsReconnect(true);
          setGtasksErrorKind('scope');
          setGtasksLastError(
            'Google Tasks permission missing — tap Reconnect for Tasks and allow Tasks on the consent screen.'
          );
        } else {
          // Scope claims Tasks — verify live (catches API-disabled / stale scope)
          const probe = await probeGoogleTasksAccess(session.accessToken);
          setGtasksNeedsReconnect(!probe.ok);
          if (probe.ok) {
            setGtasksLastError(null);
            setGtasksErrorKind(null);
          } else {
            setGtasksLastError(probe.error);
            setGtasksErrorKind(probe.kind);
          }
        }
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
      // Server cookie path has Tasks scope in consent URL; browser GIS is primary
      if (data.connected) setGtasksNeedsReconnect(false);
    } catch {
      /* offline / unconfigured */
    }
  };

  const calendarColorFor = (
    calendarId?: string | null,
    stored?: { bg?: string; fg?: string } | null
  ): CalendarListColor | undefined => {
    if (stored?.bg) {
      return { bg: stored.bg, text: stored.fg };
    }
    const id = (calendarId || 'primary').trim();
    const fromMap = googleCalendarColorMap[id];
    if (fromMap?.bg) return { bg: fromMap.bg, text: fromMap.fg };
    if (id !== 'primary' && googleCalendarColorMap.primary?.bg) {
      return {
        bg: googleCalendarColorMap.primary.bg,
        text: googleCalendarColorMap.primary.fg,
      };
    }
    return undefined;
  };

  const loadGoogleEvents = async (opts?: {
    silent?: boolean;
    /** Inclusive month cursor — loads that month’s grid window */
    cursor?: Date;
  }) => {
    try {
      const { ensureBrowserGcalSession, listUpcomingGoogleEvents } =
        await import('@/lib/gcal-browser');
      const session = await ensureBrowserGcalSession();
      if (!session?.accessToken) {
        if (!opts?.silent) {
          showToast('Connect Google Calendar first');
        }
        setGcalConnected(false);
        return;
      }
      setGcalConnected(true);
      setGoogleEventsLoading(true);
      const cursor = opts?.cursor || calendarCursor;
      const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
      monthStart.setHours(0, 0, 0, 0);
      const gridStart = startOfWeekSunday(monthStart);
      const gridEnd = addDays(gridStart, 42);
      const pulled = await listUpcomingGoogleEvents(session.accessToken, {
        maxResults: 120,
        timeMin: gridStart.toISOString(),
        timeMax: gridEnd.toISOString(),
      });
      // Always store an array — never set a bare object / undefined (crashes render)
      const items = Array.isArray(pulled?.events)
        ? pulled.events
        : Array.isArray(pulled)
          ? pulled
          : [];
      const colorMap =
        pulled &&
        typeof pulled === 'object' &&
        !Array.isArray(pulled) &&
        pulled.colorMap &&
        typeof pulled.colorMap === 'object'
          ? pulled.colorMap
          : {};
      setGoogleCalendarEvents(items);
      if (Object.keys(colorMap).length) {
        setGoogleCalendarColorMap(colorMap);
      }
      // Refresh writable calendar list for create picker + color accuracy
      try {
        const {
          listGoogleCalendarList,
          browserSessionHasCalendarListScope,
        } = await import('@/lib/gcal-browser');
        setGcalCalendarListNeedsReconnect(
          !browserSessionHasCalendarListScope(session)
        );
        try {
          const list = await listGoogleCalendarList(session.accessToken);
          const writable = (Array.isArray(list) ? list : [])
            .filter(
              (c) =>
                c?.id &&
                (!c.accessRole ||
                  c.accessRole === 'owner' ||
                  c.accessRole === 'writer')
            )
            .map((c) => ({
              id: c.id,
              summary: c.summary || c.id,
              primary: c.primary,
              backgroundColor: c.backgroundColor,
              foregroundColor: c.foregroundColor,
            }));
          setGoogleCalendarList(writable);
          setGcalCalendarListNeedsReconnect(false);
        } catch (listErr) {
          const msg =
            listErr instanceof Error ? listErr.message : String(listErr);
          if (/calendarList_forbidden|403/i.test(msg)) {
            setGcalCalendarListNeedsReconnect(true);
          }
        }
      } catch {
        /* ignore list helpers */
      }

      // Merge Google → Summit event store (skip adjustment-synced events)
      const adjIds = new Set(
        leads
          .map((l) => l.calendarEventId)
          .filter((id): id is string => Boolean(id))
      );
      const localRaw = (() => {
        try {
          const raw = localStorage.getItem(SUMMIT_CALENDAR_EVENTS_KEY);
          return normalizeStoredCalendarEvents(raw ? JSON.parse(raw) : []);
        } catch {
          return calendarEvents;
        }
      })();
      const merged = mergeGoogleCalendarEventsIntoLocal(localRaw, items, {
        knownAdjustmentGoogleIds: adjIds,
      });
      // Re-resolve calendar colors from fresh calendarList map
      const recolored = merged.events.map((ev) => {
        const calId = ev.calendarId || 'primary';
        const colors = colorMap[calId] || colorMap.primary;
        if (!colors?.bg) return ev;
        return {
          ...ev,
          calendarColorBg: colors.bg,
          calendarColorFg: colors.fg,
        };
      });
      persistCalendarEvents(recolored);

      if (!opts?.silent) {
        const parts = [
          items.length
            ? `${items.length} Google event${items.length === 1 ? '' : 's'}`
            : '',
          merged.imported
            ? `${merged.imported} imported`
            : '',
          merged.updated ? `${merged.updated} updated` : '',
        ].filter(Boolean);
        showToast(
          parts.length ? `Calendar · ${parts.join(' · ')}` : 'No events this month'
        );
      }
    } catch (e) {
      const { formatGoogleConnectError } = await import('@/lib/gcal-browser');
      if (!opts?.silent) {
        showToast(formatGoogleConnectError(e));
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

  /** Push Summit-only (unsynced) manual events to Google. */
  const pushUnsyncedCalendarEvents = async (opts?: {
    silent?: boolean;
    eventsOverride?: SummitCalendarEvent[];
  }) => {
    const {
      ensureBrowserGcalSession,
      syncManualEventWithBrowserToken,
    } = await import('@/lib/gcal-browser');
    const session = await ensureBrowserGcalSession();
    if (!session?.accessToken) return;
    const source =
      opts?.eventsOverride ||
      (() => {
        try {
          const raw = localStorage.getItem(SUMMIT_CALENDAR_EVENTS_KEY);
          return normalizeStoredCalendarEvents(raw ? JSON.parse(raw) : []);
        } catch {
          return calendarEvents;
        }
      })();
    const unsynced = source.filter((e) => !e.googleEventId);
    if (unsynced.length === 0) return;
    let next = [...source];
    let pushed = 0;
    for (const ev of unsynced) {
      try {
        const out = await syncManualEventWithBrowserToken(session.accessToken, {
          id: ev.id,
          title: ev.title,
          notes: ev.notes,
          startDate: ev.startDate,
          endDate: ev.endDate,
          startTime: ev.startTime,
          endTime: ev.endTime,
          allDay: ev.allDay,
          leadId: ev.leadId,
          leadName: ev.leadName,
          googleEventId: ev.googleEventId,
          calendarId: ev.calendarId || 'primary',
          colorId: ev.colorId ?? null,
        });
        next = next.map((x) =>
          x.id === ev.id
            ? {
                ...x,
                googleEventId: out.eventId,
                googleHtmlLink: out.htmlLink || x.googleHtmlLink,
                calendarId: out.calendarId || x.calendarId || 'primary',
                updatedAt: new Date().toISOString(),
              }
            : x
        );
        pushed += 1;
      } catch {
        /* keep local */
      }
    }
    if (pushed > 0) {
      persistCalendarEvents(next);
      if (!opts?.silent) {
        showToast(
          `Pushed ${pushed} event${pushed === 1 ? '' : 's'} to Google`
        );
      }
    }
  };

  /** Pull Calendar + Tasks from Google and push unsynced Summit events. */
  const refreshFromGoogle = async (opts?: { silent?: boolean; cursor?: Date }) => {
    await loadGoogleEvents({ silent: opts?.silent, cursor: opts?.cursor });
    // Push Summit-only events after pull so bi-directional stays accurate
    await pushUnsyncedCalendarEvents({ silent: true });
    // Don't gate on React state — loadGoogleEvents may have just refreshed the token
    await syncTasksWithGoogle({
      silent: true,
      pullOnly: true,
      assumeConnected: true,
    });
    const syncedAt = new Date().toISOString();
    setGcalLastSync(syncedAt);
    try {
      localStorage.setItem('summitGcalLastSync', syncedAt);
    } catch {
      /* ignore */
    }
  };

  const openCreateCalendarEvent = (
    isoDate: string,
    opts?: { startTime?: string; endTime?: string; allDay?: boolean }
  ) => {
    const startTime = opts?.startTime || '09:00';
    const endTime = opts?.endTime || defaultEndTime(startTime);
    const allDay = Boolean(opts?.allDay);
    const primaryCal =
      googleCalendarList.find((c) => c.primary) || googleCalendarList[0];
    setCalEventDraft({
      title: '',
      notes: '',
      startDate: isoDate,
      endDate: isoDate,
      startTime,
      endTime,
      allDay,
      leadId: null,
      leadSearch: '',
      calendarId: primaryCal?.id || 'primary',
      colorId: undefined,
    });
    setCalEventModal({ mode: 'create' });
  };

  const openEditCalendarEvent = (event: SummitCalendarEvent) => {
    setCalEventDraft({
      title: event.title,
      notes: event.notes || '',
      startDate: event.startDate,
      endDate: event.endDate || event.startDate,
      startTime: event.startTime || '09:00',
      endTime: event.endTime || defaultEndTime(event.startTime || '09:00'),
      allDay: event.allDay,
      leadId: event.leadId ?? null,
      leadSearch: '',
      calendarId: event.calendarId || 'primary',
      colorId: normalizeGoogleEventColorId(event.colorId),
    });
    setCalEventModal({ mode: 'edit', eventId: event.id });
  };

  const saveCalendarEventDraft = async () => {
    const title = calEventDraft.title.trim();
    if (!title) {
      showToast('Add a title');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(calEventDraft.startDate)) {
      showToast('Pick a date');
      return;
    }
    const endDate =
      /^\d{4}-\d{2}-\d{2}$/.test(calEventDraft.endDate)
        ? calEventDraft.endDate
        : calEventDraft.startDate;
    const linked =
      calEventDraft.leadId != null
        ? leads.find((l) => l.id === calEventDraft.leadId)
        : undefined;
    const leadName = linked
      ? leadDisplayFromParts(linked.clientFirstName, linked.clientLastName) ||
        undefined
      : undefined;
    const now = new Date().toISOString();
    const allDay = calEventDraft.allDay;
    const colorId = normalizeGoogleEventColorId(calEventDraft.colorId);
    const calendarId =
      (calEventDraft.calendarId || '').trim() || 'primary';
    const mapColors =
      googleCalendarColorMap[calendarId] || googleCalendarColorMap.primary;
    const listColors = googleCalendarList.find((c) => c.id === calendarId);
    const calendarColorBg =
      mapColors?.bg || listColors?.backgroundColor || undefined;
    const calendarColorFg =
      mapColors?.fg || listColors?.foregroundColor || undefined;
    const base: SummitCalendarEvent = {
      id:
        calEventModal?.mode === 'edit' && calEventModal.eventId
          ? calEventModal.eventId
          : newSummitCalendarEventId(),
      title,
      notes: calEventDraft.notes.trim() || undefined,
      startDate: calEventDraft.startDate,
      endDate: endDate < calEventDraft.startDate ? calEventDraft.startDate : endDate,
      startTime: allDay ? undefined : calEventDraft.startTime || '09:00',
      endTime: allDay
        ? undefined
        : calEventDraft.endTime ||
          defaultEndTime(calEventDraft.startTime || '09:00'),
      allDay,
      leadId: calEventDraft.leadId ?? undefined,
      leadName,
      calendarId,
      colorId,
      calendarColorBg,
      calendarColorFg,
      updatedAt: now,
      createdAt: now,
      source: 'summit',
    };

    let existing: SummitCalendarEvent | undefined;
    if (calEventModal?.mode === 'edit' && calEventModal.eventId) {
      existing = calendarEvents.find((e) => e.id === calEventModal.eventId);
    }
    const event: SummitCalendarEvent = existing
      ? {
          ...existing,
          ...base,
          id: existing.id,
          createdAt: existing.createdAt,
          googleEventId: existing.googleEventId,
          googleHtmlLink: existing.googleHtmlLink,
          calendarId,
          colorId,
          calendarColorBg: calendarColorBg || existing.calendarColorBg,
          calendarColorFg: calendarColorFg || existing.calendarColorFg,
          source: existing.source || 'summit',
        }
      : base;

    const next =
      existing != null
        ? calendarEvents.map((e) => (e.id === event.id ? event : e))
        : [event, ...calendarEvents];
    persistCalendarEvents(next);
    setCalendarSelectedDay(event.startDate);
    setCalEventModal(null);

    if (gcalConnected) {
      setCalEventBusy(true);
      try {
        const {
          ensureBrowserGcalSession,
          syncManualEventWithBrowserToken,
        } = await import('@/lib/gcal-browser');
        const session = await ensureBrowserGcalSession();
        if (session?.accessToken) {
          const out = await syncManualEventWithBrowserToken(
            session.accessToken,
            {
              id: event.id,
              title: event.title,
              notes: event.notes,
              startDate: event.startDate,
              endDate: event.endDate,
              startTime: event.startTime,
              endTime: event.endTime,
              allDay: event.allDay,
              leadId: event.leadId,
              leadName: event.leadName,
              googleEventId: event.googleEventId,
              calendarId: event.calendarId || 'primary',
              colorId: event.colorId ?? null,
            }
          );
          const synced = next.map((e) =>
            e.id === event.id
              ? {
                  ...e,
                  googleEventId: out.eventId,
                  googleHtmlLink: out.htmlLink || e.googleHtmlLink,
                  calendarId: out.calendarId || e.calendarId || 'primary',
                  updatedAt: new Date().toISOString(),
                }
              : e
          );
          persistCalendarEvents(synced);
          void loadGoogleEvents({ silent: true });
          showToast(
            event.leadId
              ? 'Event saved · linked lead · synced to Google'
              : 'Event saved · synced to Google'
          );
          return;
        }
      } catch (e) {
        const { formatGoogleConnectError } = await import('@/lib/gcal-browser');
        showToast(
          `Saved locally — Google sync failed: ${formatGoogleConnectError(e)}`
        );
        return;
      } finally {
        setCalEventBusy(false);
      }
    }
    showToast(event.leadId ? 'Event saved · lead linked' : 'Event saved');
  };

  const deleteCalendarEvent = async (eventId: string) => {
    const target = calendarEvents.find((e) => e.id === eventId);
    if (!target) return;
    const next = calendarEvents.filter((e) => e.id !== eventId);
    persistCalendarEvents(next);
    setCalEventModal(null);
    if (target.googleEventId && gcalConnected) {
      try {
        const {
          ensureBrowserGcalSession,
          deleteGoogleEventWithBrowserToken,
        } = await import('@/lib/gcal-browser');
        const session = await ensureBrowserGcalSession();
        if (session?.accessToken) {
          await deleteGoogleEventWithBrowserToken(
            session.accessToken,
            target.googleEventId,
            target.calendarId
          );
          void loadGoogleEvents({ silent: true });
        }
      } catch {
        showToast('Removed locally — could not delete on Google');
        return;
      }
    }
    showToast('Event deleted');
  };

  const connectGoogleCalendar = async (opts?: { forceConsent?: boolean }) => {
    setGcalBusy(true);
    try {
      const {
        connectGoogleCalendarBrowser,
        browserSessionHasTasksScope,
        probeGoogleTasksAccess,
      } = await import('@/lib/gcal-browser');
      // Always force consent when adding Tasks (or first connect) so Google
      // cannot silently reuse a Calendar-only grant. Calendar stays usable if
      // the popup is cancelled (prior session is restored in gcal-browser).
      const session = await connectGoogleCalendarBrowser({
        forceConsent: opts?.forceConsent ?? true,
      });
      setGcalConfigured(true);
      setGcalConnected(true);
      setGcalEmail(session.email ?? null);
      setGcalName(null);

      const scopeOk = browserSessionHasTasksScope(session);
      let tasksOk = scopeOk;
      let tasksError: string | null = null;
      let tasksKind: 'scope' | 'api' | 'auth' | 'other' | null = scopeOk
        ? null
        : 'scope';
      if (session.accessToken) {
        const probe = await probeGoogleTasksAccess(session.accessToken);
        if (probe.ok) {
          tasksOk = true;
          tasksError = null;
          tasksKind = null;
        } else {
          tasksOk = false;
          tasksError = probe.error;
          tasksKind = probe.kind;
        }
      }
      setGtasksNeedsReconnect(!tasksOk);
      setGtasksLastError(tasksError);
      setGtasksErrorKind(tasksKind);

      if (tasksOk) {
        showToast('Google connected (Calendar + Tasks)');
        void loadGoogleEvents({ silent: true }).then(() =>
          pushUnsyncedCalendarEvents({ silent: true })
        );
        void syncTasksWithGoogle({
          silent: false,
          pullOnly: false,
          assumeConnected: true,
        });
      } else {
        const { GOOGLE_TASKS_API_CONSOLE_STEPS } = await import(
          '@/lib/gcal-browser'
        );
        if (tasksKind === 'api') {
          console.warn(
            '[Summit] Google Tasks API blocked — Cloud Console steps:\n' +
              GOOGLE_TASKS_API_CONSOLE_STEPS
          );
        } else if (!scopeOk) {
          console.warn(
            '[Summit] Tasks scope missing from token. Granted scopes:',
            session.scopes || '(none stored)'
          );
        }
        showToast(
          tasksError ||
            (tasksKind === 'api'
              ? 'Calendar works — enable Google Tasks API in Cloud Console (see banner), then Reconnect for Tasks'
              : 'Calendar connected — tap Reconnect for Tasks and allow Tasks on the Google consent screen')
        );
        void loadGoogleEvents({ silent: true }).then(() =>
          pushUnsyncedCalendarEvents({ silent: true })
        );
      }
    } catch (e) {
      const { formatGoogleConnectError, readBrowserGcalSession } = await import(
        '@/lib/gcal-browser'
      );
      const msg = formatGoogleConnectError(e);
      // If reconnect was cancelled, prior Calendar session may have been restored
      const restored = readBrowserGcalSession();
      if (restored?.accessToken) {
        setGcalConnected(true);
        setGcalEmail(restored.email ?? null);
        showToast(msg);
        return;
      }
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
      setGoogleCalendarColorMap({});
      setGtasksNeedsReconnect(false);
      setGtasksLastError(null);
      setGtasksErrorKind(null);
      showToast('Google Calendar disconnected');
    } catch {
      showToast('Could not disconnect');
    } finally {
      setGcalBusy(false);
    }
  };

  const pushTaskToGoogle = async (
    task: SummitTask,
    listsOverride?: SummitTaskList[]
  ): Promise<SummitTask> => {
    const {
      ensureBrowserGcalSession,
      browserSessionHasTasksScope,
    } = await import('@/lib/gcal-browser');
    const {
      createGoogleTask,
      updateGoogleTask,
    } = await import('@/lib/google-tasks');
    const session = await ensureBrowserGcalSession();
    if (!session?.accessToken) return task;
    if (!browserSessionHasTasksScope(session)) {
      setGtasksNeedsReconnect(true);
      return task;
    }
    const lists = listsOverride || taskLists;
    const list =
      lists.find((l) => l.id === task.listId) ||
      lists.find((l) => l.id === activeTaskListId) ||
      lists[0];
    const googleListId = googleListIdFor(list);
    if (!googleListId) {
      // Local-only list — keep on device until list is linked
      return task;
    }
    try {
      if (task.googleTaskId) {
        const gt = await updateGoogleTask(
          session.accessToken,
          task.googleTaskId,
          task,
          googleListId
        );
        setGtasksNeedsReconnect(false);
        return {
          ...task,
          googleTaskId: gt.id,
          updatedAt: gt.updated || task.updatedAt,
        };
      }
      const gt = await createGoogleTask(
        session.accessToken,
        task,
        googleListId
      );
      setGtasksNeedsReconnect(false);
      return {
        ...task,
        googleTaskId: gt.id,
        updatedAt: gt.updated || task.updatedAt,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (/Tasks permission|reconnect/i.test(msg)) {
        setGtasksNeedsReconnect(true);
      }
      throw e;
    }
  };

  const syncTasksWithGoogle = async (opts?: {
    silent?: boolean;
    /** Only pull from Google (no create/update of Summit-only tasks). */
    pullOnly?: boolean;
    /** Skip gcalConnected React state (e.g. right after token refresh). */
    assumeConnected?: boolean;
  }) => {
    if (!opts?.assumeConnected && !gcalConnected) {
      if (!opts?.silent) showToast('Connect Google first');
      return;
    }
    setTasksBusy(true);
    try {
      const {
        ensureBrowserGcalSession,
        browserSessionHasTasksScope,
      } = await import('@/lib/gcal-browser');
      const {
        listGoogleTasks,
        listGoogleTaskLists,
        mergeGoogleTasksIntoLocal,
        mergeGoogleListsIntoLocal,
      } = await import('@/lib/google-tasks');
      const session = await ensureBrowserGcalSession();
      if (!session?.accessToken) {
        setGcalConnected(false);
        if (!opts?.silent) showToast('Connect Google first');
        return;
      }
      if (!browserSessionHasTasksScope(session)) {
        setGtasksNeedsReconnect(true);
        setGtasksErrorKind('scope');
        setGtasksLastError(
          'Token missing Tasks scope — Reconnect for Tasks and allow Tasks on consent.'
        );
        if (!opts?.silent) {
          showToast('Reconnect Google to enable Tasks sync');
        }
        return;
      }

      const remoteLists = await listGoogleTaskLists(session.accessToken);
      setGtasksNeedsReconnect(false);
      setGtasksLastError(null);
      setGtasksErrorKind(null);
      const listsMerged = mergeGoogleListsIntoLocal(taskLists, remoteLists);
      let nextLists = listsMerged.lists;
      persistTaskLists(nextLists);
      if (!nextLists.some((l) => l.id === activeTaskListId)) {
        persistActiveTaskListId(nextLists[0]?.id || DEFAULT_TASK_LIST_ID);
      }

      let nextTasks = tasks;
      let imported = 0;
      let updated = 0;
      for (const list of nextLists) {
        const gListId = googleListIdFor(list);
        if (!gListId) continue;
        try {
          const remote = await listGoogleTasks(session.accessToken, {
            showCompleted: true,
            listId: gListId,
          });
          const merged = mergeGoogleTasksIntoLocal(
            nextTasks,
            remote,
            list.id
          );
          nextTasks = merged.tasks;
          imported += merged.imported;
          updated += merged.updated;
        } catch {
          /* skip one list; continue others */
        }
      }

      if (!opts?.pullOnly) {
        const unsynced = nextTasks.filter((t) => !t.googleTaskId);
        for (const t of unsynced) {
          try {
            const pushed = await pushTaskToGoogle(t, nextLists);
            nextTasks = nextTasks.map((x) => (x.id === t.id ? pushed : x));
          } catch {
            /* keep local; toast below if needed */
          }
        }
      }

      persistTasks(nextTasks);
      if (!opts?.silent) {
        const parts = [
          listsMerged.imported
            ? `${listsMerged.imported} list${listsMerged.imported === 1 ? '' : 's'} imported`
            : '',
          imported ? `${imported} tasks imported` : '',
          updated ? `${updated} updated` : '',
          !opts?.pullOnly
            ? `${nextTasks.filter((t) => t.googleTaskId).length} linked`
            : '',
        ].filter(Boolean);
        showToast(
          parts.length
            ? `Tasks synced · ${parts.join(' · ')}`
            : 'Tasks up to date'
        );
      }
    } catch (e) {
      const { formatGoogleConnectError, probeGoogleTasksAccess } = await import(
        '@/lib/gcal-browser'
      );
      const msg = formatGoogleConnectError(e);
      if (/Tasks permission|reconnect|Tasks API|403/i.test(msg)) {
        setGtasksNeedsReconnect(true);
        setGtasksLastError(msg);
        const lower = msg.toLowerCase();
        setGtasksErrorKind(
          lower.includes('tasks api') || lower.includes('enable google tasks')
            ? 'api'
            : lower.includes('permission') || lower.includes('scope')
              ? 'scope'
              : 'other'
        );
        // Refine kind with a live probe when we still have a token
        try {
          const { ensureBrowserGcalSession } = await import('@/lib/gcal-browser');
          const s = await ensureBrowserGcalSession();
          if (s?.accessToken) {
            const probe = await probeGoogleTasksAccess(s.accessToken);
            if (!probe.ok) {
              setGtasksLastError(probe.error);
              setGtasksErrorKind(probe.kind);
            }
          }
        } catch {
          /* keep msg above */
        }
      }
      if (/expired|401/i.test(msg)) {
        setGcalConnected(false);
      }
      if (!opts?.silent) showToast(msg);
    } finally {
      setTasksBusy(false);
    }
  };

  const createTaskList = async () => {
    const title = taskListDraftTitle.trim();
    if (!title) {
      showToast('Enter a list name');
      return;
    }
    const now = new Date().toISOString();
    let list: SummitTaskList = {
      id: newSummitTaskListId(),
      title,
      createdAt: now,
      updatedAt: now,
    };
    if (gcalConnected && !gtasksNeedsReconnect) {
      try {
        const { ensureBrowserGcalSession, browserSessionHasTasksScope } =
          await import('@/lib/gcal-browser');
        const { createGoogleTaskList } = await import('@/lib/google-tasks');
        const session = await ensureBrowserGcalSession();
        if (session?.accessToken && browserSessionHasTasksScope(session)) {
          const gl = await createGoogleTaskList(session.accessToken, title);
          list = {
            ...list,
            googleListId: gl.id,
            updatedAt: gl.updated || now,
          };
        }
      } catch (e) {
        showToast(
          e instanceof Error
            ? e.message
            : 'List saved locally — Google sync failed'
        );
      }
    }
    persistTaskLists([...taskLists, list]);
    persistActiveTaskListId(list.id);
    setTaskListDraftTitle('');
    showToast(
      list.googleListId ? 'List created · synced' : 'List created'
    );
  };

  const renameTaskList = async (listId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) {
      showToast('Enter a list name');
      return;
    }
    const target = taskLists.find((l) => l.id === listId);
    if (!target) return;
    let next: SummitTaskList = {
      ...target,
      title: trimmed,
      updatedAt: new Date().toISOString(),
    };
    if (
      target.googleListId &&
      gcalConnected &&
      !gtasksNeedsReconnect
    ) {
      try {
        const { ensureBrowserGcalSession, browserSessionHasTasksScope } =
          await import('@/lib/gcal-browser');
        const { renameGoogleTaskList } = await import('@/lib/google-tasks');
        const session = await ensureBrowserGcalSession();
        if (session?.accessToken && browserSessionHasTasksScope(session)) {
          const gl = await renameGoogleTaskList(
            session.accessToken,
            target.googleListId,
            trimmed
          );
          next = {
            ...next,
            title: (gl.title || trimmed).trim(),
            updatedAt: gl.updated || next.updatedAt,
          };
        }
      } catch (e) {
        showToast(
          e instanceof Error
            ? e.message
            : 'Renamed locally — Google sync failed'
        );
      }
    }
    persistTaskLists(taskLists.map((l) => (l.id === listId ? next : l)));
    setRenamingTaskListId(null);
    setRenameTaskListTitle('');
    showToast('List renamed');
  };

  const addTask = async () => {
    const title = newTaskTitle.trim();
    if (!title) {
      showToast('Enter a task title');
      return;
    }
    const listId = activeTaskList?.id || DEFAULT_TASK_LIST_ID;
    const now = new Date().toISOString();
    const due =
      newTaskDue && /^\d{4}-\d{2}-\d{2}$/.test(newTaskDue)
        ? newTaskDue
        : undefined;
    let task: SummitTask = {
      id: newSummitTaskId(),
      title,
      notes: newTaskNotes.trim() || undefined,
      dueDate: due,
      completed: false,
      listId,
      createdAt: now,
      updatedAt: now,
    };
    if (gcalConnected && !gtasksNeedsReconnect) {
      try {
        task = await pushTaskToGoogle(task);
      } catch (e) {
        showToast(
          e instanceof Error
            ? e.message
            : 'Saved locally — Google sync failed'
        );
      }
    }
    persistTasks([task, ...tasks]);
    setNewTaskTitle('');
    setNewTaskDue('');
    setNewTaskNotes('');
    showToast(task.googleTaskId ? 'Task added · synced' : 'Task added');
  };

  const updateTaskLocal = async (
    taskId: string,
    patch: Partial<Pick<SummitTask, 'title' | 'notes' | 'dueDate' | 'completed'>>,
    opts?: { syncGoogle?: boolean }
  ) => {
    const now = new Date().toISOString();
    const syncGoogle = opts?.syncGoogle !== false;
    let next = tasks.map((t) => {
      if (t.id !== taskId) return t;
      const completed =
        patch.completed !== undefined ? patch.completed : t.completed;
      return {
        ...t,
        ...patch,
        completed,
        completedAt: completed
          ? t.completedAt || now
          : undefined,
        updatedAt: now,
      };
    });
    const updated = next.find((t) => t.id === taskId);
    if (
      syncGoogle &&
      updated &&
      gcalConnected &&
      !gtasksNeedsReconnect
    ) {
      try {
        const pushed = await pushTaskToGoogle(updated);
        next = next.map((t) => (t.id === taskId ? pushed : t));
      } catch {
        /* local save still applies */
      }
    }
    persistTasks(next);
  };

  const flushTaskToGoogle = async (taskId: string) => {
    if (!gcalConnected || gtasksNeedsReconnect) return;
    let current: SummitTask | undefined;
    try {
      const raw = localStorage.getItem(SUMMIT_TASKS_KEY);
      current = normalizeStoredTasks(raw ? JSON.parse(raw) : []).find(
        (t) => t.id === taskId
      );
    } catch {
      current = tasks.find((t) => t.id === taskId);
    }
    if (!current) return;
    try {
      const pushed = await pushTaskToGoogle(current);
      const raw = localStorage.getItem(SUMMIT_TASKS_KEY);
      const list = normalizeStoredTasks(raw ? JSON.parse(raw) : tasks);
      persistTasks(list.map((t) => (t.id === taskId ? pushed : t)));
    } catch {
      /* local already saved */
    }
  };

  const deleteTask = async (taskId: string) => {
    const target = tasks.find((t) => t.id === taskId);
    if (!target) return;
    if (target.googleTaskId && gcalConnected && !gtasksNeedsReconnect) {
      try {
        const { ensureBrowserGcalSession } = await import('@/lib/gcal-browser');
        const { deleteGoogleTask } = await import('@/lib/google-tasks');
        const session = await ensureBrowserGcalSession();
        const list = taskLists.find((l) => l.id === target.listId);
        const gListId = googleListIdFor(list);
        if (session?.accessToken && gListId) {
          await deleteGoogleTask(
            session.accessToken,
            target.googleTaskId,
            gListId
          );
        }
      } catch {
        /* still remove locally */
      }
    }
    persistTasks(tasks.filter((t) => t.id !== taskId));
    showToast('Task deleted');
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
    setAdjustmentDate(lead.adjustmentDate || '');
    setAdjustmentTime(lead.adjustmentTime || '');
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
    setEditingEstimateId(null);
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
            // Soft-delete in cloud (matches Trash UI). Estimates stay linked.
            const { error } = await supabase
              .from('leads')
              .update({ deleted_at: new Date().toISOString() })
              .eq('id', cloudId);
            if (error) console.error('Supabase soft-delete error:', error);
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
      const cloudId = item.lead.supabaseId?.trim();
      // Keep the same cloud id — restore clears deleted_at (no duplicate insert)
      const restored: Lead = {
        ...item.lead,
        estimates: item.lead.estimates || [],
      };
      const newLeads = sanitizeLeads([...leads, restored]);
      persistTrash(newTrash);
      setLeads(newLeads);
      try {
        localStorage.setItem('summitLeads', JSON.stringify(newLeads));
      } catch {
        /* ignore */
      }

      if (supabaseEnabled && supabase && cloudId) {
        void (async () => {
          try {
            const { error } = await supabase
              .from('leads')
              .update({ deleted_at: null })
              .eq('id', cloudId);
            if (error) {
              console.error('Supabase restore error:', error);
              showToast('Restored locally — cloud restore failed (check SQL)');
              return;
            }
          } catch (err) {
            console.error('Supabase restore error:', err);
          }
        })();
      } else if (supabaseEnabled && supabase && !cloudId) {
        // Never synced before trash — insert as new cloud lead
        void (async () => {
          try {
            const payload = mapAppLeadToDb(restored);
            const { data, error } = await supabase
              .from('leads')
              .insert(payload)
              .select('id')
              .single();
            if (error) {
              console.error('Supabase restore insert error:', error);
              return;
            }
            if (!data?.id) return;
            const newCloudId = String(data.id);
            setLeads((prev) => {
              const next = prev.map((l) =>
                l.id === leadId ? { ...l, supabaseId: newCloudId } : l
              );
              try {
                localStorage.setItem('summitLeads', JSON.stringify(next));
              } catch {
                /* ignore */
              }
              return next;
            });
          } catch (err) {
            console.error('Supabase restore insert error:', err);
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
      // Cloud row was removed on trash — clear supabaseId so persist re-inserts once
      const restoredEst: Estimate = {
        ...item.estimate,
        supabaseId: undefined,
      };
      nextLead = {
        ...lead,
        estimates: [...(lead.estimates || []), restoredEst],
      };
      dirtyEstimateKeysRef.current.add(`${leadId}:${restoredEst.id}`);
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
    persistTrash(newTrash);
    // Estimates (and other lead fields) need persistLeads so cloud sync runs
    if (item.kind === 'estimate') {
      persistLeads(newLeads);
    } else {
      setLeads(newLeads);
      try {
        localStorage.setItem('summitLeads', JSON.stringify(newLeads));
      } catch {
        /* ignore */
      }
    }
    showToast('Restored');
  };

  const permanentlyDelete = (trashId: string) => {
    if (!confirm('Permanently delete? This cannot be undone.')) return;
    const doomed = trash.find((t) => t.id === trashId);
    const newTrash = trash.filter((t) => t.id !== trashId);
    persistTrash(newTrash);

    if (doomed?.kind === 'lead') {
      const leadId = doomed.lead.id;
      const cloudId = doomed.lead.supabaseId?.trim();
      // Purge this lead's invoices from the Invoices index + Storage
      const doomedInvoices = appInvoices.filter((i) => i.leadId === leadId);
      if (doomedInvoices.length > 0) {
        persistAppInvoices(
          appInvoices.filter((i) => i.leadId !== leadId)
        );
        if (supabaseEnabled && supabase) {
          for (const inv of doomedInvoices) {
            try {
              const marker = '/lead-docs/';
              const idx = inv.url?.indexOf(marker) ?? -1;
              if (idx >= 0) {
                const objectPath = decodeURIComponent(
                  inv.url.slice(idx + marker.length).split('?')[0]
                );
                void supabase.storage.from('lead-docs').remove([objectPath]);
              }
            } catch {
              /* ignore */
            }
          }
        }
      }
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
        } else if (doomed.kind === 'estimate' && doomed.estimate) {
          if (doomed.estimate.supabaseId) {
            void supabase
              .from('estimates')
              .delete()
              .eq('id', doomed.estimate.supabaseId);
          }
          const path = doomed.estimate.pdfUrl
            ? storagePathFromLeadDocUrl(doomed.estimate.pdfUrl)
            : null;
          if (path) {
            void supabase.storage.from('lead-docs').remove([path]);
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

    const purgedLeadIds = new Set(
      doomed.filter((t) => t.kind === 'lead').map((t) => t.lead.id)
    );
    const invoicesToPurge = appInvoices.filter(
      (i) => i.leadId != null && purgedLeadIds.has(i.leadId)
    );
    if (invoicesToPurge.length > 0) {
      persistAppInvoices(
        appInvoices.filter(
          (i) => i.leadId == null || !purgedLeadIds.has(i.leadId)
        )
      );
    }

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
            } else if (item.kind === 'estimate' && item.estimate) {
              if (item.estimate.supabaseId) {
                await supabase
                  .from('estimates')
                  .delete()
                  .eq('id', item.estimate.supabaseId);
              }
              const path = item.estimate.pdfUrl
                ? storagePathFromLeadDocUrl(item.estimate.pdfUrl)
                : null;
              if (path) {
                await supabase.storage.from('lead-docs').remove([path]);
              }
            }
          } catch (err) {
            console.error('Empty trash purge error:', err);
          }
        }
        for (const inv of invoicesToPurge) {
          try {
            const marker = '/lead-docs/';
            const idx = inv.url?.indexOf(marker) ?? -1;
            if (idx >= 0) {
              const objectPath = decodeURIComponent(
                inv.url.slice(idx + marker.length).split('?')[0]
              );
              await supabase.storage.from('lead-docs').remove([objectPath]);
            }
          } catch {
            /* ignore */
          }
        }
      })();
    }
    showToast('Trash emptied');
  };


  const addLeadNote = () => {
    if (!leadNoteDraft.trim() || !currentLeadId) return;
    const newNote: LeadNote = {
      id: newClientId('note'),
      createdAt: new Date().toISOString(),
      text: leadNoteDraft.trim(),
      date:
        new Date().toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }) +
        ' ' +
        new Date().toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
        }),
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
    // Default on when company branding exists; still toggleable per report
    setPhotoReportIncludeBranding(companySettingsConfigured());
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
      const showBrand = photoReportIncludeBranding;
      const brand = showBrand
        ? companyBrandName() ||
          (typeof userCompany === 'string' && userCompany.trim()) ||
          'Summit'
        : '';
      const brandSub = showBrand
        ? companySettingsConfigured()
          ? (companySettings.license || '').trim()
            ? `ROC# ${(companySettings.license || '').trim()}`
            : (companySettings.address || '').trim()
          : ''
        : '';
      const brandPhone = showBrand
        ? companySettingsConfigured()
          ? displayPhoneUS(companySettings.phone) ||
            (companySettings.phone || '').trim() ||
            ''
          : displayPhoneUS(userPhone) || userPhone || ''
        : '';
      const title = (photoReportTitle || 'Photo Report').trim();
      const dateStr = new Date().toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
      const ink = { r: 28, g: 28, b: 30 };
      const muted = { r: 100, g: 100, b: 105 };
      const rule = { r: 190, g: 190, b: 195 };

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

      // Cover page — branding optional (bland when toggle off)
      const left = 18;
      const right = pageW - 18;
      let hy = 16;
      if (showBrand) {
        const logoW = drawDocLogo(doc, left, hy);
        const textX = left + logoW + 4;
        doc.setTextColor(ink.r, ink.g, ink.b);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(14);
        doc.text(brand, textX, hy + 5.5);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(muted.r, muted.g, muted.b);
        if (brandSub) doc.text(brandSub, textX, hy + 10.5);
        if (brandPhone) {
          doc.text(brandPhone, textX, brandSub ? hy + 14.5 : hy + 10.5);
        }
        if (showCompanyPmOnDoc('prowest') && companyBrandName()) {
          const pmName = estimatePmName();
          const pmPhone = estimatePmPhone();
          const pmEmail = (companySettings.projectManagerEmail || '').trim();
          const pmY = brandSub && brandPhone ? hy + 18.5 : brandPhone || brandSub ? hy + 14.5 : hy + 10.5;
          const pmBits = [
            pmName ? `PM ${pmName}` : '',
            pmPhone || '',
            pmEmail || '',
          ].filter(Boolean);
          if (pmBits.length) {
            doc.text(pmBits.join(' · '), textX, pmY);
          }
        }
      }

      doc.setTextColor(ink.r, ink.g, ink.b);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(18);
      doc.text('PHOTO REPORT', right, hy + 6, { align: 'right' });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(muted.r, muted.g, muted.b);
      doc.text(dateStr, right, hy + 11.5, { align: 'right' });
      doc.text(
        `${chosen.length} photo${chosen.length === 1 ? '' : 's'}`,
        right,
        hy + 16,
        { align: 'right' }
      );

      hy = 38;
      doc.setDrawColor(rule.r, rule.g, rule.b);
      doc.setLineWidth(0.4);
      doc.line(left, hy, right, hy);

      doc.setTextColor(ink.r, ink.g, ink.b);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(22);
      doc.text(title, pageW / 2, pageH * 0.42, { align: 'center' });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      doc.setTextColor(muted.r, muted.g, muted.b);
      doc.text(leadName, pageW / 2, pageH * 0.42 + 12, { align: 'center' });
      if (addr) {
        const addrLines = doc.splitTextToSize(addr, pageW - 48);
        doc.setFontSize(10);
        doc.text(addrLines, pageW / 2, pageH * 0.42 + 20, { align: 'center' });
      }
      if (lead.jobNumber) {
        doc.setFontSize(10);
        doc.text(
          `Job ${String(lead.jobNumber)}`,
          pageW / 2,
          pageH * 0.42 + (addr ? 32 : 26),
          { align: 'center' }
        );
      }
      doc.setFontSize(8);
      doc.setTextColor(160, 160, 165);
      if (showBrand && brand) {
        doc.text(brand, pageW / 2, pageH - 14, { align: 'center' });
      }
      doc.text('Photo documentation · for customer / carrier review', pageW / 2, pageH - 9, {
        align: 'center',
      });

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
        doc.setTextColor(160, 160, 165);
        if (showBrand && brand) doc.text(brand, left, pageH - 8);
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
    setPendingTrashPhotoId(photoId);
  };

  const confirmTrashPhoto = () => {
    const photoId = pendingTrashPhotoId;
    setPendingTrashPhotoId(null);
    if (!photoId || !currentLeadId) return;
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
      const importedMeasurements: RoofMeasurement[] = [];
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

        // Parse EagleView / Roofr PDF → structured measurement
        const isPdf =
          file.type === 'application/pdf' ||
          /\.pdf$/i.test(file.name);
        if (isPdf) {
          try {
            const form = new FormData();
            form.append('file', file, file.name);
            const parseRes = await fetch('/api/measurements/parse', {
              method: 'POST',
              body: form,
            });
            const parsed = (await parseRes.json()) as {
              ok?: boolean;
              provider?: string;
              message?: string;
              note?: string;
              measurements?: {
                footprintSqFt?: number | null;
                surfaceSqFt?: number | null;
                squares?: number | null;
                measuredSquares?: number | null;
                pitch?: string;
                secondaryPitch?: string | null;
                secondaryFraction?: number | null;
                areasPerPitch?: {
                  pitch: string;
                  areaSqFt: number;
                  pctOfRoof: number;
                }[];
                hasLowSlope?: boolean;
                lowSlopeFraction?: number | null;
                ridgeLF?: number;
                hipLF?: number;
                valleyLF?: number;
                rakeLF?: number;
                eaveLF?: number;
                dripEdgeLF?: number;
                perimeterLF?: number;
                waste?: number;
                edgesVerified?: boolean;
                measureSource?: RoofMeasurement['measureSource'];
              };
            };
            if (parseRes.ok && parsed.ok && parsed.measurements) {
              const pm = parsed.measurements;
              const squares = Number(pm.squares) || 0;
              const pitch = pm.pitch || '6/12';
              const isFlat = pitch === 'Flat';
              const wasteFrac =
                pm.waste != null && Number.isFinite(Number(pm.waste))
                  ? Number(pm.waste)
                  : 0.15;
              const measuredArea =
                Number(pm.footprintSqFt) ||
                (pm.measuredSquares != null
                  ? Number(pm.measuredSquares) * 100
                  : Math.round(
                      (squares * 100) / (1 + wasteFrac)
                    ));
              // Prefer area-rank secondary; if low-slope exists on another
              // pitch, surface it so apply can hint underlayment.
              let secondaryPitch = pm.secondaryPitch || undefined;
              let secondaryFraction =
                pm.secondaryFraction != null
                  ? Number(pm.secondaryFraction)
                  : undefined;
              if (pm.hasLowSlope && Array.isArray(pm.areasPerPitch)) {
                const lowRows = pm.areasPerPitch
                  .filter((r) => {
                    const rise = Number(String(r.pitch).split('/')[0]);
                    return Number.isFinite(rise) && rise > 0 && rise <= 3;
                  })
                  .sort((a, b) => b.pctOfRoof - a.pctOfRoof);
                const topLow = lowRows[0];
                const secRise = secondaryPitch
                  ? Number(String(secondaryPitch).split('/')[0])
                  : NaN;
                if (
                  topLow &&
                  !(Number.isFinite(secRise) && secRise > 0 && secRise <= 3)
                ) {
                  secondaryPitch = topLow.pitch;
                  secondaryFraction =
                    pm.lowSlopeFraction != null
                      ? Number(pm.lowSlopeFraction)
                      : topLow.pctOfRoof;
                }
              }
              const measurement = normalizeMeasurement({
                id: `ev-${id}`,
                createdAt: stamp,
                label: `${
                  parsed.provider === 'roofr' ? 'Roofr' : 'EagleView'
                } · ${file.name.replace(/\.pdf$/i, '')}`,
                points: [],
                roofType: isFlat
                  ? 'flat-modified-bitumen'
                  : 'pitched-shingles',
                pitch,
                pitchAuto: false,
                secondaryPitch,
                secondaryFraction,
                waste: wasteFrac,
                wasteAuto: false,
                footprintSqFt: measuredArea,
                surfaceSqFt: measuredArea,
                squares: isFlat ? 0 : squares,
                flatSquares: isFlat ? squares : 0,
                perimeterLF: Number(pm.perimeterLF) || 0,
                edgeLengthsLF: [],
                ridgeLF: Number(pm.ridgeLF) || 0,
                hipLF: Number(pm.hipLF) || 0,
                eaveLF: Number(pm.eaveLF) || 0,
                rakeLF: Number(pm.rakeLF) || 0,
                valleyLF: Number(pm.valleyLF) || 0,
                dripEdgeLF: Number(pm.dripEdgeLF) || 0,
                measureSource: pm.measureSource || 'eagleview',
                edgesVerified: true,
              });
              if (measurement) {
                importedMeasurements.push(measurement);
              }
            } else if (parseRes.status === 422) {
              console.warn('measurement parse incomplete', parsed.message);
            }
          } catch (parseErr) {
            console.error('parse upload', parseErr);
          }
        }
      }
      if (newDocs.length === 0) {
        showToast('No files uploaded');
        return;
      }
      const updated = leads.map((lead) =>
        lead.id === currentLeadId
          ? {
              ...lead,
              // Measurement reports live under Measurements — not Documents
              measurementReports: [
                ...(lead.measurementReports || []),
                ...newDocs,
              ],
              measurements: [
                ...(lead.measurements || []),
                ...importedMeasurements,
              ],
            }
          : lead
      );
      persistLeads(updated);

      const last = importedMeasurements[importedMeasurements.length - 1];
      if (last) {
        setSelectedMeasurementId(last.id);
        applyMeasurementToEstimator(last, currentLead || undefined);
        const pitchNote = last.secondaryPitch
          ? `${last.pitch}+${last.secondaryPitch}`
          : last.pitch;
        showToast(
          `EagleView · ${last.squares} sq (incl. ${Math.round(
            (Number(last.waste) || 0.15) * 100
          )}% waste) · ${pitchNote} — applied (ridge/fascia not auto-filled)`
        );
      } else {
        showToast(
          newDocs.length === 1
            ? 'Measurement PDF saved (could not auto-read numbers — enter manually)'
            : `${newDocs.length} files saved`
        );
      }
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
    // Keep Invoices index in sync when an invoice PDF is trashed from Documents
    const stillInInvoices = appInvoices.some(
      (i) => i.id === docId || i.url === doc.url
    );
    if (stillInInvoices) {
      persistAppInvoices(
        appInvoices.filter((i) => i.id !== docId && i.url !== doc.url)
      );
    }
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
    adjustmentDate: adjustmentDate || '',
    adjustmentTime: adjustmentTime || '',
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
    setCurrentLeadId(leadId);
    setLeadToolReturnTab('documents');
    exitLeadDocumentWorkspace({ returnTab: 'documents' });
    const lead = updatedLeads.find((l) => l.id === leadId);
    if (lead) {
      applyLeadFields(lead);
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
    setCurrentLeadId(newLead.id);
    setLeadToolReturnTab('overview');
    exitLeadDocumentWorkspace({ returnTab: 'overview' });
    applyLeadFields(newLead);
    showToast('New lead created with take-off');
  };

  /** Leave estimator; keep unsaved estimate guard. Optionally return to source lead. */
  const completeLeaveEstimator = (opts?: {
    returnToLead?: boolean;
    targetTab?: AppTab;
  }) => {
    setShowProfessionalEstimate(false);
    setShowUserMenu(false);
    setEstimateWorkspace('estimate');
    setEditingEstimateId(null);

    if (opts?.returnToLead) {
      const id = estimatorSourceLeadId ?? currentLeadId;
      if (id != null) {
        setCurrentLeadId(id);
        setIsEditingLead(true);
        setActiveTab('leads');
        const back =
          leadToolReturnTab && leadToolReturnTab !== 'estimator'
            ? leadToolReturnTab
            : 'estimates';
        setProfileTab(back);
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

  const leaveEstimator = (opts?: {
    returnToLead?: boolean;
    targetTab?: AppTab;
  }) => {
    if (hasUnsavedChanges) {
      setPendingLeave({
        kind: 'estimator',
        returnToLead: opts?.returnToLead,
        targetTab: opts?.targetTab,
      });
      return false;
    }
    return completeLeaveEstimator(opts);
  };

  const confirmPendingLeaveDiscard = () => {
    if (!pendingLeave) return;
    const keepContact =
      pendingLeave.kind === 'estimator'
        ? (pendingLeave.returnToLead && estimatorSourceLeadId != null) ||
          currentLeadId != null
        : estimatorSourceLeadId != null || currentLeadId != null;
    resetEstimatorFields(!!keepContact);
    setHasUnsavedChanges(false);
    const leave = pendingLeave;
    setPendingLeave(null);
    if (leave.kind === 'estimator') {
      completeLeaveEstimator({
        returnToLead: leave.returnToLead,
        targetTab: leave.targetTab,
      });
      return;
    }
    if (leave.kind === 'nav' && leave.newTab) {
      if (!keepContact) setCurrentLeadId(null);
      // Proceed with nav after discard
      setShowProfessionalEstimate(false);
      setShowUserMenu(false);
      setHeaderSearch('');
      const newTab = leave.newTab;
      if (newTab !== 'leads') {
        setIsEditingLead(false);
        setProfileTab('overview');
        setEstimateWorkspace('estimate');
        setEstimatorSourceLeadId(null);
      }
      setActiveTab(newTab);
    }
  };

  const confirmPendingLeaveSave = async () => {
    if (!pendingLeave) return;
    const leave = pendingLeave;
    await saveCurrentEstimate();
    setPendingLeave(null);
    if (leave.kind === 'estimator') {
      completeLeaveEstimator({
        returnToLead: leave.returnToLead,
        targetTab: leave.targetTab,
      });
      return;
    }
    if (leave.kind === 'nav' && leave.newTab) {
      setShowProfessionalEstimate(false);
      setShowUserMenu(false);
      setHeaderSearch('');
      const newTab = leave.newTab;
      if (
        isEditingLead &&
        currentLeadId != null &&
        activeTab === 'leads' &&
        newTab !== 'leads'
      ) {
        saveLeadDraft({ silent: true });
      }
      if (newTab !== 'leads') {
        setIsEditingLead(false);
        setProfileTab('overview');
        setEstimateWorkspace('estimate');
        setEstimatorSourceLeadId(null);
      }
      setActiveTab(newTab);
    }
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

  /** Estimates use company settings when configured; else personal profile company. */
  const brandCompany =
    companyBrandName() ||
    userCompany.trim() ||
    DEFAULT_USER_PROFILE.company;

  const generatePDF = async (opts?: {
    download?: boolean;
    save?: boolean;
    leadId?: number;
    estimateId?: number;
    /** Fresh leads array when called right after persist (avoids stale overwrite) */
    leadsSnapshot?: Lead[];
  }) => {
    // Print-friendly letter layout (twin of mitigation invoice)
    const wantDownload = opts?.download !== false && opts?.save !== true
      ? true
      : opts?.download === true;
    const wantSave = opts?.save === true;
    // Legacy: generatePDF() with no opts = download only
    const doDownload = opts == null ? true : wantDownload;
    const client = resolveEstimatorClient();
    const doc = new jsPDF({ unit: 'mm', format: 'letter' });
    const scopeItems = buildScopeOfWork();
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const left = 18;
    const right = pageW - 18;
    const ink = { r: 28, g: 28, b: 30 };
    const muted = { r: 100, g: 100, b: 105 };
    const rule = { r: 190, g: 190, b: 195 };
    const pmName = estimatePmName();
    const pmPhone = estimatePmPhone();
    const pmEmail = estimatePmEmail();
    const money = (n: number) =>
      `$${Math.round(n).toLocaleString()}`;
    const useCompanyHeader = Boolean(companyBrandName());
    const estimateBrand = useCompanyHeader
      ? companyBrandName() || brandCompany
      : brandCompany;
    const estimateContact = useCompanyHeader
      ? companyContactLine()
      : [pmPhone, pmEmail].filter(Boolean).join(' · ');

    // --- Header: logo (upload or Summit) + Contractor (company) ---
    let y = 16;
    const logoW = drawDocLogo(doc, left, y);
    const textX = left + logoW + 4;

    // Estimates always label the company as Contractor (never Service provider)
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.text('CONTRACTOR', textX, y + 3);
    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text(estimateBrand, textX, y + 8.5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(muted.r, muted.g, muted.b);
    if (useCompanyHeader) {
      const bizAddr = (companySettings.address || '').trim();
      if (bizAddr) {
        doc.text(bizAddr, textX, y + 13);
      }
      if (estimateContact) {
        doc.text(
          estimateContact,
          textX,
          bizAddr ? y + 17 : y + 13
        );
      }
    } else {
      const pmLine = [pmName, userTitle.trim() || 'Project Manager']
        .filter(Boolean)
        .join(' · ');
      if (pmLine) doc.text(pmLine, textX, y + 13);
      if (pmPhone) doc.text(pmPhone, textX, y + 17);
    }

    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('ESTIMATE', right, y + 6, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.text('Roofing proposal', right, y + 11.5, { align: 'right' });
    doc.text(`Prepared ${estimateDate}`, right, y + 16, { align: 'right' });

    y = 38;
    doc.setDrawColor(rule.r, rule.g, rule.b);
    doc.setLineWidth(0.4);
    doc.line(left, y, right, y);
    y += 8;

    // --- Client / Contractor / PM meta ---
    const metaLeft = left;
    const metaRight = pageW / 2 + 4;
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text('PREPARED FOR', metaLeft, y);
    doc.text('CONTRACTOR', metaRight, y);
    y += 5;
    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(client.fullName, metaLeft, y);
    doc.text(estimateBrand || '—', metaRight, y);
    y += 5;
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.setFontSize(9);
    doc.text(client.phone || '—', metaLeft, y);
    if (estimateContact) doc.text(estimateContact, metaRight, y);
    y += 5;
    doc.text(client.email || '—', metaLeft, y);
    y += 8;
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text('LOCATION', metaLeft, y);
    doc.text('PROJECT MANAGER', metaRight, y);
    y += 5;
    const locY = y;
    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const addressLines = doc.splitTextToSize(
      client.fullAddress || '—',
      pageW / 2 - 28
    );
    doc.text(addressLines, metaLeft, locY);
    doc.text(
      [pmName || '—', userTitle.trim() || 'Project Manager']
        .filter(Boolean)
        .join(' · '),
      metaRight,
      locY
    );
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.setFontSize(9);
    doc.text(pmPhone || '—', metaRight, locY + 5);
    doc.text(pmEmail || '—', metaRight, locY + 10);
    const afterAddrY = locY + Math.max(12, addressLines.length * 5);
    doc.setFontSize(9);
    doc.text(
      client.jobNumber ? `Job # ${client.jobNumber}` : '—',
      metaLeft,
      afterAddrY
    );
    y = Math.max(afterAddrY + 6, locY + 16);

    // --- Scope table ---
    doc.setFillColor(245, 245, 246);
    doc.rect(left, y - 4, right - left, 8, 'F');
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.text('SCOPE OF WORK', left + 2, y + 1);
    doc.text('AMOUNT', right - 2, y + 1, { align: 'right' });
    y += 8;
    doc.setDrawColor(rule.r, rule.g, rule.b);
    doc.setLineWidth(0.25);
    doc.line(left, y, right, y);
    y += 6;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(ink.r, ink.g, ink.b);
    scopeItems.forEach((item) => {
      if (y > pageH - 55) {
        doc.addPage();
        y = 20;
      }
      const line = typeof item === 'string' ? item : item.text;
      const amount =
        typeof item === 'object' && item && item.amount != null && item.amount > 0
          ? Math.round(item.amount)
          : null;
      const wrapped = doc.splitTextToSize(line, amount != null ? right - left - 40 : right - left - 4);
      doc.text(wrapped, left + 2, y);
      if (amount != null) {
        doc.text(money(amount), right - 2, y, { align: 'right' });
      }
      y += Math.max(7, wrapped.length * 4.8);
    });

    if (notes.trim()) {
      y += 6;
      if (y > pageH - 50) {
        doc.addPage();
        y = 20;
      }
      doc.setDrawColor(rule.r, rule.g, rule.b);
      doc.line(left, y, right, y);
      y += 8;
      doc.setTextColor(muted.r, muted.g, muted.b);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.text('ADDITIONAL NOTES', left, y);
      y += 5;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(ink.r, ink.g, ink.b);
      const noteLines = doc.splitTextToSize(notes.trim(), right - left);
      doc.text(noteLines, left, y);
      y += noteLines.length * 4.2 + 6;
    }

    y += 4;
    if (y > pageH - 45) {
      doc.addPage();
      y = 20;
    }
    doc.setDrawColor(rule.r, rule.g, rule.b);
    doc.line(left, y, right, y);
    y += 10;

    const totalsX = right - 70;
    if (bufferUsed > 0) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(muted.r, muted.g, muted.b);
      doc.text('Special discount', totalsX, y);
      doc.text(`−$${bufferUsed.toLocaleString()}`, right - 2, y, {
        align: 'right',
      });
      y += 7;
    }
    doc.setDrawColor(ink.r, ink.g, ink.b);
    doc.setLineWidth(0.5);
    doc.line(totalsX, y - 2, right, y - 2);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.text('Total investment', totalsX, y + 4);
    doc.text(money(estimatorTotalPrice), right - 2, y + 4, {
      align: 'right',
    });
    y += 14;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(muted.r, muted.g, muted.b);
    const disclaimer = doc.splitTextToSize(
      'Pricing subject to change upon signed change order for unforeseen conditions. Valid for 30 days.',
      right - left
    );
    doc.text(disclaimer, left, y);
    y += disclaimer.length * 4 + 6;
    doc.setFontSize(9);
    doc.setTextColor(ink.r, ink.g, ink.b);
    doc.text(`Thank you for choosing ${estimateBrand}.`, left, y);
    y += 5;
    doc.setFontSize(8);
    doc.setTextColor(muted.r, muted.g, muted.b);
    doc.text(
      `Questions? ${pmName || '—'} · ${pmPhone || ''} · ${pmEmail || ''}`,
      left,
      y
    );

    doc.setFontSize(7);
    doc.setTextColor(160, 160, 165);
    doc.text('Estimate · for customer review', pageW / 2, pageH - 10, {
      align: 'center',
    });

    const safeName =
      [client.firstName, client.lastName].filter(Boolean).join('_') || 'Estimate';
    const safeBrand =
      estimateBrand.replace(/[^\w]+/g, '_').replace(/^_|_$/g, '') || 'Estimate';
    const fileName = `${safeBrand}_Estimate_${safeName}.pdf`;
    const blob = doc.output('blob');

    if (doDownload) {
      doc.save(fileName);
    }

    if (!wantSave) {
      if (doDownload) showToast('Estimate PDF downloaded');
      return;
    }

    const leadIdAtSave =
      opts?.leadId ?? currentLeadId ?? estimatorSourceLeadId ?? null;
    if (leadIdAtSave == null) {
      showToast('Select a lead before saving the estimate');
      doc.save(fileName);
      return;
    }
    const sourceLeads = opts?.leadsSnapshot ?? leads;
    const lead = sourceLeads.find((l) => l.id === leadIdAtSave);
    if (!lead) {
      showToast('Lead not found');
      doc.save(fileName);
      return;
    }

    try {
      if (!supabaseEnabled || !supabase) {
        showToast('Cloud offline — downloading PDF instead');
        doc.save(fileName);
        return;
      }
      const folderKey = lead.supabaseId?.trim() || String(leadIdAtSave);
      const id = `est-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const storagePath = `${folderKey}/estimates/${id}-${fileName}`;
      const { error: upErr } = await supabase.storage
        .from('lead-docs')
        .upload(storagePath, blob, {
          cacheControl: '3600',
          upsert: false,
          contentType: 'application/pdf',
        });
      if (upErr) {
        console.error('Estimate PDF upload error', upErr);
        showToast('Cloud save failed — downloading PDF instead');
        doc.save(fileName);
        return;
      }
      const { data: pub } = supabase.storage
        .from('lead-docs')
        .getPublicUrl(storagePath);
      const durableUrl = pub.publicUrl;
      const targetEstimateId =
        opts?.estimateId ?? editingEstimateId ?? null;

      // Replace previous PDF for this estimate (avoid orphans in storage)
      const prevEst =
        targetEstimateId != null
          ? (lead.estimates || []).find((e) => e.id === targetEstimateId)
          : undefined;
      if (prevEst?.pdfUrl && prevEst.pdfUrl !== durableUrl) {
        const oldPath = storagePathFromLeadDocUrl(prevEst.pdfUrl);
        if (oldPath) {
          void supabase.storage.from('lead-docs').remove([oldPath]);
        }
      }

      const pdfPatch = {
        pdfDocumentId: id,
        pdfUrl: durableUrl,
        pdfName: fileName,
      };
      const updated = sourceLeads.map((l) => {
        if (l.id !== leadIdAtSave) return l;
        let estimates = l.estimates || [];
        if (targetEstimateId != null) {
          let patched = false;
          estimates = estimates.map((e) => {
            if (patched) return e;
            if (
              prevEst?.supabaseId &&
              e.supabaseId === prevEst.supabaseId
            ) {
              patched = true;
              return { ...e, ...pdfPatch };
            }
            if (e.id === targetEstimateId) {
              patched = true;
              return { ...e, ...pdfPatch };
            }
            return e;
          });
        }
        // Never dual-write estimate PDFs into Documents
        const documents = (l.documents || []).filter(
          (d) => !isEstimatePdfDocument(d) && d.id !== id && d.url !== durableUrl
        );
        return { ...l, estimates, documents };
      });
      if (targetEstimateId != null) {
        dirtyEstimateKeysRef.current.add(
          `${leadIdAtSave}:${targetEstimateId}`
        );
      }
      persistLeads(updated);
      showToast(
        prevEst || editingEstimateId != null
          ? 'Estimate updated'
          : 'Estimate saved'
      );
      setShowProfessionalEstimate(false);
      setHasUnsavedChanges(false);
      setIsEditingLead(true);
      setActiveTab('leads');
      setProfileTab('estimates');
      setCurrentLeadId(leadIdAtSave);
    } catch (err) {
      console.error('Estimate save PDF error', err);
      showToast('Save failed — downloading PDF instead');
      doc.save(fileName);
    }
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
              onClick={() => void generatePDF({ download: true })}
              className="btn-primary px-6 sm:px-8 py-3 rounded-3xl font-semibold"
            >
              Download PDF
            </button>
          </div>

          <div className="text-center mb-10">
            {appLogoDataUrl() ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={appLogoDataUrl()}
                alt=""
                className="mx-auto mb-3 h-14 w-auto max-w-[10rem] object-contain"
              />
            ) : (
              <div className="mx-auto mb-3 w-12 h-12 rounded-xl bg-zinc-900 flex items-center justify-center">
                <span className="text-white text-xl font-bold tracking-tight">
                  S
                </span>
              </div>
            )}
            <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">
              Contractor
            </div>
            <div className="font-bold text-4xl tracking-tight">
              {companyBrandName() || brandCompany}
            </div>
            {companyBrandName() ||
            (companySettings.address || '').trim() ||
            companyContactLine() ? (
              <div className="text-sm text-zinc-500 mt-2 space-y-0.5">
                {(companySettings.address || '').trim() ? (
                  <div className="text-zinc-400">
                    {companySettings.address}
                  </div>
                ) : null}
                {companyContactLine() ? (
                  <div className="text-zinc-400">{companyContactLine()}</div>
                ) : null}
              </div>
            ) : null}
            <div className="text-sm text-zinc-400 mt-2">
              Prepared {estimateDate}
            </div>
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
                Contractor
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-1.5 text-sm">
                <div className="font-medium text-zinc-900">
                  {companyBrandName() || brandCompany}
                </div>
                {companyContactLine() ? (
                  <div>
                    <span className="text-zinc-500">Contact:</span>{' '}
                    {companyContactLine()}
                  </div>
                ) : null}
                {(companySettings.address || '').trim() ? (
                  <div className="sm:col-span-2 text-zinc-600">
                    {companySettings.address}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="mb-8 rounded-2xl border border-zinc-200 bg-zinc-50/80 px-5 py-4">
              <div className="font-semibold text-sm text-zinc-900 mb-2">
                Your Project Manager
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-1.5 text-sm">
                <div>
                  <span className="font-medium text-zinc-900">
                    {estimatePmName() || '—'}
                  </span>
                  {userTitle.trim() ? (
                    <span className="text-zinc-500"> · {userTitle}</span>
                  ) : null}
                </div>
                <div>
                  <span className="text-zinc-500">Phone:</span>{' '}
                  {estimatePmPhone() || '—'}
                </div>
                {estimatePmEmail() ? (
                  <div className="sm:col-span-2">
                    <span className="text-zinc-500">Email:</span>{' '}
                    <a
                      href={`mailto:${estimatePmEmail()}`}
                      className="text-sky-800 hover:underline"
                    >
                      {estimatePmEmail()}
                    </a>
                  </div>
                ) : null}
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
              Questions? Contact {estimatePmName() || '—'}
              {userTitle.trim() ? ` (${userTitle})` : ''} ·{' '}
              {estimatePmPhone() || '—'}
              {estimatePmEmail() ? ` · ${estimatePmEmail()}` : ''}
            </div>

            <button
              onClick={() => void saveCurrentEstimate({ savePdf: true })}
              className="btn-primary mt-10 w-full py-4 rounded-3xl font-semibold text-lg"
            >
              Save estimate
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
    // Leaving a document workspace via nav — return to normal shell
    if (systemDocWorkspace) {
      setSystemDocWorkspace(null);
      setTakeoffAssignOpen(false);
      setEmergencyDraft(null);
      setEmergencyPreview(false);
      if (
        systemDocWorkspace === 'mitigation' ||
        systemDocWorkspace === 'mitigation_personal' ||
        systemDocWorkspace === 'mitigation_company'
      ) {
        setMitigationDraft(null);
        setMitigationWorkspace('invoice');
        setShowMitigationCostBreakdown(false);
        setShowMitigationInvoice(false);
        setShowMitigationPreview(false);
        try {
          sessionStorage.removeItem('summitMitigationWorkspace');
        } catch {
          /* ignore */
        }
      }
    }
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
      | 'tasks'
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
    { tab: 'tasks', label: 'Tasks', icon: 'tasks' },
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
      case 'tasks':
        return (
          <svg {...common}>
            <path d="M9 11l2.5 2.5L16 9" />
            <rect x="3" y="4" width="18" height="16" rx="2" />
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

  const renderSidebarNav = (onNavigate?: () => void, opts?: { collapsed?: boolean }) => {
    const collapsed = opts?.collapsed === true;
    return (
    <nav className={`flex flex-col gap-0.5 py-3 ${collapsed ? 'px-1.5' : 'px-2.5'}`}>
      {sidebarPrimary.map((item) => {
        const active = isSidebarTabActive(item.tab);
        return (
          <button
            key={item.tab}
            type="button"
            title={collapsed ? item.label : undefined}
            onClick={() => {
              setSidebarProfileOpen(false);
              openNavTab(item.tab);
              onNavigate?.();
            }}
            className={`flex items-center w-full rounded-xl text-sm font-medium transition-all ${
              collapsed
                ? 'justify-center px-0 py-2.5'
                : 'gap-3 px-3 py-2.5'
            } ${
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
            {!collapsed && <span className="truncate">{item.label}</span>}
          </button>
        );
      })}
    </nav>
    );
  };

  /** Grok-style profile dock — bottom of sidebar */
  const renderSidebarProfile = (
    onNavigate?: () => void,
    opts?: { collapsed?: boolean }
  ) => {
    const collapsed = opts?.collapsed === true;
    const displayName = userName || (email ? email.split('@')[0] : 'Account');
    const subtitle =
      userCompany.trim() || userTitle.trim() || userEmail || email || '';
    const initial = (userName || email || 'J').charAt(0).toUpperCase();
    const profileActive = activeTab === 'settings' && !showProfessionalEstimate;

    return (
      <div
        className={`relative shrink-0 border-t border-zinc-200/70 py-2.5 ${
          collapsed ? 'px-1.5' : 'px-2.5'
        }`}
        data-sidebar-profile
      >
        {sidebarProfileOpen && (
          <div
            className={`absolute bottom-full mb-1.5 rounded-2xl bg-white border border-zinc-200 shadow-md overflow-hidden z-50 ${
              collapsed
                ? 'left-1.5 w-52'
                : 'left-2.5 right-2.5'
            }`}
          >
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
          title={collapsed ? displayName : undefined}
          onClick={() => {
            setShowUserMenu(false);
            setSidebarProfileOpen((v) => !v);
          }}
          className={`w-full flex items-center rounded-2xl text-left transition-colors ${
            collapsed ? 'justify-center px-0 py-2' : 'gap-2.5 px-2 py-2'
          } ${
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
          {!collapsed && (
            <>
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
            </>
          )}
        </button>
      </div>
    );
  };

  const desktopSidebarWidth = sidebarCollapsed
    ? SIDEBAR_WIDTH_COLLAPSED
    : SIDEBAR_WIDTH_EXPANDED;

  /** Document workspaces sit beside the sidebar and below the app header. */
  const documentWorkspaceClass = `fixed top-14 sm:top-16 bottom-0 right-0 z-[35] bg-zinc-50 overflow-y-auto transition-[left] duration-200 ease-out left-0 ${
    sidebarCollapsed ? 'lg:left-[4.25rem]' : 'lg:left-[15.5rem]'
  }`;

  const renderAppSidebar = () => (
    <>
      {/* Desktop sidebar */}
      <aside
        className="hidden lg:flex fixed inset-y-0 left-0 z-40 flex-col border-r border-zinc-200/80 bg-zinc-50/95 backdrop-blur-md transition-[width] duration-200 ease-out"
        style={{ width: desktopSidebarWidth }}
        aria-label="Main navigation"
        data-collapsed={sidebarCollapsed ? 'true' : 'false'}
      >
        <div
          className={`h-14 sm:h-16 flex items-center border-b border-zinc-200/70 shrink-0 ${
            sidebarCollapsed ? 'justify-center px-1.5' : 'gap-2.5 px-3'
          }`}
        >
          {sidebarCollapsed ? (
            <button
              type="button"
              onClick={toggleSidebarCollapsed}
              className="w-9 h-9 rounded-xl flex items-center justify-center hover:opacity-90 transition-opacity overflow-hidden"
              title="Expand sidebar"
              aria-label="Expand sidebar"
            >
              {renderAppMark({
                size: 'md',
                className: 'w-9 h-9',
                imgClassName:
                  'w-9 h-9 rounded-xl object-contain border border-zinc-200 bg-white',
              })}
            </button>
          ) : (
            <>
              {renderAppMark({ size: 'md' })}
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-[15px] tracking-tight text-zinc-900 truncate">
                  {appDisplayName()}
                </div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-medium">
                  Roofing OS
                </div>
              </div>
              <button
                type="button"
                onClick={toggleSidebarCollapsed}
                className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-800"
                title="Collapse sidebar"
                aria-label="Collapse sidebar"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  viewBox="0 0 24 24"
                  aria-hidden
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15 6 9 12l6 6"
                  />
                </svg>
              </button>
            </>
          )}
        </div>
        <div className="flex-1 overflow-y-auto overflow-x-hidden py-1">
          {renderSidebarNav(undefined, { collapsed: sidebarCollapsed })}
        </div>
        {renderSidebarProfile(undefined, { collapsed: sidebarCollapsed })}
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
                {renderAppMark({ size: 'md' })}
                <span className="font-semibold text-zinc-900 truncate">
                  {appDisplayName()}
                </span>
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

        {/* Desktop: expand rail when collapsed (sidebar logo also expands) */}
        {sidebarCollapsed && (
          <button
            type="button"
            className="hidden lg:flex shrink-0 w-10 h-10 rounded-xl items-center justify-center text-zinc-700 hover:bg-zinc-200/70 border border-zinc-200 bg-white"
            onClick={toggleSidebarCollapsed}
            aria-label="Expand sidebar"
            title="Expand sidebar"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              viewBox="0 0 24 24"
              aria-hidden
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m9 6 6 6-6 6" />
            </svg>
          </button>
        )}

        <div className="lg:hidden flex items-center gap-2 shrink-0 min-w-0">
          {renderAppMark({
            size: 'sm',
            imgClassName:
              'w-8 h-8 rounded-xl object-contain border border-zinc-200 bg-white',
          })}
          <span className="font-semibold text-sm text-zinc-900 truncate hidden xs:inline sm:inline">
            {appDisplayName()}
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
                  {headerSearchResults.map((lead, leadIdx) => {
                    const stage = normalizePipelineStage(lead.category);
                    return (
                      <button
                        key={`search-${lead.supabaseId || lead.id}-${leadIdx}`}
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
          <div className="mx-auto mb-8 flex justify-center">
            {renderAppMark({
              size: 'xl',
              imgClassName:
                'w-20 h-20 rounded-3xl object-contain border border-zinc-200 bg-white',
            })}
          </div>

          <div className="font-bold text-5xl tracking-tighter text-zinc-900 mb-1">
            {appDisplayName()}
          </div>
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
      {(systemDocWorkspace === 'mitigation' ||
        systemDocWorkspace === 'mitigation_personal' ||
        systemDocWorkspace === 'mitigation_company') && (
        <div className={documentWorkspaceClass}>
          <div className="page-shell !py-8 sm:!py-10">
            {/* Header — single exit */}
            <div className="mb-6">
              <button
                type="button"
                className="text-sm text-zinc-500 hover:text-zinc-800 mb-4"
                onClick={() => exitLeadDocumentWorkspace()}
              >
                ← Back to lead
              </button>
              <h1 className="text-3xl font-semibold text-zinc-900 tracking-tight">
                Mitigation invoice
              </h1>
              {mitigationWorkspace === 'internal' ? (
                <p className="text-sm text-zinc-500 mt-1">
                  Internal financials & buffer
                </p>
              ) : null}
            </div>

            {mitigationDraft && !showMitigationPreview && (
              <div className="inline-flex p-1 rounded-full bg-zinc-100 mb-6">
                <button
                  type="button"
                  onClick={() => setMitigationWorkspace('invoice')}
                  className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-colors ${
                    mitigationWorkspace === 'invoice'
                      ? 'bg-white text-zinc-900 shadow-sm'
                      : 'text-zinc-500 hover:text-zinc-800'
                  }`}
                >
                  Invoice
                </button>
                <button
                  type="button"
                  onClick={() => setMitigationWorkspace('internal')}
                  className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-colors ${
                    mitigationWorkspace === 'internal'
                      ? 'bg-white text-zinc-900 shadow-sm'
                      : 'text-zinc-500 hover:text-zinc-800'
                  }`}
                >
                  Internal
                </button>
              </div>
            )}

            {!mitigationDraft ? (
              <div className="text-base text-zinc-500">Loading…</div>
            ) : mitigationWorkspace === 'internal' ? (
              <div className="space-y-6 pb-16 w-full">
                <div className="bg-white rounded-3xl p-6 border border-zinc-200">
                  <div className="font-semibold text-xl mb-6 text-zinc-900">
                    Job financials
                  </div>
                  <div className="mb-6">
                    <div className="text-sm text-zinc-500">Total invoice (sell)</div>
                    <div className="text-4xl font-semibold tabular-nums text-emerald-700">
                      $
                      {mitigationListSell.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </div>
                    <p className="text-xs text-zinc-400 mt-1">
                      List sell from invoice lines · negotiate below if needed
                    </p>
                  </div>
                  <div className="space-y-4">
                    <div
                      onClick={() =>
                        setShowMitigationCostBreakdown(!showMitigationCostBreakdown)
                      }
                      className="flex justify-between items-center cursor-pointer hover:bg-zinc-100 p-2 rounded-2xl -mx-2 text-zinc-900"
                    >
                      <div>Material cost</div>
                      <div className="font-semibold text-red-600">
                        -$
                        {mitigationCostTotal.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </div>
                    </div>
                    <div className="flex justify-between items-center text-zinc-900 px-2 -mx-2">
                      <div className="font-semibold">Margin</div>
                      <div className="font-semibold text-emerald-700 tabular-nums">
                        $
                        {mitigationMargin.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-zinc-500 mt-4">
                    Labor is included in the sell price. Only materials (tarps,
                    battens, sandbags) count as cost — everything else is $0
                    on the cost sheet.
                  </p>
                  {showMitigationCostBreakdown && (
                    <div className="mt-6 bg-zinc-100 rounded-3xl p-6 text-sm text-zinc-900">
                      <div className="font-semibold mb-4">Cost breakdown</div>
                      {(mitigationDraft.lines || []).length === 0 ? (
                        <div className="text-zinc-500">
                          No line items yet — add them on Invoice.
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {(mitigationDraft.lines || []).map((ln) => {
                            const unitKey = mitigationCostKeyForLine(ln);
                            const unitCost = mitigationCostForKey(unitKey);
                            const lineCost = mitigationLineCost(ln);
                            const money = (n: number) =>
                              n.toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              });
                            return (
                              <div
                                key={ln.id}
                                className="flex justify-between gap-3 items-start"
                              >
                                <span className="min-w-0">
                                  <span className="font-medium">
                                    {formatMitigationLineDescription(ln)}
                                  </span>
                                  <span className="block text-xs text-zinc-500">
                                    qty {ln.qty}
                                    {unitCost != null
                                      ? ` · $${money(unitCost)} cost ea`
                                      : ' · no cost on sheet'}
                                  </span>
                                </span>
                                <span className="shrink-0 tabular-nums text-right">
                                  <span className="block text-emerald-700">
                                    sell ${money(Number(ln.amount || 0))}
                                  </span>
                                  <span className="block text-red-600">
                                    {lineCost == null
                                      ? 'cost —'
                                      : `cost $${money(lineCost)}`}
                                  </span>
                                </span>
                              </div>
                            );
                          })}
                          <div className="pt-3 border-t border-zinc-200 flex justify-between font-semibold">
                            <span>Total material cost</span>
                            <span className="text-red-600">
                              $
                              {mitigationCostTotal.toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </span>
                          </div>
                          <div className="flex justify-between font-semibold">
                            <span>Margin</span>
                            <span className="text-emerald-700">
                              $
                              {mitigationMargin.toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="bg-white rounded-3xl p-6 border border-zinc-200">
                  <div className="font-semibold text-xl mb-6 text-zinc-900">
                    Your margin
                  </div>
                  <div className="bg-emerald-50/60 border border-emerald-100 rounded-3xl p-6 mb-4">
                    <div className="text-sm text-zinc-500 mb-1">
                      Negotiated sell − material cost
                    </div>
                    <div className="text-4xl font-semibold text-emerald-700 tabular-nums">
                      $
                      {mitigationMargin.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </div>
                    <div className="text-xs text-zinc-500 mt-1">
                      Labor is included · list sell $
                      {mitigationListSell.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                      {mitigationBufferUsed > 0
                        ? ` · discount $${mitigationBufferUsed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : ''}
                    </div>
                  </div>
                </div>

                {/* Negotiation buffer — twin of estimate, starts at list sell */}
                <div className="bg-white rounded-3xl p-6 border border-amber-200/80 shadow-sm ring-1 ring-amber-100/80">
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-2">
                    <div className="font-semibold text-xl text-zinc-900">
                      Negotiation buffer
                    </div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-amber-800 bg-amber-50 border border-amber-100 px-2.5 py-1 rounded-full w-fit">
                      ${MITIGATION_BUFFER_CAP.toLocaleString()} discount room
                    </div>
                  </div>
                  <p className="text-sm text-zinc-500 mb-5">
                    Starts at list sell price. Lower it in the field for a small
                    discount — costs stay internal.
                  </p>

                  <div className="mb-5">
                    <div className="flex justify-between text-xs font-medium text-zinc-500 mb-1.5">
                      <span>Buffer used</span>
                      <span>
                        $
                        {mitigationBufferUsed.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}{' '}
                        of ${MITIGATION_BUFFER_CAP.toLocaleString()}
                      </span>
                    </div>
                    <div className="h-3 rounded-full bg-zinc-100 overflow-hidden flex">
                      <div
                        className="h-full bg-amber-500 transition-all duration-300"
                        style={{ width: `${mitigationBufferUsedPct}%` }}
                      />
                      <div
                        className="h-full bg-emerald-500/80 transition-all duration-300"
                        style={{
                          width: `${100 - mitigationBufferUsedPct}%`,
                        }}
                      />
                    </div>
                    <div className="flex justify-between text-[11px] mt-1.5">
                      <span className="text-amber-700 font-medium">
                        Used $
                        {mitigationBufferUsed.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                      <span className="text-emerald-700 font-medium">
                        Left $
                        {mitigationBufferRemaining.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                    </div>
                  </div>

                  <div className="mb-4">
                    <div className="text-sm text-zinc-500 mb-1">
                      Negotiated / final price
                    </div>
                    <input
                      type="number"
                      value={
                        mitigationDraft.negotiatedTotal != null
                          ? mitigationDraft.negotiatedTotal
                          : mitigationListSell
                      }
                      onChange={(e) =>
                        setMitigationDraft({
                          ...mitigationDraft,
                          negotiatedTotal: Number(e.target.value),
                        })
                      }
                      className="text-4xl font-semibold w-full border border-zinc-200 rounded-2xl px-4 py-3 text-zinc-900 focus:outline-none focus:border-amber-300 focus:ring-2 focus:ring-amber-100"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={applyMitigationNegotiatedTotal}
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
                        $
                        {mitigationBufferUsed.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </div>
                    </div>
                    <div className="rounded-2xl bg-emerald-50 border border-emerald-100 p-4">
                      <div className="text-xs font-medium text-emerald-800/80 uppercase tracking-wide">
                        Remaining
                      </div>
                      <div className="text-3xl font-semibold text-emerald-700 tabular-nums mt-1">
                        $
                        {mitigationBufferRemaining.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-zinc-500 mt-5">
                    Invoice PDF and saved total use the negotiated price. Costs never
                    appear on the customer PDF.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setMitigationWorkspace('invoice')}
                  className="w-full py-3 rounded-2xl text-sm font-semibold border border-zinc-200 text-zinc-800 hover:bg-zinc-50"
                >
                  ← Back to invoice
                </button>
              </div>
            ) : showMitigationPreview ? (
              <div className="bg-white p-5 sm:p-8 text-zinc-900 pb-16 rounded-3xl border border-zinc-200/80 shadow-sm">
                <div className="flex justify-between items-center mb-8 gap-3">
                  <button
                    type="button"
                    onClick={() => setShowMitigationPreview(false)}
                    className="px-6 py-2 border border-zinc-300 rounded-2xl text-sm hover:bg-zinc-100"
                  >
                    ← Back to invoice
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      generateMitigationPdf({ download: true, save: false })
                    }
                    className="btn-primary px-6 sm:px-8 py-3 rounded-3xl font-semibold"
                  >
                    Download PDF
                  </button>
                </div>

                <div className="text-center mb-8">
                  <div className="font-bold text-3xl tracking-tight">
                    {mitigationBillingBrand(mitigationDraft.entity)}
                  </div>
                  <div className="text-sm text-zinc-400 mt-1">
                    {mitigationInvoiceTitle(mitigationDraft.entity)} ·{' '}
                    {mitigationDraft.date}
                  </div>
                  {mitigationDraft.entity === 'prowest' &&
                    !companySettingsConfigured() && (
                      <div className="text-xs text-amber-700 mt-2">
                        Company details empty — add them in Settings
                      </div>
                    )}
                </div>

                <div className="border border-zinc-200 rounded-3xl p-6 sm:p-10 space-y-6">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                    <div>
                      <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1">
                        Invoice for
                      </div>
                      <div className="font-medium text-zinc-900">
                        {mitigationDraft.invoiceFor || '—'}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1">
                        Payable to
                      </div>
                      <div className="font-medium text-zinc-900">
                        {mitigationPayableTo(mitigationDraft.entity)}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1">
                        Location
                      </div>
                      <div className="text-zinc-900">
                        {mitigationDraft.location || '—'}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1">
                        Job / claim
                      </div>
                      <div className="text-zinc-900">
                        Job {mitigationDraft.job || '—'}
                        {mitigationDraft.claimNumber
                          ? ` · Claim ${mitigationDraft.claimNumber}`
                          : ''}
                      </div>
                    </div>
                  </div>

                  {showCompanyPmOnDoc(mitigationDraft.entity) ? (
                    <div className="rounded-2xl border border-zinc-200 bg-zinc-50/80 px-5 py-4">
                      <div className="font-semibold text-sm text-zinc-900 mb-2">
                        Your Project Manager
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-1.5 text-sm">
                        <div>
                          <span className="font-medium text-zinc-900">
                            {estimatePmName() || '—'}
                          </span>
                        </div>
                        <div>
                          <span className="text-zinc-500">Phone:</span>{' '}
                          {estimatePmPhone() || '—'}
                        </div>
                        {(companySettings.projectManagerEmail || '').trim() ? (
                          <div className="sm:col-span-2">
                            <span className="text-zinc-500">Email:</span>{' '}
                            {(companySettings.projectManagerEmail || '').trim()}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  <div>
                    <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-3">
                      Line items
                    </div>
                    <div className="space-y-2">
                      {(mitigationDraft.lines || []).length === 0 ? (
                        <div className="text-sm text-zinc-400">No line items</div>
                      ) : (
                        (mitigationDraft.lines || []).map((ln) => (
                          <div
                            key={ln.id}
                            className="flex justify-between gap-4 text-sm items-start"
                          >
                            <div className="min-w-0">
                              {formatMitigationLineDescription(ln)}
                            </div>
                            <div className="shrink-0 tabular-nums font-medium text-emerald-700">
                              $
                              {Number(ln.amount || 0).toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {mitigationDraft.notes.trim() && (
                    <div className="rounded-2xl border border-zinc-200 bg-zinc-50/80 px-5 py-4">
                      <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">
                        Notes
                      </div>
                      <div className="text-sm whitespace-pre-wrap text-zinc-800">
                        {mitigationDraft.notes}
                      </div>
                    </div>
                  )}

                  <div className="pt-6 border-t border-zinc-200">
                    {mitigationBufferUsed > 0 && (
                      <div className="flex justify-between text-sm text-amber-700 mb-2">
                        <span>Special discount</span>
                        <span className="tabular-nums">
                          −$
                          {mitigationBufferUsed.toLocaleString(undefined, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </span>
                      </div>
                    )}
                    <div className="flex justify-between items-center text-2xl font-semibold text-zinc-900">
                      <span>Total amount due</span>
                      <span className="tabular-nums text-emerald-700">
                        $
                        {mitigationNegotiated.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="mt-10 space-y-3">
                  <button
                    type="button"
                    onClick={() => {
                      generateMitigationPdf({ download: false, save: true });
                      setShowMitigationPreview(false);
                    }}
                    className="btn-primary w-full py-4 rounded-3xl font-semibold text-lg"
                  >
                    Save invoice PDF to lead
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      // Keep mitigation draft; seed agreement from invoice lines/total
                      openEmergencyAgreement(currentLeadId);
                      showToast(
                        'Agreement prefilled from invoice — save invoice PDF and agreement as separate files'
                      );
                    }}
                    className="w-full py-4 rounded-3xl font-semibold text-lg border-2 border-sky-500 text-sky-800 bg-sky-50 hover:bg-sky-100"
                  >
                    Continue to agreement →
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                {/* BILLING ENTITY */}
                <div className="bg-white border border-zinc-200/80 rounded-3xl p-5 sm:p-6 shadow-sm">
                  <div className="text-xs font-semibold text-zinc-500 mb-3 tracking-wider uppercase">
                    Billing Entity
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setMitigationDraft({
                          ...mitigationDraft,
                          entity: 'roslie',
                        });
                        setSystemDocWorkspace('mitigation');
                      }}
                      className={`text-left rounded-2xl border-2 p-4 transition-all ${
                        mitigationDraft.entity === 'roslie'
                          ? 'border-sky-500 bg-sky-50 shadow-sm'
                          : 'border-zinc-200 hover:border-zinc-300 bg-white'
                      }`}
                    >
                      <div className="font-semibold text-zinc-900 text-base">
                        Personal
                      </div>
                      <div className="text-sm text-zinc-500 mt-1">
                        Billed through personal LLC
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMitigationDraft({
                          ...mitigationDraft,
                          entity: 'prowest',
                        });
                        setSystemDocWorkspace('mitigation');
                      }}
                      className={`text-left rounded-2xl border-2 p-4 transition-all ${
                        mitigationDraft.entity === 'prowest'
                          ? 'border-sky-500 bg-sky-50 shadow-sm'
                          : 'border-zinc-200 hover:border-zinc-300 bg-white'
                      }`}
                    >
                      <div className="font-semibold text-zinc-900 text-base">
                        Company
                      </div>
                      <div className="text-sm text-zinc-500 mt-1">
                        Billed through companies LLC
                      </div>
                    </button>
                  </div>
                  {mitigationDraft.entity === 'prowest' ? (
                    <div className="mt-4 rounded-2xl border border-dashed border-zinc-200 bg-zinc-50/80 px-4 py-3">
                      <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1">
                        Company (from Settings)
                      </div>
                      {companySettingsConfigured() ? (
                        <div className="text-sm text-zinc-800 space-y-0.5">
                          <div className="font-medium">
                            {companyBrandName() || '—'}
                          </div>
                          {(companySettings.address || '').trim() ? (
                            <div className="text-zinc-500">
                              {companySettings.address}
                            </div>
                          ) : null}
                          <div className="text-zinc-500">
                            {companyContactLine() || '—'}
                          </div>
                          {showCompanyPmOnDoc('prowest') ? (
                            <div className="text-zinc-600 pt-1">
                              PM:{' '}
                              {[
                                estimatePmName(),
                                estimatePmPhone(),
                                (companySettings.projectManagerEmail || '').trim(),
                              ]
                                .filter(Boolean)
                                .join(' · ') || '—'}
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <div className="text-sm text-zinc-500">
                          Add company details in Settings → Company
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>

                {/* PRICING */}
                <div className="bg-white border border-zinc-200/80 rounded-3xl p-5 sm:p-6 shadow-sm">
                  <div className="text-xs font-semibold text-zinc-500 mb-3 tracking-wider uppercase">
                    Pricing
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setMitigationRateMode('insurance')}
                      className={`text-left rounded-2xl border-2 p-4 transition-all ${
                        mitigationDraft.rateMode === 'insurance'
                          ? 'border-sky-500 bg-sky-50 shadow-sm'
                          : 'border-zinc-200 hover:border-zinc-300 bg-white'
                      }`}
                    >
                      <div className="font-semibold text-zinc-900 text-base">
                        Insurance rates
                      </div>
                      <div className="text-sm text-zinc-500 mt-1">
                        Billed to insurance carrier
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setMitigationRateMode('cash')}
                      className={`text-left rounded-2xl border-2 p-4 transition-all ${
                        mitigationDraft.rateMode === 'cash'
                          ? 'border-sky-500 bg-sky-50 shadow-sm'
                          : 'border-zinc-200 hover:border-zinc-300 bg-white'
                      }`}
                    >
                      <div className="font-semibold text-zinc-900 text-base">
                        Retail rates
                      </div>
                      <div className="text-sm text-zinc-500 mt-1">
                        Cash pricing
                      </div>
                    </button>
                  </div>
                </div>

                {/* JOB DETAILS */}
                <div className="bg-white border border-zinc-200/80 rounded-3xl p-5 sm:p-6 shadow-sm space-y-4">
                  <div className="text-xs font-semibold text-zinc-500 tracking-wider uppercase">
                    Job Details
                  </div>
                  <div>
                    <label className="text-sm text-zinc-600">Invoice for</label>
                    <input
                      className="mt-1.5 w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base text-zinc-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                      value={mitigationDraft.invoiceFor}
                      onChange={(e) =>
                        setMitigationDraft({
                          ...mitigationDraft,
                          invoiceFor: e.target.value,
                        })
                      }
                    />
                  </div>
                  <div>
                    <label className="text-sm text-zinc-600">Location</label>
                    <input
                      className="mt-1.5 w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base text-zinc-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                      value={mitigationDraft.location}
                      onChange={(e) =>
                        setMitigationDraft({
                          ...mitigationDraft,
                          location: e.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label className="text-sm text-zinc-600">Job #</label>
                      <input
                        className="mt-1.5 w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base text-zinc-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                        value={mitigationDraft.job}
                        onChange={(e) =>
                          setMitigationDraft({
                            ...mitigationDraft,
                            job: e.target.value,
                          })
                        }
                      />
                    </div>
                    <div>
                      <label className="text-sm text-zinc-600">Claim number</label>
                      <input
                        className="mt-1.5 w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base text-zinc-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                        value={mitigationDraft.claimNumber}
                        onChange={(e) =>
                          setMitigationDraft({
                            ...mitigationDraft,
                            claimNumber: e.target.value,
                          })
                        }
                      />
                    </div>
                  </div>
                </div>

                {/* LINE ITEMS */}
     

                  
           <div className="bg-white border border-zinc-200/80 rounded-3xl p-5 sm:p-6 shadow-sm">
                  <div className="text-xs font-semibold text-zinc-500 tracking-wider uppercase mb-3">
                    Line items
                  </div>

                  {/* Add tarp — each tarp is its own job with installs underneath */}
                  {(() => {
                    const group = MITIGATION_LINE_GROUPS.find(
                      (g) => g.group === 'Tarps'
                    );
                    if (!group) return null;
                    return (
                      <div className="space-y-1.5 mb-5">
                        <div className="text-xs font-semibold text-zinc-500 tracking-wider uppercase">
                          Add tarp
                        </div>
                        <MitigationTarpAddRow
                          items={group.items}
                          onAdd={(itemKey, label, tarpType) =>
                            addMitigationCatalogLine(itemKey, label, tarpType)
                          }
                        />
                      </div>
                    );
                  })()}

                  {/* Tarp groups */}
                  <div className="space-y-4 mb-6">
                    {(() => {
                      const lines = mitigationDraft.lines || [];
                      const groupIds: string[] = [];
                      for (const ln of lines) {
                        if (ln.groupId && !groupIds.includes(ln.groupId)) {
                          groupIds.push(ln.groupId);
                        }
                      }
                      const installGroup = MITIGATION_LINE_GROUPS.find(
                        (g) => g.group === 'Install'
                      );
                      if (groupIds.length === 0) {
                        return (
                          <div className="text-base text-zinc-400 py-8 text-center border border-dashed border-zinc-200 rounded-2xl bg-zinc-50/50">
                            Add a tarp to start — then attach installs to that
                            tarp
                          </div>
                        );
                      }
                      return groupIds.map((gid) => {
                        const inGroup = lines.filter((l) => l.groupId === gid);
                        const tarpLine = inGroup.find((l) =>
                          l.itemKey.startsWith('tarp_')
                        );
                        const childLines = inGroup.filter(
                          (l) => !l.itemKey.startsWith('tarp_')
                        );
                        const label =
                          tarpLine?.groupLabel ||
                          inGroup.find((l) => l.groupLabel)?.groupLabel ||
                          'Tarp';
                        const isActive = activeTarpGroupId === gid;
                        return (
                          <div
                            key={gid}
                            className={`rounded-2xl border p-4 space-y-3 ${
                              isActive
                                ? 'border-sky-400 bg-sky-50/40'
                                : 'border-zinc-200 bg-zinc-50/40'
                            }`}
                            onClick={() => setActiveTarpGroupId(gid)}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                                {label}
                                {isActive ? (
                                  <span className="ml-2 text-sky-700 normal-case tracking-normal font-medium">
                                    · adding here
                                  </span>
                                ) : null}
                              </div>
                              <button
                                type="button"
                                className="text-xs text-zinc-500 hover:text-red-500/90"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeMitigationTarpGroup(gid);
                                }}
                              >
                                Remove tarp
                              </button>
                            </div>

                            {tarpLine && (
                              <div className="flex flex-wrap items-center gap-3 text-base bg-white rounded-2xl px-4 py-3 border border-zinc-100">
                                <div className="flex-1 min-w-[8rem] font-medium text-zinc-900">
                                  {formatMitigationLineDescription(tarpLine)}
                                </div>
                                <div className="w-24 text-right tabular-nums font-medium text-emerald-700">
                                  $
                                  {Number(tarpLine.amount || 0).toLocaleString(
                                    undefined,
                                    {
                                      minimumFractionDigits: 2,
                                      maximumFractionDigits: 2,
                                    }
                                  )}
                                </div>
                              </div>
                            )}

                            {installGroup && (
                              <div
                                className="space-y-1.5"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <div className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
                                  Install on this tarp
                                </div>
                                <MitigationGroupAddRow
                                  items={installGroup.items}
                                  onAdd={(itemKey, itemLabel) => {
                                    addMitigationCatalogLine(
                                      itemKey,
                                      itemLabel,
                                      null,
                                      { groupId: gid }
                                    );
                                  }}
                                />
                              </div>
                            )}

                            {childLines.map((ln) => (
                              <div
                                key={ln.id}
                                className="flex flex-wrap items-center gap-3 text-sm bg-white rounded-2xl px-4 py-2.5 border border-zinc-100"
                              >
                                <div className="flex-1 min-w-[8rem] font-medium text-zinc-900">
                                  {formatMitigationLineDescription(ln)}
                                </div>
                                <input
                                  type="number"
                                  className="w-16 border border-zinc-200 rounded-xl px-2 py-1.5 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                                  value={ln.qty}
                                  title={
                                    ln.itemKey === 'hip_install'
                                      ? 'Number of hips'
                                      : 'Qty'
                                  }
                                  onFocus={(e) => e.target.select()}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) =>
                                    updateMitigationLineQty(
                                      ln.id,
                                      parseFloat(e.target.value) || 0
                                    )
                                  }
                                />
                                <div className="w-20 text-right tabular-nums font-medium text-emerald-700">
                                  $
                                  {Number(ln.amount || 0).toLocaleString(
                                    undefined,
                                    {
                                      minimumFractionDigits: 2,
                                      maximumFractionDigits: 2,
                                    }
                                  )}
                                </div>
                                <button
                                  type="button"
                                  className="text-xs text-zinc-500 hover:text-red-500/90 shrink-0"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    removeMitigationLine(ln.id);
                                  }}
                                >
                                  Remove
                                </button>
                              </div>
                            ))}
                          </div>
                        );
                      });
                    })()}
                  </div>

                  {/* House-level: Trip | Adders | Obstruction */}
                  <div className="space-y-4 mb-4">
                    <div className="text-xs font-semibold text-zinc-500 tracking-wider uppercase">
                      House-level charges
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
                      {(['Trip charges', 'Adders', 'Obstruction'] as const).map(
                        (name) => {
                          const group = MITIGATION_LINE_GROUPS.find(
                            (g) => g.group === name
                          );
                          if (!group) return null;
                          return (
                            <div key={name} className="space-y-1.5 min-w-0">
                              <div className="text-xs font-semibold text-zinc-500 tracking-wider uppercase">
                                {group.group}
                              </div>
                              <MitigationGroupAddRow
                                items={group.items}
                                onAdd={(itemKey, label) =>
                                  addMitigationCatalogLine(itemKey, label)
                                }
                              />
                            </div>
                          );
                        }
                      )}
                    </div>
                  </div>

                  {/* House-level line list */}
                  <div className="space-y-2">
                    {(mitigationDraft.lines || [])
                      .filter((ln) => !ln.groupId)
                      .map((ln) => (
                        <div
                          key={ln.id}
                          className="flex flex-wrap items-center gap-3 text-base bg-zinc-50 rounded-2xl px-4 py-3 border border-zinc-100"
                        >
                          <div className="flex-1 min-w-[8rem] font-medium text-zinc-900">
                            {formatMitigationLineDescription(ln)}
                          </div>
                          <input
                            type="number"
                            className="w-20 border border-zinc-200 rounded-xl px-3 py-2 bg-white text-base focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                            value={ln.qty}
                            onFocus={(e) => e.target.select()}
                            onChange={(e) =>
                              updateMitigationLineQty(
                                ln.id,
                                parseFloat(e.target.value) || 0
                              )
                            }
                          />
                          <div className="w-24 text-right tabular-nums font-medium text-emerald-700">
                            $
                            {Number(ln.amount || 0).toLocaleString(undefined, {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                          </div>
                          <button
                            type="button"
                            className="text-xs text-zinc-500 hover:text-red-500/90 shrink-0 px-2 py-1"
                            onClick={() => removeMitigationLine(ln.id)}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                  </div>
                </div>

                {/* TOTAL + SEE INVOICE */}
                <div className="sticky bottom-0 bg-white/95 backdrop-blur border-t border-zinc-200 py-4 z-40 -mx-[var(--page-pad-x)] px-[var(--page-pad-x)]">
                  <div className="w-full max-w-6xl mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs text-zinc-500">TOTAL AMOUNT DUE</div>
                      <div className="text-4xl sm:text-5xl font-semibold text-emerald-700 tabular-nums">
                        $
                        {mitigationNegotiated.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </div>
                      {mitigationBufferUsed > 0 && (
                        <div className="text-xs text-amber-700 mt-0.5">
                          List $
                          {mitigationListSell.toLocaleString(undefined, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}{' '}
                          · discount $
                          {mitigationBufferUsed.toLocaleString(undefined, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowMitigationPreview(true)}
                      className="btn-primary px-8 py-4 rounded-3xl font-semibold w-full sm:w-auto sm:shrink-0"
                    >
                      See Invoice
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

      )}


      {toastMessage && (
        <div className="fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 z-[80] px-6 py-3 bg-zinc-900/95 text-white rounded-2xl shadow-md ring-1 ring-white/10 text-sm font-medium">
          {toastMessage}
        </div>
      )}
      {calEventModal && (() => {
        const editing =
          calEventModal.mode === 'edit' && calEventModal.eventId
            ? calendarEvents.find((e) => e.id === calEventModal.eventId)
            : null;
        const q = calEventDraft.leadSearch.trim().toLowerCase();
        const leadChoices = leads
          .filter((l) => normalizePipelineStage(l.category) !== 'Closed')
          .filter((l) => {
            if (!q) return true;
            const name = leadDisplayFromParts(
              l.clientFirstName,
              l.clientLastName
            ).toLowerCase();
            const job = (l.jobNumber || '').toLowerCase();
            const addr = (l.clientAddress || '').toLowerCase();
            return (
              name.includes(q) || job.includes(q) || addr.includes(q)
            );
          })
          .slice(0, 8);
        const linkedLead =
          calEventDraft.leadId != null
            ? leads.find((l) => l.id === calEventDraft.leadId)
            : null;
        const linkedLabel = linkedLead
          ? leadDisplayFromParts(
              linkedLead.clientFirstName,
              linkedLead.clientLastName
            ) || `Lead #${linkedLead.id}`
          : editing?.leadName ||
            (calEventDraft.leadId != null
              ? `Lead #${calEventDraft.leadId}`
              : '');
        return (
          <div className="fixed inset-0 z-[95] bg-black/40 flex items-end sm:items-center justify-center p-4">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="cal-event-title"
              className="bg-white rounded-3xl w-full max-w-lg shadow-lg border border-zinc-200 overflow-hidden max-h-[min(92vh,720px)] flex flex-col"
            >
              <div className="p-5 sm:p-6 border-b border-zinc-100">
                <h2
                  id="cal-event-title"
                  className="text-lg font-semibold text-zinc-900"
                >
                  {calEventModal.mode === 'create' ? 'Create event' : 'Event'}
                </h2>
                <p className="text-sm text-zinc-500 mt-1">
                  Title, time, optional notes — link a lead if you want.
                </p>
              </div>
              <div className="p-5 sm:p-6 space-y-4 overflow-y-auto flex-1">
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                    Title
                  </span>
                  <input
                    type="text"
                    value={calEventDraft.title}
                    onChange={(e) =>
                      setCalEventDraft((d) => ({ ...d, title: e.target.value }))
                    }
                    placeholder="Add title"
                    autoFocus
                    className="w-full rounded-2xl border border-zinc-200 px-3 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-sky-300"
                  />
                </label>
                <label className="flex items-center gap-2 text-sm text-zinc-800">
                  <input
                    type="checkbox"
                    checked={calEventDraft.allDay}
                    onChange={(e) =>
                      setCalEventDraft((d) => ({
                        ...d,
                        allDay: e.target.checked,
                      }))
                    }
                    className="rounded border-zinc-300"
                  />
                  All day
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                      Date
                    </span>
                    <input
                      type="date"
                      value={calEventDraft.startDate}
                      onChange={(e) =>
                        setCalEventDraft((d) => ({
                          ...d,
                          startDate: e.target.value,
                          endDate:
                            d.endDate < e.target.value
                              ? e.target.value
                              : d.endDate,
                        }))
                      }
                      className="w-full rounded-2xl border border-zinc-200 px-3 py-2.5 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-sky-300"
                    />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                      End date
                    </span>
                    <input
                      type="date"
                      value={calEventDraft.endDate}
                      onChange={(e) =>
                        setCalEventDraft((d) => ({
                          ...d,
                          endDate: e.target.value,
                        }))
                      }
                      className="w-full rounded-2xl border border-zinc-200 px-3 py-2.5 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-sky-300"
                    />
                  </label>
                </div>
                {!calEventDraft.allDay ? (
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                        Start
                      </span>
                      <input
                        type="time"
                        value={calEventDraft.startTime}
                        onChange={(e) =>
                          setCalEventDraft((d) => ({
                            ...d,
                            startTime: e.target.value,
                            endTime:
                              d.endTime <= e.target.value
                                ? defaultEndTime(e.target.value)
                                : d.endTime,
                          }))
                        }
                        className="w-full rounded-2xl border border-zinc-200 px-3 py-2.5 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-sky-300"
                      />
                    </label>
                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                        End
                      </span>
                      <input
                        type="time"
                        value={calEventDraft.endTime}
                        onChange={(e) =>
                          setCalEventDraft((d) => ({
                            ...d,
                            endTime: e.target.value,
                          }))
                        }
                        className="w-full rounded-2xl border border-zinc-200 px-3 py-2.5 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-sky-300"
                      />
                    </label>
                  </div>
                ) : null}
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                    Notes
                  </span>
                  <textarea
                    value={calEventDraft.notes}
                    onChange={(e) =>
                      setCalEventDraft((d) => ({ ...d, notes: e.target.value }))
                    }
                    rows={3}
                    placeholder="Add description"
                    className="w-full rounded-2xl border border-zinc-200 px-3 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-sky-300 resize-none"
                  />
                </label>
                {googleCalendarList.length > 0 ? (
                  <label className="block space-y-1.5">
                    <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                      Calendar
                    </span>
                    <select
                      value={calEventDraft.calendarId || 'primary'}
                      onChange={(e) =>
                        setCalEventDraft((d) => ({
                          ...d,
                          calendarId: e.target.value,
                        }))
                      }
                      className="w-full rounded-2xl border border-zinc-200 px-3 py-2.5 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-sky-300 bg-white"
                    >
                      {googleCalendarList.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.summary}
                          {c.primary ? ' (primary)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <div className="space-y-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                    Color
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      title="Calendar default"
                      aria-label="Calendar default color"
                      onClick={() =>
                        setCalEventDraft((d) => ({
                          ...d,
                          colorId: undefined,
                        }))
                      }
                      className={`h-7 w-7 rounded-full border-2 ${
                        !calEventDraft.colorId
                          ? 'border-zinc-900 ring-2 ring-zinc-900/20'
                          : 'border-white shadow-sm'
                      }`}
                      style={{
                        backgroundColor: (() => {
                          const id = calEventDraft.calendarId || 'primary';
                          const fromMap =
                            googleCalendarColorMap[id] ||
                            googleCalendarColorMap.primary;
                          if (fromMap?.bg) return fromMap.bg;
                          const fromList = googleCalendarList.find(
                            (c) => c.id === id
                          );
                          return (
                            fromList?.backgroundColor ||
                            GOOGLE_CALENDAR_DEFAULT_COLOR.solid
                          );
                        })(),
                      }}
                    />
                    {GOOGLE_EVENT_COLORS.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        title={c.name}
                        aria-label={`Color ${c.name}`}
                        onClick={() =>
                          setCalEventDraft((d) => ({
                            ...d,
                            colorId: c.id,
                          }))
                        }
                        className={`h-7 w-7 rounded-full border-2 ${
                          calEventDraft.colorId === c.id
                            ? 'border-zinc-900 ring-2 ring-zinc-900/20'
                            : 'border-white shadow-sm'
                        }`}
                        style={{ backgroundColor: c.solid }}
                      />
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                    Link lead
                  </div>
                  {calEventDraft.leadId != null ? (
                    <div className="flex items-center justify-between gap-2 rounded-2xl border border-sky-200 bg-sky-50/50 px-3 py-2.5">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-zinc-900 truncate">
                          {linkedLabel}
                        </div>
                        <div className="text-xs text-zinc-500">Linked lead</div>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            const id = calEventDraft.leadId!;
                            setCalEventModal(null);
                            openLeadProfile(id);
                          }}
                          className="px-3 py-1.5 text-xs font-semibold rounded-lg btn-primary"
                        >
                          Open lead
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setCalEventDraft((d) => ({
                              ...d,
                              leadId: null,
                              leadSearch: '',
                            }))
                          }
                          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-zinc-200 text-zinc-700 hover:bg-white"
                        >
                          Unlink
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <input
                        type="search"
                        value={calEventDraft.leadSearch}
                        onChange={(e) =>
                          setCalEventDraft((d) => ({
                            ...d,
                            leadSearch: e.target.value,
                          }))
                        }
                        placeholder="Search leads…"
                        className="w-full rounded-2xl border border-zinc-200 px-3 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-sky-300"
                      />
                      <div className="max-h-36 overflow-y-auto space-y-1">
                        {leadChoices.map((lead) => {
                          const name =
                            leadDisplayFromParts(
                              lead.clientFirstName,
                              lead.clientLastName
                            ) || 'Untitled';
                          return (
                            <button
                              key={`link-${lead.id}`}
                              type="button"
                              onClick={() =>
                                setCalEventDraft((d) => ({
                                  ...d,
                                  leadId: lead.id,
                                  leadSearch: '',
                                }))
                              }
                              className="w-full text-left px-3 py-2 rounded-xl text-sm hover:bg-zinc-50 border border-transparent hover:border-zinc-200"
                            >
                              <span className="font-medium text-zinc-900">
                                {name}
                              </span>
                              {lead.jobNumber ? (
                                <span className="text-zinc-400">
                                  {' '}
                                  · #{lead.jobNumber}
                                </span>
                              ) : null}
                            </button>
                          );
                        })}
                        {leadChoices.length === 0 ? (
                          <p className="text-xs text-zinc-400 px-1 py-2">
                            No matching leads
                          </p>
                        ) : null}
                      </div>
                    </>
                  )}
                </div>
              </div>
              <div className="px-5 sm:px-6 pb-5 sm:pb-6 pt-2 flex flex-col sm:flex-row gap-2 border-t border-zinc-100">
                {calEventModal.mode === 'edit' && calEventModal.eventId ? (
                  <button
                    type="button"
                    disabled={calEventBusy}
                    onClick={() =>
                      void deleteCalendarEvent(calEventModal.eventId!)
                    }
                    className="sm:mr-auto px-4 py-3 rounded-2xl text-sm font-medium text-red-700 border border-red-200 hover:bg-red-50 disabled:opacity-50"
                  >
                    Delete
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setCalEventModal(null)}
                  className="px-4 py-3 rounded-2xl text-sm font-medium border border-zinc-200 text-zinc-700 hover:bg-zinc-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={calEventBusy}
                  onClick={() => void saveCalendarEventDraft()}
                  className="btn-primary px-5 py-3 rounded-2xl text-sm font-semibold disabled:opacity-50"
                >
                  {calEventBusy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
      {pendingLeave && (
        <div className="fixed inset-0 z-[95] bg-black/40 flex items-end sm:items-center justify-center p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="leave-estimate-title"
            className="bg-white rounded-3xl w-full max-w-md shadow-lg border border-zinc-200 overflow-hidden"
          >
            <div className="p-5 sm:p-6">
              <h2
                id="leave-estimate-title"
                className="text-lg font-semibold text-zinc-900"
              >
                Unsaved estimate changes
              </h2>
              <p className="text-sm text-zinc-500 mt-2">
                Save to the lead before leaving, discard changes, or stay and
                keep editing.
              </p>
            </div>
            <div className="px-5 sm:px-6 pb-5 sm:pb-6 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => void confirmPendingLeaveSave()}
                className="btn-primary w-full py-3 rounded-2xl font-semibold text-sm"
              >
                Save & leave
              </button>
              <button
                type="button"
                onClick={confirmPendingLeaveDiscard}
                className="w-full py-3 rounded-2xl font-semibold text-sm border border-zinc-200 text-zinc-700 hover:bg-zinc-50"
              >
                Discard changes
              </button>
              <button
                type="button"
                onClick={() => setPendingLeave(null)}
                className="w-full py-3 rounded-2xl font-medium text-sm text-zinc-500 hover:text-zinc-800"
              >
                Keep editing
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingApplyMeasurement && (
        <div className="fixed inset-0 z-[95] bg-black/40 flex items-end sm:items-center justify-center p-4">
          <div
            role="dialog"
            aria-modal="true"
            className="bg-white rounded-3xl w-full max-w-md shadow-lg border border-zinc-200 overflow-hidden"
          >
            <div className="p-5 sm:p-6">
              <h2 className="text-lg font-semibold text-zinc-900">
                Apply roof measurement?
              </h2>
              <p className="text-sm text-zinc-500 mt-2">
                {pendingApplyMeasurement.name} has a saved measurement
                {pendingApplyMeasurement.measurement.squares
                  ? ` · ${pendingApplyMeasurement.measurement.squares} sq`
                  : ''}
                {pendingApplyMeasurement.measurement.flatSquares
                  ? ` · ${pendingApplyMeasurement.measurement.flatSquares} flat sq`
                  : ''}
                . Apply it to this estimate, or start blank (contact stays).
              </p>
            </div>
            <div className="px-5 sm:px-6 pb-5 sm:pb-6 flex flex-col gap-2">
              <button
                type="button"
                onClick={finishStartEstimateWithMeasurement}
                className="btn-primary w-full py-3 rounded-2xl font-semibold text-sm"
              >
                Apply measurement
              </button>
              <button
                type="button"
                onClick={finishStartEstimateBlank}
                className="w-full py-3 rounded-2xl font-semibold text-sm border border-zinc-200 text-zinc-700 hover:bg-zinc-50"
              >
                Start blank estimate
              </button>
              <button
                type="button"
                onClick={() => setPendingApplyMeasurement(null)}
                className="w-full py-3 rounded-2xl font-medium text-sm text-zinc-500 hover:text-zinc-800"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingTrashPhotoId && (
        <div className="fixed inset-0 z-[95] bg-black/40 flex items-end sm:items-center justify-center p-4">
          <div
            role="dialog"
            aria-modal="true"
            className="bg-white rounded-3xl w-full max-w-md shadow-lg border border-zinc-200 overflow-hidden"
          >
            <div className="p-5 sm:p-6">
              <h2 className="text-lg font-semibold text-zinc-900">
                Move photo to trash?
              </h2>
              <p className="text-sm text-zinc-500 mt-2">
                You can restore it from Trash later. Storage file stays until
                permanent delete.
              </p>
            </div>
            <div className="px-5 sm:px-6 pb-5 sm:pb-6 flex flex-col gap-2">
              <button
                type="button"
                onClick={confirmTrashPhoto}
                className="w-full py-3 rounded-2xl font-semibold text-sm bg-zinc-900 text-white hover:bg-zinc-800"
              >
                Move to trash
              </button>
              <button
                type="button"
                onClick={() => setPendingTrashPhotoId(null)}
                className="w-full py-3 rounded-2xl font-medium text-sm text-zinc-500 hover:text-zinc-800"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {renderAppSidebar()}
      {/* Main column offset for fixed desktop sidebar */}
      <div
        className={`min-h-screen pb-8 flex flex-col transition-[padding] duration-200 ease-out ${
          sidebarCollapsed ? 'lg:pl-[4.25rem]' : 'lg:pl-[15.5rem]'
        }`}
      >
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
                      {invoicePickerMode
                        ? 'New invoice'
                        : estimatePickerMode === 'internal'
                          ? 'Open Internal'
                          : 'New estimate'}
                    </h2>
                    <p className="text-sm text-zinc-500 mt-1">
                      {invoicePickerMode
                        ? 'Choose a lead — contact and job info fill the invoice.'
                        : estimatePickerMode === 'internal'
                          ? 'Choose a lead for cost, commission, and buffer.'
                          : 'Choose a lead — contact info is pulled into the estimate.'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setShowEstimatePicker(false);
                      setInvoicePickerMode(false);
                    }}
                    className="text-sm font-medium text-zinc-500 hover:text-zinc-800 px-2 py-1"
                  >
                    Close
                  </button>
                </div>
                <input
                  value={estimatePickerQuery}
                  onChange={(e) => setEstimatePickerQuery(e.target.value)}
                  placeholder={
                    invoicePickerMode
                      ? 'Search leads…'
                      : 'Search leads or estimates…'
                  }
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
                          setInvoicePickerMode(false);
                          createNewLead();
                        }}
                        className="btn-primary px-5 py-2.5 rounded-2xl text-sm font-semibold"
                      >
                        New lead
                      </button>
                    </div>
                  ) : (
                    <ul className="space-y-1.5">
                      {leadMatches.map((lead, leadIdx) => {
                        const name =
                          [lead.clientFirstName, lead.clientLastName]
                            .filter(Boolean)
                            .join(' ') ||
                          lead.clientAddress ||
                          'Untitled lead';
                        const estCount = lead.estimates?.length || 0;
                        return (
                          <li key={`match-${lead.id}-${leadIdx}`}>
                            <button
                              type="button"
                              onClick={() => {
                                if (invoicePickerMode) {
                                  openMitigationWorkspace('personal', lead.id);
                                  return;
                                }
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
                                    {!invoicePickerMode && estCount > 0
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

                {!invoicePickerMode && (
                <section>
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-2">
                    Estimates
                  </h3>
                  {estimateItems.length === 0 ? (
                    <p className="text-sm text-zinc-400 px-1 py-2">
                      No saved estimates yet
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {estimateItems.map(
                        ({ lead, estimate, leadName, estimateIndex }) => (
                        <li
                          key={`${lead.id}-${estimate.supabaseId || estimate.id}-${estimateIndex}`}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              openLeadEstimate(lead.id, estimate, lead)
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
                      )
                      )}
                    </ul>
                  )}
                </section>
                )}
              </div>

              <div className="px-5 py-3 border-t border-zinc-100 shrink-0 flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowEstimatePicker(false);
                    setInvoicePickerMode(false);
                  }}
                  className="flex-1 py-2.5 rounded-2xl text-sm font-medium border border-zinc-200 text-zinc-700 hover:bg-zinc-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowEstimatePicker(false);
                    setInvoicePickerMode(false);
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
            [
              'Ridge',
              (measurement.ridgeLF || 0) > 0
                ? `${measurement.ridgeLF} LF${
                    measurement.edgesVerified ? '' : ' (unverified)'
                  }`
                : '— (enter after field check)',
            ],
            [
              'Hip',
              (measurement.hipLF || 0) > 0
                ? `${measurement.hipLF} LF`
                : '—',
            ],
            [
              'Valley',
              (measurement.valleyLF ?? 0) > 0
                ? `${measurement.valleyLF} LF`
                : '—',
            ],
            [
              'Eave',
              (measurement.eaveLF || 0) > 0
                ? `${measurement.eaveLF} LF`
                : '—',
            ],
            [
              'Rake',
              (measurement.rakeLF || 0) > 0
                ? `${measurement.rakeLF} LF`
                : '—',
            ],
            ...(measurement.dripEdgeLF
              ? ([[
                  'Drip edge',
                  `${measurement.dripEdgeLF} LF`,
                ]] as [string, string][])
              : []),
            ...(measurement.measureSource
              ? ([[
                  'Source',
                  measurement.measureSource === 'eagleview'
                    ? 'EagleView PDF'
                    : measurement.measureSource === 'instant_roofer'
                      ? 'Instant Roofer AI'
                      : measurement.measureSource,
                ]] as [string, string][])
              : []),
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
                        <span className="font-medium tabular-nums text-emerald-700">{v}</span>
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
                    className="btn-primary px-8 py-3 rounded-full text-sm font-semibold disabled:opacity-50"
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
        
        {/* System docs: available from lead profile + documents hub */}
{systemDocWorkspace === 'pricing' && (
        <div className={documentWorkspaceClass}>
          <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 py-6 pb-20">
            <div className="flex items-center justify-between gap-3 mb-4 sticky top-0 bg-zinc-50/95 backdrop-blur py-3 z-10">
              <div>
                <button
                  type="button"
                  onClick={() => exitLeadDocumentWorkspace()}
                  className="text-sm text-zinc-500 hover:text-zinc-800 mb-2 inline-flex items-center gap-1"
                >
                  ← Back to lead
                </button>
                <h1 className="text-xl font-semibold text-zinc-900">Company pricing</h1>
                <p className="text-xs text-zinc-500">Cost · Sell PHX · Sell Tuc/North</p>
              </div>
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
                            <span className="font-semibold text-emerald-700">
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
          <div className={documentWorkspaceClass}>
            <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 py-6 pb-20">
              <div className="mb-8">
                <button
                  type="button"
                  onClick={() => exitLeadDocumentWorkspace()}
                  className="text-sm text-zinc-500 hover:text-zinc-800 mb-2 inline-flex items-center gap-1"
                >
                  ← Back to lead
                </button>
                <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">
                  Take off sheet
                </h1>
              </div>

              <div className="bg-white border border-zinc-200/80 rounded-3xl p-5 sm:p-6 shadow-sm mb-6">
              <div className="text-xs font-semibold text-zinc-500 tracking-wider uppercase mb-4">
                Take-off details
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {TAKEOFF_FIELD_LABELS.map(({ key, label }) =>
                  key === 'notes' ? null : (
                    <div key={key}>
                      <label className="text-sm text-zinc-500 mb-1.5 block">
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
                        className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base text-zinc-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                      />
                    </div>
                  )
                )}
              </div>
              </div>

                                                        
              <div className="bg-white border border-zinc-200/80 rounded-3xl p-5 sm:p-6 shadow-sm mb-6">
                <div className="text-xs font-semibold text-zinc-500 tracking-wider uppercase mb-4">
                  Notes
                </div>
                <textarea
                  value={takeoffForm.notes || ''}
                  onChange={(e) =>
                    setTakeoffForm((prev) => ({ ...prev, notes: e.target.value }))
                  }
                  rows={4}
                  placeholder=""
                  className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base text-zinc-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                <button
                  type="button"
                  className="btn-primary btn-primary-lg w-full rounded-full"
                  onClick={() => {
                    const lines = Object.entries(takeoffForm || {}).map(
                      ([k, v]) => `${k}: ${v || ''}`
                    );
                    const blob = new Blob([lines.join('\n')], {
                      type: 'text/plain',
                    });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `takeoff-${currentLeadId || 'draft'}.txt`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  Download sheet
                </button>
                {currentLeadId != null ? (
                  <button
                    type="button"
                    className="btn-primary btn-primary-lg w-full rounded-full"
                    onClick={() => {
                      saveTakeoff(true);
                      exitLeadDocumentWorkspace({ returnTab: 'documents' });
                    }}
                  >
                    Save to lead
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-primary btn-primary-lg w-full rounded-full"
                    onClick={() => setTakeoffAssignOpen(true)}
                  >
                    Assign to lead
                  </button>
                )}
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
                      .map((l, leadIdx) => (
                        <button
                          key={`takeoff-pick-${l.supabaseId || l.id}-${leadIdx}`}
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

      {systemDocWorkspace === 'emergency' && emergencyDraft && (
        <div className={documentWorkspaceClass}>
          <div className="page-shell !py-8 sm:!py-10">
            {/* Header — twin of mitigation invoice workspace */}
            <div className="mb-6">
              <button
                type="button"
                className="text-sm text-zinc-500 hover:text-zinc-800 mb-4"
                onClick={() => exitLeadDocumentWorkspace()}
              >
                ← Back to lead
              </button>
              <h1 className="text-3xl font-semibold text-zinc-900 tracking-tight">
                Mitigation Service Agreement
              </h1>
              {mitigationDraft &&
                Array.isArray(mitigationDraft.lines) &&
                mitigationDraft.lines.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setSystemDocWorkspace('mitigation');
                      setShowMitigationPreview(true);
                      setEmergencyPreview(false);
                    }}
                    className="mt-3 text-sm font-semibold text-sky-700 hover:underline"
                  >
                    ← Back to invoice preview
                  </button>
                )}
            </div>

            {!emergencyPreview ? (
              <div className="space-y-6">
                {/* BILLING ENTITY — same control as mitigation invoice */}
                <div className="bg-white border border-zinc-200/80 rounded-3xl p-5 sm:p-6 shadow-sm">
                  <div className="text-xs font-semibold text-zinc-500 mb-3 tracking-wider uppercase">
                    Billing Entity
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() =>
                        setEmergencyDraft({
                          ...emergencyDraft,
                          entity: 'roslie',
                        })
                      }
                      className={`text-left rounded-2xl border-2 p-4 transition-all ${
                        emergencyDraft.entity === 'roslie'
                          ? 'border-sky-500 bg-sky-50 shadow-sm'
                          : 'border-zinc-200 hover:border-zinc-300 bg-white'
                      }`}
                    >
                      <div className="font-semibold text-zinc-900 text-base">
                        Personal
                      </div>
                      <div className="text-sm text-zinc-500 mt-1">
                        Billed through personal LLC
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setEmergencyDraft({
                          ...emergencyDraft,
                          entity: 'prowest',
                        })
                      }
                      className={`text-left rounded-2xl border-2 p-4 transition-all ${
                        emergencyDraft.entity === 'prowest'
                          ? 'border-sky-500 bg-sky-50 shadow-sm'
                          : 'border-zinc-200 hover:border-zinc-300 bg-white'
                      }`}
                    >
                      <div className="font-semibold text-zinc-900 text-base">
                        Company
                      </div>
                      <div className="text-sm text-zinc-500 mt-1">
                        Billed through companies LLC
                      </div>
                    </button>
                  </div>
                  {emergencyDraft.entity === 'prowest' ? (
                    <div className="mt-4 rounded-2xl border border-dashed border-zinc-200 bg-zinc-50/80 px-4 py-3">
                      <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1">
                        Company (from Settings)
                      </div>
                      {companySettingsConfigured() ? (
                        <div className="text-sm text-zinc-800 space-y-0.5">
                          <div className="font-medium">
                            {companyBrandName() || '—'}
                          </div>
                          {(companySettings.address || '').trim() ? (
                            <div className="text-zinc-500">
                              {companySettings.address}
                            </div>
                          ) : null}
                          <div className="text-zinc-500">
                            {companyContactLine() || '—'}
                          </div>
                          {showCompanyPmOnDoc('prowest') ? (
                            <div className="text-zinc-600 pt-1">
                              PM:{' '}
                              {[
                                estimatePmName(),
                                estimatePmPhone(),
                                (companySettings.projectManagerEmail || '').trim(),
                              ]
                                .filter(Boolean)
                                .join(' · ') || '—'}
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <div className="text-sm text-zinc-500">
                          Add company details in Settings → Company
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>

                <div className="bg-white border border-zinc-200/80 rounded-3xl p-5 sm:p-6 shadow-sm space-y-4">
                  <div className="text-xs font-semibold text-zinc-500 tracking-wider uppercase">
                    Client (from lead)
                  </div>
                  {(
                    [
                      ['clientName', 'Client name'],
                      ['propertyAddress', 'Property address'],
                      ['phone', 'Phone'],
                      ['email', 'Email'],
                    ] as const
                  ).map(([key, label]) => (
                    <div key={key}>
                      <label className="text-sm text-zinc-500 mb-1.5 block">
                        {label}
                      </label>
                      <input
                        value={emergencyDraft[key]}
                        onChange={(e) =>
                          setEmergencyDraft({
                            ...emergencyDraft,
                            [key]: e.target.value,
                          })
                        }
                        className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base text-zinc-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                      />
                    </div>
                  ))}
                </div>

                <div className="bg-white border border-zinc-200/80 rounded-3xl p-5 sm:p-6 shadow-sm space-y-4">
                  <div className="text-xs font-semibold text-zinc-500 tracking-wider uppercase">
                    Scope of work
                  </div>
                  <textarea
                    value={emergencyDraft.scope}
                    onChange={(e) =>
                      setEmergencyDraft({
                        ...emergencyDraft,
                        scope: e.target.value,
                      })
                    }
                    rows={5}
                    placeholder="Tarping, patching, sealing…"
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base text-zinc-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                  />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="text-sm text-zinc-500 mb-1.5 block">
                        Est. start
                      </label>
                      <input
                        value={emergencyDraft.serviceStart}
                        onChange={(e) =>
                          setEmergencyDraft({
                            ...emergencyDraft,
                            serviceStart: e.target.value,
                          })
                        }
                        className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base text-zinc-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                      />
                    </div>
                    <div>
                      <label className="text-sm text-zinc-500 mb-1.5 block">
                        Est. complete
                      </label>
                      <input
                        value={emergencyDraft.serviceComplete}
                        onChange={(e) =>
                          setEmergencyDraft({
                            ...emergencyDraft,
                            serviceComplete: e.target.value,
                          })
                        }
                        className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base text-zinc-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                      />
                    </div>
                  </div>
                </div>

                <div className="bg-white border border-zinc-200/80 rounded-3xl p-5 sm:p-6 shadow-sm space-y-4">
                  <div className="text-xs font-semibold text-zinc-500 tracking-wider uppercase">
                    Payment
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        ['insurance', 'Insurance claim'],
                        ['cash', 'Cash / proceeds'],
                      ] as const
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() =>
                          setEmergencyDraft({
                            ...emergencyDraft,
                            paymentMode: mode,
                          })
                        }
                        className={`px-4 py-2 rounded-full text-sm font-semibold border transition-colors ${
                          emergencyDraft.paymentMode === mode
                            ? 'border-sky-500 bg-sky-50 text-zinc-900'
                            : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div>
                    <label className="text-sm text-zinc-500 mb-1.5 block">
                      Amount ($)
                    </label>
                    <input
                      value={emergencyDraft.paymentAmount}
                      onChange={(e) =>
                        setEmergencyDraft({
                          ...emergencyDraft,
                          paymentAmount: e.target.value,
                        })
                      }
                      className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base text-zinc-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                    />
                  </div>
                </div>

                {/* Full agreement body — readable before sign (mirrors PDF) */}
                <div className="bg-white border border-zinc-200/80 rounded-3xl p-5 sm:p-6 shadow-sm space-y-5">
                  <div>
                    <div className="text-xs font-semibold text-zinc-500 tracking-wider uppercase mb-2">
                      Agreement terms — read before signing
                    </div>
                    <p className="text-sm text-zinc-600 leading-relaxed">
                      This Mitigation Service Agreement (&quot;Agreement&quot;)
                      is entered into as of the date electronically signed below
                      between{' '}
                      <span className="font-medium text-zinc-900">
                        {emergencyDraft.entity === 'prowest'
                          ? companyBrandName() ||
                            mitigationBillingBrand('prowest')
                          : mitigationPersonalBrand()}
                      </span>{' '}
                      (&quot;{mitigationPartyRole(emergencyDraft.entity)}&quot;)
                      and the Client named below.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                    <div className="rounded-2xl border border-zinc-200 bg-zinc-50/80 px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 mb-1">
                        Client
                      </div>
                      <div className="font-medium text-zinc-900">
                        {emergencyDraft.clientName || '—'}
                      </div>
                      <div className="text-zinc-600 mt-1">
                        {emergencyDraft.phone || '—'}
                        {emergencyDraft.email
                          ? ` · ${emergencyDraft.email}`
                          : ''}
                      </div>
                    </div>
                    <div className="rounded-2xl border border-zinc-200 bg-zinc-50/80 px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 mb-1">
                        Billed by /{' '}
                        {mitigationPartyRole(emergencyDraft.entity)}
                      </div>
                      <div className="font-medium text-zinc-900">
                        {emergencyDraft.entity === 'prowest'
                          ? companyBrandName() ||
                            mitigationBillingBrand('prowest')
                          : mitigationPersonalBrand() || '—'}
                      </div>
                      <div className="text-zinc-600 mt-1">
                        {mitigationBrandPhone(emergencyDraft.entity) || '—'}
                      </div>
                    </div>
                    <div className="sm:col-span-2 rounded-2xl border border-zinc-200 bg-zinc-50/80 px-4 py-3">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 mb-1">
                        Property
                      </div>
                      <div className="text-zinc-900">
                        {emergencyDraft.propertyAddress || '—'}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4 text-sm">
                    <div>
                      <div className="font-semibold text-zinc-900 mb-1.5">
                        1. Scope of Work
                      </div>
                      <p className="text-zinc-600 leading-relaxed mb-2">
                        {mitigationPartyRole(emergencyDraft.entity)} agrees to
                        perform mitigation / emergency roofing services as
                        deemed necessary to prevent further property damage.
                        Services may include tarping, patching, sealing, or
                        temporary structural reinforcement.
                      </p>
                      <div className="whitespace-pre-wrap rounded-2xl border border-zinc-200 bg-zinc-50/80 px-4 py-3 text-zinc-900">
                        {emergencyDraft.scope.trim() || '—'}
                      </div>
                      <div className="mt-2 text-xs text-zinc-500">
                        Est. start: {emergencyDraft.serviceStart || '—'} · Est.
                        complete: {emergencyDraft.serviceComplete || '—'}
                      </div>
                    </div>

                    <div>
                      <div className="font-semibold text-zinc-900 mb-1.5">
                        2. Payment Terms
                      </div>
                      <ul className="space-y-1.5 text-zinc-800">
                        <li>
                          {emergencyDraft.paymentMode === 'cash' ? '☑' : '☐'}{' '}
                          Cash / insurance proceeds upon completion
                          {emergencyDraft.paymentAmount
                            ? `: $${emergencyDraft.paymentAmount}`
                            : ': $________'}
                        </li>
                        <li>
                          {emergencyDraft.paymentMode === 'insurance'
                            ? '☑'
                            : '☐'}{' '}
                          Payment upon insurance claim approval / disbursement
                          (direct pay authorized if applicable).
                        </li>
                      </ul>
                      <p className="text-zinc-600 leading-relaxed mt-2">
                        Client remains financially responsible if the insurance
                        provider denies or reduces the claim. Payment is due Net
                        15 of completed work.
                      </p>
                      {emergencyDraft.paymentAmount ? (
                        <div className="mt-2 text-base font-semibold tabular-nums text-emerald-700">
                          Amount: $
                          {Number(emergencyDraft.paymentAmount).toLocaleString(
                            undefined,
                            {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            }
                          )}
                        </div>
                      ) : null}
                    </div>

                    <div>
                      <div className="font-semibold text-zinc-900 mb-1.5">
                        3. Limitation of Liability
                      </div>
                      <p className="text-zinc-600 leading-relaxed">
                        Mitigation / emergency repairs are temporary and
                        intended to prevent further damage until permanent
                        repairs can be made.{' '}
                        {mitigationPartyRole(emergencyDraft.entity)} is not
                        liable for pre-existing damage or consequential /
                        incidental damages from weather, pre-existing
                        conditions, or limitations of temporary repairs. Client
                        agrees to hold harmless and indemnify{' '}
                        {mitigationPartyRole(emergencyDraft.entity)} from claims
                        arising from performance of these services.
                      </p>
                    </div>

                    <div>
                      <div className="font-semibold text-zinc-900 mb-1.5">
                        4. Access and Authorization
                      </div>
                      <p className="text-zinc-600 leading-relaxed">
                        Client grants{' '}
                        {mitigationPartyRole(emergencyDraft.entity)} access to
                        the property and authorizes actions needed to perform
                        mitigation work.
                      </p>
                    </div>

                    <div>
                      <div className="font-semibold text-zinc-900 mb-1.5">
                        5. Entire Agreement · Electronic signature
                      </div>
                      <p className="text-zinc-600 leading-relaxed">
                        This Agreement constitutes the full understanding
                        between the parties and supersedes prior agreements. By
                        signing below, Client agrees that an electronic
                        signature (including a drawn signature captured on a
                        device) is the legal equivalent of a handwritten
                        signature.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="bg-white border border-zinc-200/80 rounded-3xl p-5 sm:p-6 shadow-sm space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs font-semibold text-zinc-500 tracking-wider uppercase">
                      Electronic signature
                    </div>
                    {emergencyDraft.clientSignatureDataUrl ? (
                      <span className="text-xs font-medium text-emerald-700">
                        Signed{' '}
                        {formatSignedAtDisplay(emergencyDraft.clientSignedAt)}
                      </span>
                    ) : null}
                  </div>
                  <div>
                    <label className="text-sm text-zinc-500 mb-1.5 block">
                      Signer&apos;s full legal name
                    </label>
                    <input
                      value={emergencyDraft.signerName}
                      onChange={(e) =>
                        setEmergencyDraft({
                          ...emergencyDraft,
                          signerName: e.target.value,
                        })
                      }
                      placeholder="Name as it should appear on the agreement"
                      className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base text-zinc-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                    />
                  </div>
                  {emergencyDraft.clientSignatureDataUrl ? (
                    <div className="space-y-3">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={emergencyDraft.clientSignatureDataUrl}
                        alt="Client signature"
                        className="w-full max-h-28 object-contain border border-zinc-200 rounded-2xl bg-white"
                      />
                      <p className="text-xs text-zinc-500">
                        Electronically signed by{' '}
                        <span className="font-medium text-zinc-800">
                          {emergencyDraft.signerName ||
                            emergencyDraft.clientName ||
                            '—'}
                        </span>{' '}
                        on{' '}
                        {formatSignedAtDisplay(emergencyDraft.clientSignedAt) ||
                          '—'}
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setEmergencyDraft({
                            ...emergencyDraft,
                            clientSignatureDataUrl: null,
                            clientSignedAt: null,
                          });
                          window.setTimeout(
                            () => clearEmergencySignaturePad(),
                            50
                          );
                        }}
                        className="text-sm text-zinc-500 hover:text-zinc-800"
                      >
                        Clear & resign
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-xs text-zinc-500">
                        Draw your signature below.
                      </p>
                      <canvas
                        ref={(el) => {
                          emergencySigPadRef.current = el;
                          if (el && !el.dataset.ready) {
                            el.dataset.ready = '1';
                            el.width = 600;
                            el.height = 160;
                            const ctx = el.getContext('2d');
                            if (ctx) {
                              ctx.fillStyle = '#ffffff';
                              ctx.fillRect(0, 0, el.width, el.height);
                              ctx.strokeStyle = '#18181b';
                              ctx.lineWidth = 2;
                              ctx.lineCap = 'round';
                              ctx.lineJoin = 'round';
                            }
                          }
                        }}
                        className="w-full h-40 border border-zinc-200 rounded-2xl bg-white touch-none cursor-crosshair"
                        onPointerDown={(e) => {
                          const canvas = emergencySigPadRef.current;
                          if (!canvas) return;
                          emergencySigDrawing.current = true;
                          canvas.setPointerCapture(e.pointerId);
                          const ctx = canvas.getContext('2d');
                          if (!ctx) return;
                          const rect = canvas.getBoundingClientRect();
                          const x =
                            ((e.clientX - rect.left) / rect.width) *
                            canvas.width;
                          const y =
                            ((e.clientY - rect.top) / rect.height) *
                            canvas.height;
                          ctx.beginPath();
                          ctx.moveTo(x, y);
                        }}
                        onPointerMove={(e) => {
                          if (!emergencySigDrawing.current) return;
                          const canvas = emergencySigPadRef.current;
                          if (!canvas) return;
                          const ctx = canvas.getContext('2d');
                          if (!ctx) return;
                          const rect = canvas.getBoundingClientRect();
                          const x =
                            ((e.clientX - rect.left) / rect.width) *
                            canvas.width;
                          const y =
                            ((e.clientY - rect.top) / rect.height) *
                            canvas.height;
                          ctx.lineTo(x, y);
                          ctx.stroke();
                        }}
                        onPointerUp={() => {
                          emergencySigDrawing.current = false;
                        }}
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => clearEmergencySignaturePad()}
                          className="px-4 py-2 rounded-full text-sm font-medium border border-zinc-200 text-zinc-700 hover:bg-zinc-50"
                        >
                          Clear pad
                        </button>
                        <button
                          type="button"
                          onClick={() => commitEmergencySignature()}
                          className="btn-primary px-5 py-2 rounded-full text-sm font-semibold"
                        >
                          Sign electronically
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Sticky footer — twin of mitigation invoice */}
                <div className="sticky bottom-0 bg-white/95 backdrop-blur border-t border-zinc-200 py-4 z-40 -mx-[var(--page-pad-x)] px-[var(--page-pad-x)]">
                  <div className="w-full max-w-6xl mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs text-zinc-500">AGREEMENT</div>
                      <div className="text-lg sm:text-xl font-semibold text-zinc-900 truncate">
                        {emergencyDraft.clientName || 'Mitigation Service Agreement'}
                      </div>
                      {emergencyDraft.paymentAmount ? (
                        <div className="text-sm text-emerald-700 tabular-nums mt-0.5">
                          $
                          {Number(emergencyDraft.paymentAmount).toLocaleString(
                            undefined,
                            {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            }
                          )}
                        </div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => setEmergencyPreview(true)}
                      className="btn-primary px-8 py-4 rounded-3xl font-semibold w-full sm:w-auto sm:shrink-0"
                    >
                      See Agreement
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-white p-5 sm:p-8 text-zinc-900 pb-16 rounded-3xl border border-zinc-200/80 shadow-sm">
                <div className="flex justify-between items-center mb-8 gap-3">
                  <button
                    type="button"
                    onClick={() => setEmergencyPreview(false)}
                    className="px-6 py-2 border border-zinc-300 rounded-2xl text-sm hover:bg-zinc-100"
                  >
                    ← Back to edit
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void generateEmergencyAgreementPdf({ download: true })
                    }
                    className="btn-primary px-6 sm:px-8 py-3 rounded-3xl font-semibold"
                  >
                    Download PDF
                  </button>
                </div>

                <div className="text-center mb-8">
                  <div className="font-bold text-3xl tracking-tight">
                    {mitigationBillingBrand(emergencyDraft.entity)}
                  </div>
                  <div className="text-sm text-zinc-400 mt-1">
                    Mitigation Service Agreement · {emergencyDraft.date}
                  </div>
                  {emergencyDraft.entity === 'prowest' &&
                  companySettingsConfigured() ? (
                    <div className="text-xs text-zinc-400 mt-1 space-y-0.5">
                      {(companySettings.address || '').trim() ? (
                        <div>{companySettings.address}</div>
                      ) : null}
                      {companyContactLine() ? (
                        <div>{companyContactLine()}</div>
                      ) : null}
                    </div>
                  ) : null}
                  {emergencyDraft.entity === 'prowest' &&
                    !companySettingsConfigured() && (
                      <div className="text-xs text-amber-700 mt-2">
                        Company details empty — add them in Settings
                      </div>
                    )}
                </div>

                <div className="border border-zinc-200 rounded-3xl p-6 sm:p-10 space-y-6 text-sm">
                  <p className="text-zinc-600 leading-relaxed">
                    This Mitigation Service Agreement (&quot;Agreement&quot;) is
                    entered into as of the date electronically signed below
                    between{' '}
                    {emergencyDraft.entity === 'prowest'
                      ? companyBrandName() ||
                        mitigationBillingBrand('prowest')
                      : mitigationPersonalBrand()}{' '}
                    (&quot;{mitigationPartyRole(emergencyDraft.entity)}&quot;)
                    and the Client named below.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1">
                        Client
                      </div>
                      <div className="font-medium text-zinc-900">
                        {emergencyDraft.clientName || '—'}
                      </div>
                      <div className="text-zinc-600 mt-1">
                        {emergencyDraft.phone || '—'}
                        {emergencyDraft.email
                          ? ` · ${emergencyDraft.email}`
                          : ''}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1">
                        Billed by /{' '}
                        {mitigationPartyRole(emergencyDraft.entity)}
                      </div>
                      <div className="font-medium text-zinc-900">
                        {emergencyDraft.entity === 'prowest'
                          ? companyBrandName() ||
                            mitigationBillingBrand('prowest')
                          : mitigationPersonalBrand() || '—'}
                      </div>
                      <div className="text-zinc-600 mt-1">
                        {mitigationBrandPhone(emergencyDraft.entity) || '—'}
                      </div>
                    </div>
                    <div className="sm:col-span-2">
                      <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1">
                        Property
                      </div>
                      <div className="text-zinc-900">
                        {emergencyDraft.propertyAddress || '—'}
                      </div>
                    </div>
                    {showCompanyPmOnDoc(emergencyDraft.entity) ? (
                      <div className="sm:col-span-2 rounded-2xl border border-zinc-200 bg-zinc-50/80 px-4 py-3">
                        <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1">
                          Project Manager
                        </div>
                        <div className="font-medium text-zinc-900">
                          {estimatePmName() || '—'}
                        </div>
                        <div className="text-zinc-600 mt-0.5">
                          {estimatePmPhone() || '—'}
                        </div>
                        {(companySettings.projectManagerEmail || '').trim() ? (
                          <div className="text-zinc-600 mt-0.5">
                            {(companySettings.projectManagerEmail || '').trim()}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <div>
                    <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">
                      1. Scope of Work
                    </div>
                    <p className="text-zinc-600 mb-2 leading-relaxed">
                      {mitigationPartyRole(emergencyDraft.entity)} agrees to
                      perform mitigation / emergency roofing services as deemed
                      necessary to prevent further property damage. Services may
                      include tarping, patching, sealing, or temporary
                      structural reinforcement.
                    </p>
                    <div className="whitespace-pre-wrap rounded-2xl border border-zinc-200 bg-zinc-50/80 px-4 py-3">
                      {emergencyDraft.scope || '—'}
                    </div>
                    <div className="mt-2 text-zinc-500 text-xs">
                      Est. start: {emergencyDraft.serviceStart || '—'} · Est.
                      complete: {emergencyDraft.serviceComplete || '—'}
                    </div>
                  </div>

                  <div>
                    <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">
                      2. Payment Terms
                    </div>
                    <ul className="space-y-1 text-zinc-800">
                      <li>
                        {emergencyDraft.paymentMode === 'cash' ? '☑' : '☐'} Cash
                        / insurance proceeds upon completion
                        {emergencyDraft.paymentAmount
                          ? `: $${emergencyDraft.paymentAmount}`
                          : ': $________'}
                      </li>
                      <li>
                        {emergencyDraft.paymentMode === 'insurance'
                          ? '☑'
                          : '☐'}{' '}
                        Payment upon insurance claim approval / disbursement
                        (direct pay authorized if applicable).
                      </li>
                    </ul>
                    <p className="text-sm text-zinc-600 mt-2 leading-relaxed">
                      Client remains financially responsible if the insurance
                      provider denies or reduces the claim. Payment is due Net
                      15 of completed work.
                    </p>
                    {emergencyDraft.paymentAmount ? (
                      <div className="mt-2 text-base font-semibold tabular-nums text-emerald-700">
                        Amount: $
                        {Number(emergencyDraft.paymentAmount).toLocaleString(
                          undefined,
                          {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          }
                        )}
                      </div>
                    ) : null}
                  </div>

                  <div>
                    <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">
                      3. Limitation of Liability
                    </div>
                    <p className="text-zinc-600 leading-relaxed">
                      Mitigation / emergency repairs are temporary and intended
                      to prevent further damage until permanent repairs can be
                      made. {mitigationPartyRole(emergencyDraft.entity)} is not
                      liable for pre-existing damage or consequential /
                      incidental damages from weather, pre-existing conditions,
                      or limitations of temporary repairs. Client agrees to hold
                      harmless and indemnify{' '}
                      {mitigationPartyRole(emergencyDraft.entity)} from claims
                      arising from performance of these services.
                    </p>
                  </div>

                  <div>
                    <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">
                      4. Access and Authorization
                    </div>
                    <p className="text-zinc-600 leading-relaxed">
                      Client grants{' '}
                      {mitigationPartyRole(emergencyDraft.entity)} access to the
                      property and authorizes actions needed to perform
                      mitigation work.
                    </p>
                  </div>

                  <div>
                    <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">
                      5. Entire Agreement · Electronic signature
                    </div>
                    <p className="text-zinc-600 leading-relaxed">
                      This Agreement constitutes the full understanding between
                      the parties and supersedes prior agreements. By signing
                      below, Client agrees that an electronic signature
                      (including a drawn signature captured on a device) is the
                      legal equivalent of a handwritten signature.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-4 border-t border-zinc-200">
                    <div>
                      <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">
                        Client — electronic signature
                      </div>
                      {emergencyDraft.clientSignatureDataUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={emergencyDraft.clientSignatureDataUrl}
                          alt="Signature"
                          className="h-16 object-contain"
                        />
                      ) : (
                        <div className="h-16 border-b border-zinc-300" />
                      )}
                      <div className="text-xs text-zinc-800 mt-2 font-medium">
                        {emergencyDraft.signerName ||
                          emergencyDraft.clientName ||
                          '—'}
                      </div>
                      <div className="text-xs text-zinc-400 mt-1">
                        {emergencyDraft.clientSignatureDataUrl
                          ? `Electronically signed ${
                              formatSignedAtDisplay(
                                emergencyDraft.clientSignedAt
                              ) || '—'
                            }`
                          : `Date: ${emergencyDraft.date || '—'}`}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">
                        {mitigationPartyRoleLabel(emergencyDraft.entity)}
                      </div>
                      <div className="h-16 border-b border-zinc-300 flex items-end text-sm text-zinc-500 pb-1">
                        {mitigationBillingBrand(emergencyDraft.entity) || '—'}
                      </div>
                      <div className="text-xs text-zinc-400 mt-2">
                        Date: {emergencyDraft.date || '—'}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-10 space-y-3">
                  <button
                    type="button"
                    onClick={() =>
                      void generateEmergencyAgreementPdf({
                        download: false,
                        save: true,
                      })
                    }
                    className="btn-primary w-full py-4 rounded-3xl font-semibold text-lg"
                  >
                    Save agreement PDF to lead
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

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
                          : styles.card
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

              {/* Quick links — sidebar order, New Lead first */}
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
                    All invoices
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
                    Adjustments and bookings
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => handleTabChange('tasks')}
                  className="group text-left bg-white border border-zinc-200/80 hover:border-sky-300/80 hover:shadow-md hover:-translate-y-0.5 rounded-3xl p-7 sm:p-8 transition-all duration-200"
                >
                  <div className="text-xl sm:text-2xl font-semibold text-zinc-900 mb-1 group-hover:text-sky-900 transition-colors">
                    Tasks
                  </div>
                  <p className="text-sm text-zinc-500 group-hover:text-zinc-600">
                    To-dos with due dates · Google Tasks
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => handleTabChange('performance')}
                  className="group text-left bg-white border border-zinc-200/80 hover:border-sky-300/80 hover:shadow-md hover:-translate-y-0.5 rounded-3xl p-7 sm:p-8 transition-all duration-200"
                >
                  <div className="text-xl sm:text-2xl font-semibold text-zinc-900 mb-1 group-hover:text-sky-900 transition-colors">
                    Performance
                  </div>
                  <p className="text-sm text-zinc-500 group-hover:text-zinc-600">
                    Pipeline health · jobs and estimates
                  </p>
                </button>

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
              </div>
            </div>
          );
        })()}





        {activeTab === 'invoices' && (() => {
              const activeLeadIds = new Set(leads.map((l) => l.id));
              // Hide invoices whose lead is trashed/gone; they return when the lead is restored
              const visibleInvoices = appInvoices.filter(
                (inv) =>
                  inv.leadId == null || activeLeadIds.has(inv.leadId)
              );
              return (
          <div className="pb-8 w-full">
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-8">
              <div>
                <h1 className="text-3xl font-semibold text-zinc-900 tracking-tight">
                  Invoices
                </h1>
                <p className="text-zinc-500 mt-1">
                  {visibleInvoices.length === 0
                    ? 'All invoices across leads'
                    : `${visibleInvoices.length} invoice${visibleInvoices.length === 1 ? '' : 's'}`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => startNewInvoice()}
                className="btn-primary px-5 py-2.5 rounded-2xl text-sm font-semibold"
              >
                New invoice
              </button>
            </div>

            {visibleInvoices.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-zinc-200 bg-white px-6 py-16 text-center">
                <p className="text-sm font-medium text-zinc-800">No invoices yet</p>
                <p className="text-sm text-zinc-500 mt-2 max-w-md mx-auto">
                  New invoice asks you to select or create a lead first — they all list here.
                </p>
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => startNewInvoice()}
                    className="btn-primary px-5 py-2.5 rounded-2xl text-sm font-semibold"
                  >
                    New invoice
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
                {visibleInvoices.map((inv) => (
                  <div
                    key={inv.id}
                    role="button"
                    tabIndex={0}
                    className="bg-white border border-zinc-200 rounded-3xl p-5 hover:border-sky-300 hover:shadow-sm transition-all cursor-pointer"
                    onClick={() => {
                      if (inv.leadId == null) return;
                      setCurrentLeadId(inv.leadId);
                      setIsEditingLead(true);
                      setProfileTab('documents');
                      setActiveTab('leads');
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      if (inv.leadId == null) return;
                      setCurrentLeadId(inv.leadId);
                      setIsEditingLead(true);
                      setProfileTab('documents');
                      setActiveTab('leads');
                    }}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                      <div className="text-left min-w-0 flex-1">
                        <div className="font-semibold text-zinc-900 truncate">
                          {inv.leadLabel || 'Unknown lead'}
                        </div>
                        <div className="text-sm text-zinc-500 mt-0.5 truncate">
                          {new Date(inv.createdAt).toLocaleDateString()}
                          {inv.job ? ` · ${inv.job}` : ''}
                          {inv.title ? ` · ${inv.title}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <div className="text-xl font-semibold tabular-nums text-emerald-700">
                          $
                          {Number(inv.total).toLocaleString(undefined, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </div>
                        <a
                          href={inv.url}
                          download={inv.fileName}
                          target="_blank"
                          rel="noreferrer"
                          className="btn-primary px-3 py-1.5 text-xs font-semibold rounded-lg no-underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Download
                        </a>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeAppInvoice(inv.id);
                          }}
                          className="text-xs text-zinc-500 hover:text-red-500/90 shrink-0 px-2 py-1"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
              );
            })()}

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
                  {items.map(({ lead, estimate, leadName, estimateIndex }) => {
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
                        key={`${lead.id}-${estimate.supabaseId || estimate.id}-${estimateIndex}`}
                        className="bg-white border border-zinc-200 rounded-3xl p-5 hover:border-sky-300 hover:shadow-sm transition-all"
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                          <button
                            type="button"
                            className="text-left min-w-0 flex-1"
                            onClick={() =>
                              openLeadEstimate(lead.id, estimate, lead)
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
                            {estimate.pdfUrl ? (
                              <a
                                href={estimate.pdfUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-zinc-200 text-sky-700 hover:bg-sky-50"
                              >
                                PDF
                              </a>
                            ) : null}
                            <button
                              type="button"
                              onClick={() =>
                                openLeadEstimate(lead.id, estimate, lead)
                              }
                              className="btn-primary px-3 py-1.5 text-xs font-semibold rounded-lg"
                            >
                              Open
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                openLead(lead.id, lead, 'estimates')
                              }
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
          <div className="page-shell page-fade">
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
                    if (doc.id === 'mitigation') {
                      startNewInvoice();
                      return;
                    }
                    if (doc.id === 'emergency') {
                      openEmergencyAgreement(
                        isEditingLead ? currentLeadId : null
                      );
                      return;
                    }
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
          </div>
        )}


        {activeTab === 'calendar' && (() => {
          const openJobs = leads.filter(
            (l) => normalizePipelineStage(l.category) !== 'Closed'
          );
          const todayIso = toLocalIsoDate(new Date());

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
          // Week grid: Sunday–Saturday containing cursor / selected day
          const weekAnchor = calendarSelectedDay
            ? new Date(calendarSelectedDay + 'T12:00:00')
            : calendarCursor;
          weekAnchor.setHours(12, 0, 0, 0);
          const weekStart = startOfWeekSunday(
            calendarViewMode === 'week' ? calendarCursor : weekAnchor
          );
          const weekDays = Array.from({ length: 7 }, (_, i) =>
            addDays(weekStart, i)
          );
          const weekEnd = weekDays[6]!;
          const selectedIso =
            calendarSelectedDay ||
            todayIso ||
            toLocalIsoDate(calendarCursor);

          const gcalEventDayKeys = (event: {
            start?: { dateTime?: string; date?: string };
            end?: { dateTime?: string; date?: string };
          }): string[] => {
            const startRaw = event.start?.date || event.start?.dateTime;
            if (!startRaw) return [];
            const allDay = Boolean(event.start?.date && !event.start?.dateTime);
            if (allDay) {
              const startDate = event.start!.date!;
              const endExclusive =
                event.end?.date ||
                (() => {
                  const d = new Date(startDate + 'T12:00:00');
                  d.setDate(d.getDate() + 1);
                  return toLocalIsoDate(d);
                })();
              const endInclusive = (() => {
                const d = new Date(endExclusive + 'T12:00:00');
                d.setDate(d.getDate() - 1);
                return toLocalIsoDate(d);
              })();
              const keys: string[] = [];
              let cur = startDate;
              let guard = 0;
              const last =
                endInclusive < startDate ? startDate : endInclusive;
              while (cur <= last && guard < 60) {
                keys.push(cur);
                const d = new Date(cur + 'T12:00:00');
                d.setDate(d.getDate() + 1);
                cur = toLocalIsoDate(d);
                guard += 1;
              }
              return keys.length ? keys : [startDate];
            }
            const startD = new Date(event.start!.dateTime!);
            if (Number.isNaN(startD.getTime())) return [];
            const endD = event.end?.dateTime
              ? new Date(event.end.dateTime)
              : new Date(startD.getTime() + 60 * 60 * 1000);
            const keys: string[] = [];
            const cursor = new Date(startD);
            cursor.setHours(12, 0, 0, 0);
            const endDay = new Date(endD);
            // End exactly at midnight → prior day only
            if (
              endD.getHours() === 0 &&
              endD.getMinutes() === 0 &&
              endD.getSeconds() === 0 &&
              endD.getTime() > startD.getTime()
            ) {
              endDay.setTime(endD.getTime() - 1);
            }
            endDay.setHours(12, 0, 0, 0);
            let guard = 0;
            while (cursor.getTime() <= endDay.getTime() && guard < 60) {
              keys.push(toLocalIsoDate(cursor));
              cursor.setDate(cursor.getDate() + 1);
              guard += 1;
            }
            return keys.length ? keys : [toLocalIsoDate(startD)];
          };

          const safeGoogleEvents = Array.isArray(googleCalendarEvents)
            ? googleCalendarEvents
            : [];
          const safeCalendarEvents = Array.isArray(calendarEvents)
            ? calendarEvents
            : [];
          const safeTasks = Array.isArray(tasks) ? tasks : [];

          const googleByDate = new Map<
            string,
            (typeof safeGoogleEvents)[number][]
          >();
          for (const event of safeGoogleEvents) {
            if (!event || typeof event !== 'object') continue;
            for (const key of gcalEventDayKeys(event)) {
              const list = googleByDate.get(key) || [];
              list.push(event);
              googleByDate.set(key, list);
            }
          }

          const dayGoogle = googleByDate.get(selectedIso) || [];

          const daySummitEvents = safeCalendarEvents.filter((ev) =>
            eventOccursOnDay(ev, selectedIso)
          );

          // Google events not already represented as Summit events or lead adjustments
          const summitGoogleIds = new Set(
            safeCalendarEvents
              .map((e) => e?.googleEventId)
              .filter((id): id is string => Boolean(id))
          );
          const adjustmentGoogleIds = new Set(
            (Array.isArray(openJobs) ? openJobs : [])
              .map((l) => l?.calendarEventId)
              .filter((id): id is string => Boolean(id))
          );
          const dayGoogleOnly = dayGoogle.filter(
            (ev) =>
              ev?.id &&
              !summitGoogleIds.has(ev.id) &&
              !adjustmentGoogleIds.has(ev.id)
          );

          const tasksByDate = new Map<string, SummitTask[]>();
          for (const task of safeTasks) {
            if (!task?.dueDate || task.completed) continue;
            const list = tasksByDate.get(task.dueDate) || [];
            list.push(task);
            tasksByDate.set(task.dueDate, list);
          }
          const dayTasks = tasksByDate.get(selectedIso) || [];

          const monthLabel = calendarCursor.toLocaleDateString(undefined, {
            month: 'long',
            year: 'numeric',
          });
          const weekLabel = (() => {
            const a = weekStart.toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
            });
            const b = weekEnd.toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            });
            return `${a} – ${b}`;
          })();
          const nowMinutes =
            new Date().getHours() * 60 + new Date().getMinutes();
          const gridHeight = WEEK_VIEW_HOURS * WEEK_VIEW_HOUR_PX;

          type WeekAllDayChip = {
            key: string;
            label: string;
            kind: 'event' | 'task' | 'google';
            colorId?: string;
            calendarColor?: CalendarListColor;
            onOpen?: () => void;
          };
          type WeekTimedBlock = {
            key: string;
            label: string;
            sub?: string;
            kind: 'event' | 'task' | 'google';
            colorId?: string;
            calendarColor?: CalendarListColor;
            top: number;
            height: number;
            startMin: number;
            endMin: number;
            leftPct: number;
            widthPct: number;
            zIndex: number;
            onOpen?: () => void;
          };

          const weekAllDayForIso = (iso: string): WeekAllDayChip[] => {
            const chips: WeekAllDayChip[] = [];
            for (const ev of safeCalendarEvents.filter((e) =>
              e && eventOccursOnDay(e, iso)
            )) {
              if (!ev.allDay && ev.startTime) continue;
              chips.push({
                key: `e-${ev.id}`,
                label: ev.title,
                kind: 'event',
                colorId: ev.colorId,
                calendarColor: calendarColorFor(ev.calendarId, {
                  bg: ev.calendarColorBg,
                  fg: ev.calendarColorFg,
                }),
                onOpen: () => openEditCalendarEvent(ev),
              });
            }
            for (const task of tasksByDate.get(iso) || []) {
              chips.push({
                key: `t-${task.id}`,
                label: task.title,
                kind: 'task',
              });
            }
            for (const ev of (googleByDate.get(iso) || []).filter(
              (g) =>
                !summitGoogleIds.has(g.id) && !adjustmentGoogleIds.has(g.id)
            )) {
              const isAllDay = Boolean(ev.start?.date && !ev.start?.dateTime);
              if (!isAllDay) continue;
              chips.push({
                key: `g-${ev.id}`,
                label: ev.summary || 'Google event',
                kind: 'google',
                colorId: ev.colorId,
                calendarColor: calendarColorFor(ev.calendarId, {
                  bg: ev.calendarBackground,
                  fg: ev.calendarForeground,
                }),
              });
            }
            return chips;
          };

          const weekTimedForIso = (iso: string): WeekTimedBlock[] => {
            const blocks: WeekTimedBlock[] = [];
            for (const ev of safeCalendarEvents.filter((e) =>
              e && eventOccursOnDay(e, iso)
            )) {
              if (ev.allDay || !ev.startTime) continue;
              const range = timedEventMinutesOnDay(ev, iso);
              if (!range) continue;
              const { startMin: start, endMin: end } = range;
              const dur = end - start;
              blocks.push({
                key: `e-${ev.id}`,
                label: ev.title,
                sub: formatEventTimeLabel(ev),
                kind: 'event',
                colorId: ev.colorId,
                calendarColor: calendarColorFor(ev.calendarId, {
                  bg: ev.calendarColorBg,
                  fg: ev.calendarColorFg,
                }),
                top: (start / 60) * WEEK_VIEW_HOUR_PX,
                height: Math.max(
                  WEEK_VIEW_MIN_EVENT_PX,
                  (dur / 60) * WEEK_VIEW_HOUR_PX
                ),
                startMin: start,
                endMin: end,
                leftPct: 0,
                widthPct: 100,
                zIndex: 10,
                onOpen: () => openEditCalendarEvent(ev),
              });
            }
            for (const ev of (googleByDate.get(iso) || []).filter(
              (g) =>
                !summitGoogleIds.has(g.id) && !adjustmentGoogleIds.has(g.id)
            )) {
              if (ev.start?.date && !ev.start?.dateTime) continue;
              const startRaw = ev.start?.dateTime;
              if (!startRaw) continue;
              const startD = new Date(startRaw);
              if (Number.isNaN(startD.getTime())) continue;
              const endD = ev.end?.dateTime
                ? new Date(ev.end.dateTime)
                : new Date(startD.getTime() + 60 * 60 * 1000);
              const startDayIso = toLocalIsoDate(startD);
              let endDayIso = toLocalIsoDate(endD);
              const endsMidnight =
                endD.getHours() === 0 &&
                endD.getMinutes() === 0 &&
                endD.getSeconds() === 0 &&
                endD.getTime() > startD.getTime();
              if (endsMidnight) {
                const prev = new Date(endD.getTime() - 1);
                endDayIso = toLocalIsoDate(prev);
              }
              const start =
                startDayIso === iso
                  ? startD.getHours() * 60 + startD.getMinutes()
                  : 0;
              let end =
                endDayIso === iso && !endsMidnight
                  ? endD.getHours() * 60 + endD.getMinutes()
                  : endDayIso === iso && endsMidnight
                    ? 24 * 60
                    : endDayIso > iso
                      ? 24 * 60
                      : endD.getHours() * 60 + endD.getMinutes();
              if (startDayIso === iso && endDayIso > iso) end = 24 * 60;
              // Don't invent a 60‑min collision window for zero-length events
              if (!(end > start)) end = Math.min(24 * 60, start + 1);
              const dur = end - start;
              blocks.push({
                key: `g-${ev.id}`,
                label: ev.summary || 'Google event',
                kind: 'google',
                colorId: ev.colorId,
                calendarColor: calendarColorFor(ev.calendarId, {
                  bg: ev.calendarBackground,
                  fg: ev.calendarForeground,
                }),
                top: (start / 60) * WEEK_VIEW_HOUR_PX,
                height: Math.max(
                  WEEK_VIEW_MIN_EVENT_PX,
                  (dur / 60) * WEEK_VIEW_HOUR_PX
                ),
                startMin: start,
                endMin: end,
                leftPct: 0,
                widthPct: 100,
                zIndex: 10,
              });
            }
            const layout = layoutOverlappingTimedEvents(
              blocks.map((b) => ({
                key: b.key,
                startMin: b.startMin,
                endMin: b.endMin,
              }))
            );
            return blocks.map((b) => {
              const place = layout.get(b.key);
              return {
                ...b,
                leftPct: place?.leftPct ?? 0,
                widthPct: place?.widthPct ?? 100,
                zIndex: place?.zIndex ?? 10,
              };
            });
          };

          const openCreateAtSlot = (iso: string, clientY: number, target: HTMLElement) => {
            const rect = target.getBoundingClientRect();
            const y = clientY - rect.top;
            const rawMins = (y / WEEK_VIEW_HOUR_PX) * 60;
            const snapped = Math.max(
              0,
              Math.min(23 * 60 + 30, snapMinutes(rawMins, 30))
            );
            const startTime = minutesToHhmm(snapped);
            openCreateCalendarEvent(iso, {
              startTime,
              endTime: defaultEndTime(startTime),
              allDay: false,
            });
          };

          return (
            <div className="page-shell page-fade space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">
                    {appDisplayName()} Calendar
                  </h1>
                  {gcalEmail ? (
                    <p className="text-zinc-500 mt-1 text-sm">{gcalEmail}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <div
                    className="inline-flex rounded-2xl border border-zinc-200 p-0.5 bg-zinc-50/80"
                    role="group"
                    aria-label="Calendar view"
                  >
                    <button
                      type="button"
                      onClick={() => setCalendarViewMode('month')}
                      className={`px-3.5 py-2 rounded-[0.9rem] text-sm font-semibold transition-colors ${
                        calendarViewMode === 'month'
                          ? 'bg-white text-zinc-900 shadow-sm'
                          : 'text-zinc-500 hover:text-zinc-800'
                      }`}
                    >
                      Month
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCalendarViewMode('week');
                        const anchor = calendarSelectedDay
                          ? new Date(calendarSelectedDay + 'T12:00:00')
                          : calendarCursor;
                        setCalendarCursor(anchor);
                      }}
                      className={`px-3.5 py-2 rounded-[0.9rem] text-sm font-semibold transition-colors ${
                        calendarViewMode === 'week'
                          ? 'bg-white text-zinc-900 shadow-sm'
                          : 'text-zinc-500 hover:text-zinc-800'
                      }`}
                    >
                      Week
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCalendarViewMode('day');
                        const anchor = calendarSelectedDay
                          ? new Date(calendarSelectedDay + 'T12:00:00')
                          : calendarCursor;
                        setCalendarCursor(anchor);
                        setCalendarSelectedDay(toLocalIsoDate(anchor));
                      }}
                      className={`px-3.5 py-2 rounded-[0.9rem] text-sm font-semibold transition-colors ${
                        calendarViewMode === 'day'
                          ? 'bg-white text-zinc-900 shadow-sm'
                          : 'text-zinc-500 hover:text-zinc-800'
                      }`}
                    >
                      Day
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const now = new Date();
                      setCalendarCursor(now);
                      setCalendarSelectedDay(toLocalIsoDate(now));
                      setCalendarViewMode('day');
                    }}
                    className="px-4 py-2.5 rounded-2xl text-sm font-semibold border border-zinc-200 text-zinc-800 hover:bg-zinc-50"
                  >
                    Today
                  </button>
                  <div
                    className="inline-flex rounded-2xl border border-zinc-200 p-0.5 bg-zinc-50/80"
                    role="group"
                    aria-label="Calendar or Tasks"
                  >
                    <button
                      type="button"
                      onClick={() => handleTabChange('calendar')}
                      className="px-3.5 py-2 rounded-[0.9rem] text-sm font-semibold transition-colors bg-white text-zinc-900 shadow-sm"
                    >
                      Calendar
                    </button>
                    <button
                      type="button"
                      onClick={() => handleTabChange('tasks')}
                      className="px-3.5 py-2 rounded-[0.9rem] text-sm font-semibold transition-colors text-zinc-500 hover:text-zinc-800"
                    >
                      Tasks
                    </button>
                  </div>
                  {!gcalConnected ? (
                    <button
                      type="button"
                      disabled={gcalBusy}
                      onClick={() => void connectGoogleCalendar()}
                      className="px-4 py-2.5 rounded-2xl text-sm font-semibold border border-zinc-200 text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
                    >
                      Connect Google
                    </button>
                  ) : null}
                  {gcalConnected && gtasksNeedsReconnect ? (
                    <button
                      type="button"
                      disabled={gcalBusy}
                      onClick={() =>
                        void connectGoogleCalendar({ forceConsent: true })
                      }
                      className="px-4 py-2.5 rounded-2xl text-sm font-semibold border border-amber-300 text-amber-950 bg-amber-50 hover:bg-amber-100 disabled:opacity-50"
                    >
                      Reconnect for Tasks
                    </button>
                  ) : null}
                  {gcalConnected && gcalCalendarListNeedsReconnect ? (
                    <button
                      type="button"
                      disabled={gcalBusy}
                      onClick={() =>
                        void connectGoogleCalendar({ forceConsent: true })
                      }
                      className="px-4 py-2.5 rounded-2xl text-sm font-semibold border border-amber-300 text-amber-950 bg-amber-50 hover:bg-amber-100 disabled:opacity-50"
                    >
                      Reconnect for colors
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => openCreateCalendarEvent(selectedIso)}
                    className="btn-primary px-5 py-2.5 rounded-2xl text-sm font-semibold"
                  >
                    Create event
                  </button>
                </div>
              </div>

              {/* Month or week grid — hidden in Day mode (day breakdown is primary) */}
              {calendarViewMode !== 'day' ? (
              <div className="rounded-3xl border border-zinc-200 bg-white overflow-hidden">
                <div className="flex items-center justify-between px-4 sm:px-5 py-4 border-b border-zinc-100">
                  <button
                    type="button"
                    onClick={() => {
                      if (calendarViewMode === 'week') {
                        const n = addDays(startOfWeekSunday(calendarCursor), -7);
                        setCalendarCursor(n);
                        setCalendarSelectedDay(toLocalIsoDate(n));
                      } else {
                        setCalendarCursor((prev) => {
                          const n = new Date(prev);
                          n.setMonth(n.getMonth() - 1);
                          return n;
                        });
                      }
                    }}
                    className="w-9 h-9 rounded-xl text-zinc-600 hover:bg-zinc-100 text-sm font-semibold"
                    aria-label={
                      calendarViewMode === 'week'
                        ? 'Previous week'
                        : 'Previous month'
                    }
                  >
                    ←
                  </button>
                  <div className="text-center text-zinc-900 font-semibold text-lg tracking-tight">
                    {calendarViewMode === 'week' ? weekLabel : monthLabel}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (calendarViewMode === 'week') {
                        const n = addDays(startOfWeekSunday(calendarCursor), 7);
                        setCalendarCursor(n);
                        setCalendarSelectedDay(toLocalIsoDate(n));
                      } else {
                        setCalendarCursor((prev) => {
                          const n = new Date(prev);
                          n.setMonth(n.getMonth() + 1);
                          return n;
                        });
                      }
                    }}
                    className="w-9 h-9 rounded-xl text-zinc-600 hover:bg-zinc-100 text-sm font-semibold"
                    aria-label={
                      calendarViewMode === 'week' ? 'Next week' : 'Next month'
                    }
                  >
                    →
                  </button>
                </div>

                {calendarViewMode === 'week' ? (
                  <div className="flex flex-col min-h-0">
                    {/* Day headers */}
                    <div className="grid grid-cols-[3.25rem_repeat(7,minmax(0,1fr))] border-b border-zinc-100">
                      <div className="border-r border-zinc-100" />
                      {weekDays.map((day) => {
                        const iso = toLocalIsoDate(day);
                        const isToday = iso === todayIso;
                        const isSelected = iso === selectedIso;
                        return (
                          <button
                            key={`wh-${iso}`}
                            type="button"
                            onClick={() => {
                              setCalendarSelectedDay(iso);
                              setCalendarCursor(day);
                            }}
                            className={`py-2 px-1 text-center border-r border-zinc-100 last:border-r-0 transition-colors ${
                              isSelected ? 'bg-sky-50' : 'hover:bg-zinc-50'
                            }`}
                          >
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                              {day.toLocaleDateString(undefined, {
                                weekday: 'short',
                              })}
                            </div>
                            <div
                              className={`mx-auto mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-full text-sm font-semibold tabular-nums ${
                                isToday
                                  ? 'bg-zinc-900 text-white'
                                  : 'text-zinc-800'
                              }`}
                            >
                              {day.getDate()}
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    {/* All-day row */}
                    <div className="grid grid-cols-[3.25rem_repeat(7,minmax(0,1fr))] border-b border-zinc-200 bg-zinc-50/40">
                      <div className="px-1 py-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 text-right pr-2 border-r border-zinc-100">
                        All day
                      </div>
                      {weekDays.map((day) => {
                        const iso = toLocalIsoDate(day);
                        const chips = weekAllDayForIso(iso);
                        return (
                          <div
                            key={`wa-${iso}`}
                            className="min-h-[2.75rem] p-1 space-y-0.5 border-r border-zinc-100 last:border-r-0"
                            onDoubleClick={() =>
                              openCreateCalendarEvent(iso, { allDay: true })
                            }
                          >
                            {chips.slice(0, 3).map((chip) => {
                              const colorStyle =
                                chip.kind === 'event' || chip.kind === 'google'
                                  ? eventChipColorStyle(
                                      chip.colorId,
                                      chip.calendarColor
                                    )
                                  : undefined;
                              return (
                              <button
                                key={chip.key}
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setCalendarSelectedDay(iso);
                                  if (chip.onOpen) chip.onOpen();
                                }}
                                style={colorStyle}
                                className={`block w-full text-left truncate rounded-md px-1.5 py-0.5 text-[10px] sm:text-[11px] font-medium ${
                                  colorStyle
                                    ? ''
                                    : chip.kind === 'event'
                                      ? 'bg-sky-100 text-sky-950'
                                      : chip.kind === 'task'
                                        ? 'bg-amber-100 text-amber-950'
                                        : 'bg-emerald-100 text-emerald-900'
                                }`}
                              >
                                {chip.label}
                              </button>
                              );
                            })}
                            {chips.length > 3 ? (
                              <div className="text-[10px] text-zinc-400 px-0.5">
                                +{chips.length - 3} more
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>

                    {/* Timed grid */}
                    <div
                      ref={calendarWeekScrollRef}
                      className="overflow-y-auto max-h-[min(62vh,38rem)]"
                    >
                      <div
                        className="grid grid-cols-[3.25rem_repeat(7,minmax(0,1fr))] relative"
                        style={{ height: gridHeight }}
                      >
                        {/* Hour labels + lines */}
                        <div className="relative border-r border-zinc-100">
                          {Array.from({ length: WEEK_VIEW_HOURS }, (_, h) => (
                            <div
                              key={`hl-${h}`}
                              className="absolute right-0 left-0 border-t border-zinc-100"
                              style={{
                                top: h * WEEK_VIEW_HOUR_PX,
                                height: WEEK_VIEW_HOUR_PX,
                              }}
                            >
                              {h > 0 ? (
                                <span className="absolute -top-2 right-2 text-[10px] font-medium text-zinc-400 tabular-nums">
                                  {formatHourLabel(h)}
                                </span>
                              ) : null}
                            </div>
                          ))}
                        </div>

                        {weekDays.map((day) => {
                          const iso = toLocalIsoDate(day);
                          const isToday = iso === todayIso;
                          const blocks = weekTimedForIso(iso);
                          return (
                            <div
                              key={`wt-${iso}`}
                              role="presentation"
                              className={`relative border-r border-zinc-100 last:border-r-0 cursor-pointer ${
                                isToday ? 'bg-sky-50/30' : ''
                              }`}
                              style={{ height: gridHeight }}
                              onClick={(e) => {
                                if (
                                  (e.target as HTMLElement).closest(
                                    '[data-week-block]'
                                  )
                                )
                                  return;
                                setCalendarSelectedDay(iso);
                                setCalendarCursor(day);
                                openCreateAtSlot(
                                  iso,
                                  e.clientY,
                                  e.currentTarget
                                );
                              }}
                            >
                              {Array.from(
                                { length: WEEK_VIEW_HOURS },
                                (_, h) => (
                                  <div
                                    key={`gl-${iso}-${h}`}
                                    className="absolute left-0 right-0 border-t border-zinc-100 pointer-events-none"
                                    style={{
                                      top: h * WEEK_VIEW_HOUR_PX,
                                      height: WEEK_VIEW_HOUR_PX,
                                    }}
                                  />
                                )
                              )}
                              {isToday ? (
                                <div
                                  className="absolute left-0 right-0 z-20 pointer-events-none"
                                  style={{
                                    top: (nowMinutes / 60) * WEEK_VIEW_HOUR_PX,
                                  }}
                                >
                                  <div className="relative border-t-2 border-rose-500">
                                    <span className="absolute -left-1 -top-1.5 h-3 w-3 rounded-full bg-rose-500" />
                                  </div>
                                </div>
                              ) : null}
                              {blocks.map((block) => {
                                const colorStyle =
                                  block.kind === 'event' ||
                                  block.kind === 'google'
                                    ? eventBlockColorStyle(
                                        block.colorId,
                                        block.calendarColor
                                      )
                                    : undefined;
                                return (
                                <button
                                  key={block.key}
                                  type="button"
                                  data-week-block
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setCalendarSelectedDay(iso);
                                    if (block.onOpen) block.onOpen();
                                  }}
                                  className={`absolute overflow-hidden rounded-md px-1.5 pt-0.5 pb-0.5 text-left text-[10px] sm:text-[11px] font-semibold leading-tight shadow-sm flex flex-col justify-start items-stretch ${
                                    colorStyle
                                      ? ''
                                      : 'bg-amber-400 text-amber-950'
                                  }`}
                                  style={{
                                    top: block.top,
                                    height: block.height,
                                    left: `calc(${block.leftPct}% + 1px)`,
                                    width: `calc(${block.widthPct}% - 2px)`,
                                    zIndex: block.zIndex,
                                    ...(colorStyle || {}),
                                  }}
                                  title={block.label}
                                >
                                  <div className="truncate shrink-0">
                                    {block.label}
                                  </div>
                                  {block.sub && block.height >= 36 ? (
                                    <div className="truncate opacity-90 font-medium shrink-0">
                                      {block.sub}
                                    </div>
                                  ) : null}
                                </button>
                                );
                              })}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-7 border-b border-zinc-100 text-center text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                      {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(
                        (d) => (
                          <div key={d} className="py-2">
                            {d}
                          </div>
                        )
                      )}
                    </div>
                    <div className="grid grid-cols-7 auto-rows-fr">
                      {monthDays.map((day) => {
                        const iso = toLocalIsoDate(day);
                        const inMonth =
                          day.getMonth() === calendarCursor.getMonth();
                        const isToday = iso === todayIso;
                        const isSelected = iso === selectedIso;
                        const gEvents = (googleByDate.get(iso) || []).filter(
                          (ev) =>
                            !summitGoogleIds.has(ev.id) &&
                            !adjustmentGoogleIds.has(ev.id)
                        );
                        const dayTaskList = tasksByDate.get(iso) || [];
                        const dayEvts = calendarEvents.filter((ev) =>
                          eventOccursOnDay(ev, iso)
                        );
                        type DayChip = {
                          key: string;
                          label: string;
                          kind: 'event' | 'task' | 'google';
                          colorId?: string;
                          calendarColor?: CalendarListColor;
                          onOpen?: () => void;
                        };
                        const chips: DayChip[] = [
                          ...dayEvts.slice(0, 2).map((ev) => ({
                            key: `e-${ev.id}`,
                            label: ev.title,
                            kind: 'event' as const,
                            colorId: ev.colorId,
                            calendarColor: calendarColorFor(ev.calendarId, {
                              bg: ev.calendarColorBg,
                              fg: ev.calendarColorFg,
                            }),
                            onOpen: () => openEditCalendarEvent(ev),
                          })),
                          ...dayTaskList.slice(0, 1).map((task) => ({
                            key: `t-${task.id}`,
                            label: task.title,
                            kind: 'task' as const,
                          })),
                          ...gEvents
                            .slice(
                              0,
                              Math.max(
                                0,
                                3 -
                                  Math.min(2, dayEvts.length) -
                                  Math.min(1, dayTaskList.length)
                              )
                            )
                            .map((ev) => ({
                              key: `g-${ev.id}`,
                              label: ev.summary || 'Google event',
                              kind: 'google' as const,
                              colorId: ev.colorId,
                              calendarColor: calendarColorFor(ev.calendarId, {
                                bg: ev.calendarBackground,
                                fg: ev.calendarForeground,
                              }),
                            })),
                        ].slice(0, 3);
                        const more =
                          dayEvts.length +
                          dayTaskList.length +
                          gEvents.length -
                          chips.length;
                        return (
                          <div
                            key={iso}
                            role="button"
                            tabIndex={0}
                            onClick={() => {
                              setCalendarSelectedDay(iso);
                              if (!inMonth) setCalendarCursor(day);
                            }}
                            onDoubleClick={() => {
                              setCalendarSelectedDay(iso);
                              if (!inMonth) setCalendarCursor(day);
                              openCreateCalendarEvent(iso);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                setCalendarSelectedDay(iso);
                                if (!inMonth) setCalendarCursor(day);
                              }
                            }}
                            className={`min-h-[5.5rem] sm:min-h-[6.75rem] p-1.5 sm:p-2 text-left border-b border-r border-zinc-100 transition-colors align-top cursor-pointer ${
                              isSelected
                                ? 'bg-sky-50 ring-2 ring-inset ring-sky-400'
                                : isToday
                                  ? 'bg-zinc-50'
                                  : 'bg-white hover:bg-zinc-50/80'
                            } ${inMonth ? '' : 'opacity-45'}`}
                          >
                            <div
                              className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs tabular-nums font-semibold ${
                                isToday
                                  ? 'bg-zinc-900 text-white'
                                  : 'text-zinc-800'
                              }`}
                            >
                              {day.getDate()}
                            </div>
                            <div className="mt-1 space-y-0.5">
                              {chips.map((chip) => {
                                const colorStyle =
                                  chip.kind === 'event' ||
                                  chip.kind === 'google'
                                    ? eventChipColorStyle(
                                        chip.colorId,
                                        chip.calendarColor
                                      )
                                    : undefined;
                                return (
                                <button
                                  key={chip.key}
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setCalendarSelectedDay(iso);
                                    if (chip.onOpen) chip.onOpen();
                                  }}
                                  style={colorStyle}
                                  className={`block w-full text-left truncate rounded-md px-1.5 py-0.5 text-[10px] sm:text-[11px] font-medium ${
                                    colorStyle
                                      ? ''
                                      : chip.kind === 'event'
                                        ? 'bg-sky-100 text-sky-950'
                                        : chip.kind === 'task'
                                          ? 'bg-amber-100 text-amber-950'
                                          : 'bg-emerald-100 text-emerald-900'
                                  }`}
                                >
                                  {chip.label}
                                </button>
                                );
                              })}
                              {more > 0 ? (
                                <div className="text-[10px] text-zinc-400 px-0.5">
                                  +{more} more
                                </div>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
              ) : null}

              {/* Day breakdown — primary content in Day mode; also shown under Month/Week */}
              <div className="rounded-3xl border border-zinc-200 bg-white p-5 sm:p-6 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <div className="flex items-start gap-2 min-w-0">
                    {calendarViewMode === 'day' ? (
                      <button
                        type="button"
                        onClick={() => {
                          const d = addDays(
                            new Date(selectedIso + 'T12:00:00'),
                            -1
                          );
                          setCalendarCursor(d);
                          setCalendarSelectedDay(toLocalIsoDate(d));
                        }}
                        className="w-9 h-9 rounded-xl text-zinc-600 hover:bg-zinc-100 text-sm font-semibold shrink-0"
                        aria-label="Previous day"
                      >
                        ←
                      </button>
                    ) : null}
                    <div className="min-w-0">
                      <h2 className="text-lg font-semibold text-zinc-900">
                        {selectedIso === todayIso
                          ? 'Today'
                          : new Date(
                              selectedIso + 'T12:00:00'
                            ).toLocaleDateString(undefined, {
                              weekday: 'long',
                              month: 'long',
                              day: 'numeric',
                            })}
                      </h2>
                      <p className="text-sm text-zinc-500 mt-0.5">
                        {daySummitEvents.length +
                          dayGoogleOnly.length +
                          dayTasks.length ===
                        0
                          ? 'Nothing scheduled — create an event or add a task'
                          : [
                              daySummitEvents.length
                                ? `${daySummitEvents.length} event${daySummitEvents.length === 1 ? '' : 's'}`
                                : '',
                              dayTasks.length
                                ? `${dayTasks.length} task${dayTasks.length === 1 ? '' : 's'}`
                                : '',
                              dayGoogleOnly.length
                                ? `${dayGoogleOnly.length} Google`
                                : '',
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                      </p>
                    </div>
                    {calendarViewMode === 'day' ? (
                      <button
                        type="button"
                        onClick={() => {
                          const d = addDays(
                            new Date(selectedIso + 'T12:00:00'),
                            1
                          );
                          setCalendarCursor(d);
                          setCalendarSelectedDay(toLocalIsoDate(d));
                        }}
                        className="w-9 h-9 rounded-xl text-zinc-600 hover:bg-zinc-100 text-sm font-semibold shrink-0"
                        aria-label="Next day"
                      >
                        →
                      </button>
                    ) : null}
                  </div>
                </div>

                {daySummitEvents.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                      Events
                    </div>
                    {daySummitEvents.map((event) => {
                      const chipStyle = eventChipColorStyle(
                        event.colorId,
                        calendarColorFor(event.calendarId, {
                          bg: event.calendarColorBg,
                          fg: event.calendarColorFg,
                        })
                      );
                      return (
                      <div
                        key={`day-ev-${event.id}`}
                        className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-2xl border border-zinc-200/80 px-4 py-3"
                        style={{
                          backgroundColor: chipStyle.backgroundColor,
                          color: chipStyle.color,
                        }}
                      >
                        <button
                          type="button"
                          className="text-left min-w-0"
                          onClick={() => openEditCalendarEvent(event)}
                        >
                          <div className="font-semibold truncate">
                            {event.title}
                          </div>
                          <div className="text-xs mt-0.5 opacity-90">
                            {formatEventTimeLabel(event)}
                            {event.leadId != null
                              ? ` · Lead: ${event.leadName || `#${event.leadId}`}`
                              : ''}
                            {event.googleEventId ? ' · Synced' : ''}
                          </div>
                        </button>
                        <div className="flex gap-2 shrink-0">
                          {event.leadId != null ? (
                            <button
                              type="button"
                              onClick={() =>
                                openLeadProfile(event.leadId!, undefined)
                              }
                              className="px-3 py-1.5 text-xs font-semibold rounded-lg btn-primary"
                            >
                              Open lead
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => openEditCalendarEvent(event)}
                            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-zinc-200 text-zinc-700 hover:bg-zinc-50 bg-white/70"
                          >
                            Edit
                          </button>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                )}

                {dayTasks.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                      Tasks
                    </div>
                    {dayTasks.map((task) => (
                      <div
                        key={`day-task-${task.id}`}
                        className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-2xl border border-amber-200 bg-amber-50/50 px-4 py-3"
                      >
                        <button
                          type="button"
                          className="text-left min-w-0 flex items-start gap-3"
                          onClick={() =>
                            void updateTaskLocal(task.id, {
                              completed: true,
                            })
                          }
                        >
                          <span className="mt-0.5 w-4 h-4 rounded border border-amber-400 shrink-0 bg-white" />
                          <div className="min-w-0">
                            <div className="font-semibold text-zinc-900 truncate">
                              {task.title}
                            </div>
                            {task.notes ? (
                              <div className="text-xs text-zinc-500 mt-0.5 truncate">
                                {task.notes}
                              </div>
                            ) : null}
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleTabChange('tasks')}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-amber-300 text-amber-950 hover:bg-amber-100 shrink-0"
                        >
                          Open Tasks
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {dayGoogleOnly.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                      Google Calendar
                    </div>
                    {dayGoogleOnly.map((event) => {
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
                          className="flex items-center gap-4 rounded-2xl border border-emerald-200 bg-emerald-50/40 px-4 py-3"
                        >
                          <div className="w-20 shrink-0 font-mono text-emerald-800/80 text-sm">
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
                              className="text-xs font-semibold text-emerald-800 border border-emerald-300 px-3 py-1 rounded-full shrink-0 hover:bg-emerald-100"
                            >
                              Open
                            </a>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}

                {daySummitEvents.length === 0 &&
                  dayGoogleOnly.length === 0 &&
                  dayTasks.length === 0 && (
                    <p className="text-sm text-zinc-500">
                      Empty day — create an event or add a task.
                    </p>
                  )}
              </div>
            </div>
          );
        })()}

        {activeTab === 'tasks' && (() => {
          const listId = activeTaskList?.id || DEFAULT_TASK_LIST_ID;
          const listTasks = tasks.filter((t) => t.listId === listId);
          const openTasks = listTasks.filter((t) => !t.completed);
          const doneTasks = listTasks.filter((t) => t.completed);
          return (
            <div className="page-shell page-fade space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <h1 className="text-3xl font-semibold tracking-tight text-zinc-900">
                    Tasks
                  </h1>
                  <p className="text-zinc-500 mt-1">
                    {activeTaskList?.title || 'My Tasks'} · {openTasks.length}{' '}
                    open
                    {doneTasks.length ? ` · ${doneTasks.length} done` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div
                    className="inline-flex rounded-2xl border border-zinc-200 p-0.5 bg-zinc-50/80"
                    role="group"
                    aria-label="Calendar or Tasks"
                  >
                    <button
                      type="button"
                      onClick={() => handleTabChange('calendar')}
                      className="px-3.5 py-2 rounded-[0.9rem] text-sm font-semibold transition-colors text-zinc-500 hover:text-zinc-800"
                    >
                      Calendar
                    </button>
                    <button
                      type="button"
                      onClick={() => handleTabChange('tasks')}
                      className="px-3.5 py-2 rounded-[0.9rem] text-sm font-semibold transition-colors bg-white text-zinc-900 shadow-sm"
                    >
                      Tasks
                    </button>
                  </div>
                  {!gcalConnected ? (
                    <button
                      type="button"
                      disabled={gcalBusy}
                      onClick={() =>
                        void connectGoogleCalendar({ forceConsent: true })
                      }
                      className="px-4 py-2.5 rounded-2xl text-sm font-semibold border border-zinc-200 text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
                    >
                      Connect Google
                    </button>
                  ) : gtasksNeedsReconnect ? (
                    <button
                      type="button"
                      disabled={gcalBusy}
                      onClick={() =>
                        void connectGoogleCalendar({ forceConsent: true })
                      }
                      className="px-4 py-2.5 rounded-2xl text-sm font-semibold border border-amber-300 text-amber-950 bg-amber-50 hover:bg-amber-100 disabled:opacity-50"
                    >
                      Reconnect for Tasks
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="rounded-3xl border border-zinc-200 bg-white p-5 sm:p-6 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="text-sm font-semibold text-zinc-900">
                    Lists
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <input
                      type="text"
                      value={taskListDraftTitle}
                      onChange={(e) => setTaskListDraftTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void createTaskList();
                      }}
                      placeholder="New list name"
                      className="rounded-2xl border border-zinc-200 px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-sky-300 min-w-[10rem]"
                    />
                    <button
                      type="button"
                      onClick={() => void createTaskList()}
                      className="px-4 py-2 rounded-2xl text-sm font-semibold border border-zinc-200 text-zinc-800 hover:bg-zinc-50"
                    >
                      Create list
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {taskLists.map((list) => {
                    const count = tasks.filter(
                      (t) => t.listId === list.id && !t.completed
                    ).length;
                    const active = list.id === listId;
                    return (
                      <div key={list.id} className="flex items-center gap-1">
                        {renamingTaskListId === list.id ? (
                          <form
                            className="flex items-center gap-1"
                            onSubmit={(e) => {
                              e.preventDefault();
                              void renameTaskList(list.id, renameTaskListTitle);
                            }}
                          >
                            <input
                              autoFocus
                              type="text"
                              value={renameTaskListTitle}
                              onChange={(e) =>
                                setRenameTaskListTitle(e.target.value)
                              }
                              className="rounded-xl border border-zinc-200 px-2 py-1.5 text-sm w-36"
                            />
                            <button
                              type="submit"
                              className="text-xs font-semibold text-sky-800 px-2 py-1"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setRenamingTaskListId(null);
                                setRenameTaskListTitle('');
                              }}
                              className="text-xs text-zinc-500 px-2 py-1"
                            >
                              Cancel
                            </button>
                          </form>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => persistActiveTaskListId(list.id)}
                              className={`px-3 py-1.5 rounded-full text-sm font-semibold border transition-colors ${
                                active
                                  ? 'border-sky-500 bg-sky-50 text-zinc-900'
                                  : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'
                              }`}
                            >
                              {list.title}
                              {count > 0 ? (
                                <span className="ml-1.5 text-xs font-medium text-zinc-500">
                                  {count}
                                </span>
                              ) : null}
                            </button>
                            <button
                              type="button"
                              title="Rename list"
                              onClick={() => {
                                setRenamingTaskListId(list.id);
                                setRenameTaskListTitle(list.title);
                              }}
                              className="text-xs text-zinc-400 hover:text-zinc-700 px-1"
                            >
                              Rename
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-3xl border border-zinc-200 bg-white p-5 sm:p-6 space-y-4">
                <div className="text-sm font-semibold text-zinc-900">
                  Add task
                  {activeTaskList ? (
                    <span className="font-normal text-zinc-500">
                      {' '}
                      · {activeTaskList.title}
                    </span>
                  ) : null}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
                  <input
                    type="text"
                    value={newTaskTitle}
                    onChange={(e) => setNewTaskTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void addTask();
                    }}
                    placeholder="What needs doing?"
                    className="w-full rounded-2xl border border-zinc-200 px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-sky-300"
                  />
                  <input
                    type="date"
                    value={newTaskDue}
                    onChange={(e) => setNewTaskDue(e.target.value)}
                    className="rounded-2xl border border-zinc-200 px-4 py-3 text-sm text-zinc-800 focus:outline-none focus:ring-2 focus:ring-sky-300"
                  />
                </div>
                <textarea
                  value={newTaskNotes}
                  onChange={(e) => setNewTaskNotes(e.target.value)}
                  placeholder="Notes (optional)"
                  rows={2}
                  className="w-full rounded-2xl border border-zinc-200 px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-sky-300 resize-none"
                />
                <button
                  type="button"
                  onClick={() => void addTask()}
                  className="btn-primary px-5 py-2.5 rounded-2xl text-sm font-semibold"
                >
                  Add task
                </button>
              </div>

              <div className="space-y-3">
                <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                  Open
                </div>
                {openTasks.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-zinc-200 bg-white px-4 py-10 text-center text-sm text-zinc-400">
                    No open tasks in this list — add one above
                  </div>
                ) : (
                  openTasks.map((task) => (
                    <div
                      key={task.id}
                      className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 flex flex-col sm:flex-row sm:items-start gap-3"
                    >
                      <button
                        type="button"
                        aria-label={`Complete ${task.title}`}
                        onClick={() =>
                          void updateTaskLocal(task.id, { completed: true })
                        }
                        className="mt-0.5 w-5 h-5 rounded border border-zinc-300 hover:border-emerald-500 hover:bg-emerald-50 shrink-0"
                      />
                      <div className="flex-1 min-w-0 space-y-2">
                        <input
                          type="text"
                          value={task.title}
                          onChange={(e) =>
                            void updateTaskLocal(
                              task.id,
                              { title: e.target.value },
                              { syncGoogle: false }
                            )
                          }
                          onBlur={() => void flushTaskToGoogle(task.id)}
                          className="w-full font-semibold text-zinc-900 bg-transparent border-0 p-0 focus:outline-none focus:ring-0"
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="date"
                            value={task.dueDate || ''}
                            onChange={(e) =>
                              void updateTaskLocal(task.id, {
                                dueDate: e.target.value || undefined,
                              })
                            }
                            className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
                          />
                          {task.googleTaskId ? (
                            <span className="text-[10px] font-medium uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                              Google
                            </span>
                          ) : null}
                          {task.dueDate ? (
                            <button
                              type="button"
                              onClick={() => {
                                setCalendarSelectedDay(task.dueDate!);
                                setCalendarCursor(
                                  new Date(task.dueDate! + 'T12:00:00')
                                );
                                handleTabChange('calendar');
                              }}
                              className="text-xs text-sky-700 hover:underline"
                            >
                              Show on calendar
                            </button>
                          ) : null}
                        </div>
                        <textarea
                          value={task.notes || ''}
                          onChange={(e) =>
                            void updateTaskLocal(
                              task.id,
                              { notes: e.target.value || undefined },
                              { syncGoogle: false }
                            )
                          }
                          onBlur={() => void flushTaskToGoogle(task.id)}
                          placeholder="Notes"
                          rows={2}
                          className="w-full rounded-xl border border-zinc-100 bg-zinc-50/80 px-3 py-2 text-xs text-zinc-700 resize-none"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => void deleteTask(task.id)}
                        className="text-xs font-medium text-zinc-500 hover:text-red-600 shrink-0"
                      >
                        Delete
                      </button>
                    </div>
                  ))
                )}
              </div>

              {doneTasks.length > 0 ? (
                <div className="space-y-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                    Completed
                  </div>
                  {doneTasks.slice(0, 20).map((task) => (
                    <div
                      key={task.id}
                      className="rounded-2xl border border-zinc-100 bg-zinc-50/80 px-4 py-3 flex items-center gap-3"
                    >
                      <button
                        type="button"
                        aria-label={`Reopen ${task.title}`}
                        onClick={() =>
                          void updateTaskLocal(task.id, { completed: false })
                        }
                        className="w-5 h-5 rounded border border-emerald-500 bg-emerald-500 text-white text-[10px] flex items-center justify-center shrink-0"
                      >
                        ✓
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-zinc-500 line-through truncate">
                          {task.title}
                        </div>
                        {task.dueDate ? (
                          <div className="text-[11px] text-zinc-400 mt-0.5">
                            Due {task.dueDate}
                          </div>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        onClick={() => void deleteTask(task.id)}
                        className="text-xs text-zinc-400 hover:text-red-600"
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
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
            <div className="page-shell page-fade">
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
                  <div className="text-3xl font-semibold tabular-nums text-emerald-700 mt-1">
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
          <div className="page-shell page-fade">
            <div className="mb-8">
              <h1 className="text-3xl font-semibold text-zinc-900 tracking-tight">
                Tools
              </h1>
              <p className="text-zinc-500 mt-1">
                Field tools — more coming soon
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <button
                type="button"
                onClick={() => handleTabChange('tasks')}
                className="text-left bg-white border border-zinc-200 rounded-3xl p-6 sm:p-7 hover:border-sky-300 hover:shadow-sm transition"
              >
                <div className="text-xl font-semibold text-zinc-900 mb-1">
                  Tasks
                </div>
                <p className="text-sm text-zinc-500">
                  Manage to-dos · due dates show on Calendar
                </p>
              </button>
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
          <div className="page-shell page-fade">
            <h1 className="text-3xl font-semibold text-zinc-900 tracking-tight mb-8">
              Profile settings
            </h1>

            <div className="space-y-6">
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
                <h2 className="text-lg font-semibold text-zinc-900">
                  Google Calendar & Tasks
                </h2>

                {gcalConnected ? (
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
                      {gtasksNeedsReconnect ? (
                        <button
                          type="button"
                          disabled={gcalBusy}
                          onClick={() =>
                            void connectGoogleCalendar({
                              forceConsent: true,
                            })
                          }
                          className="btn-primary px-5 py-2.5 rounded-2xl text-sm font-semibold disabled:opacity-50"
                        >
                          Reconnect for Tasks
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={gcalBusy}
                          onClick={() =>
                            void connectGoogleCalendar({ forceConsent: true })
                          }
                          className="px-5 py-2.5 rounded-2xl text-sm font-medium border border-zinc-200 text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                        >
                          Reconnect
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={gcalBusy}
                        onClick={() => void disconnectGoogleCalendar()}
                        className="px-5 py-2.5 rounded-2xl text-sm font-medium border border-zinc-200 text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                      >
                        Disconnect
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <button
                      type="button"
                      disabled={gcalBusy}
                      onClick={() =>
                        void connectGoogleCalendar({ forceConsent: true })
                      }
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
                      Connect Google
                    </button>
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
              </section>

              <section className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6 space-y-4">
                <h2 className="text-lg font-semibold text-zinc-900">Profile</h2>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5">
                    Full name
                  </div>
                  <input
                    value={userName}
                    onChange={(e) => setUserName(e.target.value)}
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-zinc-400 bg-white"
                    placeholder=""
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
                    placeholder=""
                  />
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5">
                    Personal company / LLC
                  </div>
                  <input
                    value={userCompany}
                    onChange={(e) => setUserCompany(e.target.value)}
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-zinc-400 bg-white"
                    placeholder=""
                  />
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5">
                    Phone
                  </div>
                  <PhoneInput
                    value={userPhone}
                    onChange={setUserPhone}
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-zinc-400 bg-white"
                    placeholder=""
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
                    placeholder=""
                    inputMode="email"
                  />
                </div>
              </section>

              <section className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6 space-y-4">
                <h2 className="text-lg font-semibold text-zinc-900">Company</h2>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5">
                    Logo
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex flex-col items-start gap-1.5">
                      {renderAppMark({ size: 'lg' })}
                      {appLogoDataUrl() ? (
                        <button
                          type="button"
                          onClick={() =>
                            setCompanySettings({
                              ...companySettings,
                              logoDataUrl: '',
                              logoPath: '',
                            })
                          }
                          className="text-xs text-zinc-500 hover:text-zinc-800 underline-offset-2 hover:underline"
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                    <label className="inline-flex items-center justify-center btn-primary px-8 py-3 rounded-full text-sm font-semibold cursor-pointer">
                      Upload +
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void handleCompanyLogoFile(f);
                          e.target.value = '';
                        }}
                      />
                    </label>
                  </div>
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5">
                    Company
                  </div>
                  <input
                    value={companySettings.company}
                    onChange={(e) =>
                      setCompanySettings({
                        ...companySettings,
                        company: e.target.value,
                      })
                    }
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-zinc-400 bg-white"
                    placeholder=""
                  />
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5">
                    Project Manager
                  </div>
                  <input
                    value={companySettings.projectManager}
                    onChange={(e) =>
                      setCompanySettings({
                        ...companySettings,
                        projectManager: e.target.value,
                      })
                    }
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-zinc-400 bg-white"
                    placeholder=""
                  />
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5">
                    Project manager phone
                  </div>
                  <PhoneInput
                    value={companySettings.projectManagerPhone}
                    onChange={(v) =>
                      setCompanySettings({
                        ...companySettings,
                        projectManagerPhone: v,
                      })
                    }
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-zinc-400 bg-white"
                    placeholder=""
                  />
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5">
                    Project manager email
                  </div>
                  <input
                    type="email"
                    value={companySettings.projectManagerEmail}
                    onChange={(e) =>
                      setCompanySettings({
                        ...companySettings,
                        projectManagerEmail: e.target.value,
                      })
                    }
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-zinc-400 bg-white"
                    placeholder=""
                    inputMode="email"
                  />
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5">
                    Business address
                  </div>
                  <input
                    value={companySettings.address}
                    onChange={(e) =>
                      setCompanySettings({
                        ...companySettings,
                        address: e.target.value,
                      })
                    }
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-zinc-400 bg-white"
                    placeholder=""
                  />
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5">
                    Office phone
                  </div>
                  <PhoneInput
                    value={companySettings.phone}
                    onChange={(v) =>
                      setCompanySettings({
                        ...companySettings,
                        phone: v,
                      })
                    }
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-zinc-400 bg-white"
                    placeholder=""
                  />
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5">
                    Business fax
                  </div>
                  <PhoneInput
                    value={companySettings.fax}
                    onChange={(v) =>
                      setCompanySettings({
                        ...companySettings,
                        fax: v,
                      })
                    }
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-zinc-400 bg-white"
                    placeholder=""
                  />
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 mb-1.5">
                    ROC#
                  </div>
                  <input
                    value={companySettings.license}
                    onChange={(e) =>
                      setCompanySettings({
                        ...companySettings,
                        license: e.target.value,
                      })
                    }
                    className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-base focus:outline-none focus:border-zinc-400 bg-white"
                    placeholder=""
                  />
                </div>
              </section>

              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <button
                  type="button"
                  onClick={() => void saveUserSettings()}
                  className="btn-primary px-6 py-3 rounded-2xl text-sm font-semibold"
                >
                  Save Settings
                </button>
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
                  <div className="text-center py-16 text-zinc-500">
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
                          const leadName =
                            item.leadLabel ||
                            [
                              item.estimate.clientFirstName,
                              item.estimate.clientLastName,
                            ]
                              .filter(Boolean)
                              .join(' ') ||
                            'Lead';
                          const product = item.estimate.selectedShingle || '';
                          const total = Number(
                            item.estimate.negotiatedPrice ||
                              item.estimate.total ||
                              0
                          );
                          title = `${leadName} · Estimate`;
                          subtitle = [
                            product || null,
                            total > 0
                              ? `$${total.toLocaleString(undefined, {
                                  minimumFractionDigits: 0,
                                  maximumFractionDigits: 0,
                                })}`
                              : null,
                            item.deletedAt || null,
                          ]
                            .filter(Boolean)
                            .join(' · ');
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
                          className="flex items-center justify-between gap-3 p-4 bg-white border border-zinc-200 rounded-xl"
                        >
                          <div className="min-w-0">
                            <div className="font-medium text-zinc-900 truncate">
                              {title}
                            </div>
                            <div className="text-xs text-zinc-500 mt-0.5">
                              {subtitle}
                            </div>
                          </div>
                          <div className="flex gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() => restoreFromTrash(item.id)}
                              className="btn-primary px-4 py-1.5 rounded-full text-sm font-semibold"
                            >
                              Restore
                            </button>
                            <button
                              type="button"
                              onClick={() => permanentlyDelete(item.id)}
                              className="text-xs text-zinc-500 hover:text-red-500/90 shrink-0 px-2 py-1"
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
                              {stageLeads.map((lead, leadIdx) => (
                                <div
                                  key={`board-${lead.id}-${leadIdx}`}
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
            {/* Lead identity — same job shell language as profile */}
            <div className="mb-4 rounded-2xl border border-zinc-200 bg-white px-4 py-3 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="min-w-0 flex items-start gap-3">
                  <button
                    type="button"
                    onClick={() => leaveEstimator({ returnToLead: true })}
                    className="shrink-0 px-3 py-2 rounded-xl text-sm font-medium text-zinc-600 hover:bg-zinc-100 border border-zinc-200 transition-colors"
                  >
                    ← Lead
                  </button>
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
                </div>
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
                    <div className="flex justify-between items-center text-zinc-900 px-2 -mx-2">
                      <div>
                        <div>Labor cost</div>
                        <div className="text-xs text-zinc-500">
                          Crew / production — not customer-facing
                        </div>
                      </div>
                      <div className="font-semibold text-red-600 tabular-nums">
                        -${realLabor.toFixed(2)}
                      </div>
                    </div>
                    <div className="flex justify-between items-center text-zinc-900 px-2 -mx-2">
                      <div>
                        <div>Material cost</div>
                        <div className="text-xs text-zinc-500">
                          What you pay for product
                        </div>
                      </div>
                      <div className="font-semibold text-red-600 tabular-nums">
                        -${realMaterial.toFixed(2)}
                      </div>
                    </div>
                    <div
                      onClick={() => setShowCostBreakdown(!showCostBreakdown)}
                      className="flex justify-between items-center cursor-pointer hover:bg-zinc-100 p-2 rounded-2xl -mx-2 text-zinc-900"
                    >
                      <div className="font-semibold">Total job cost</div>
                      <div className="font-semibold tabular-nums">
                        -${(realLabor + realMaterial).toFixed(2)}
                      </div>
                    </div>
                    <p className="text-xs text-zinc-500 px-2 -mx-2">
                      Sell price is customer-facing. Labor + materials stay
                      internal — never on the estimate PDF.
                    </p>
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
                        className="btn-primary px-8 py-3 rounded-full text-sm font-semibold"
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
                    className="btn-primary px-8 py-3 rounded-full text-sm font-semibold"
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
                    <option value="0.05">5%</option><option value="0.06">6%</option><option value="0.07">7%</option><option value="0.08">8%</option><option value="0.09">9%</option><option value="0.10">10%</option><option value="0.11">11%</option><option value="0.12">12%</option><option value="0.13">13%</option><option value="0.14">14%</option><option value="0.15">15%</option><option value="0.16">16%</option><option value="0.18">18%</option><option value="0.20">20%</option><option value="0.22">22%</option><option value="0.25">25%</option>
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
                {/* Solar Panels */}
                <div className="bg-white border border-zinc-200 rounded-3xl p-5">
                  <div className="mb-3">
                    <div className="font-semibold text-zinc-900">Solar Panels</div>
                    <div className="text-xs text-amber-700/80 mt-0.5">
                      Total solar panels
                    </div>
                  </div>
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

                {/* HVAC */}
                <div className="bg-white border border-zinc-200 rounded-3xl p-5">
                  <div className="mb-3">
                    <div className="font-semibold text-zinc-900">HVAC</div>
                    <div className="text-xs text-amber-700/80 mt-0.5">
                      Detach and reset
                    </div>
                  </div>
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

                {/* Skylights */}
                <div className="bg-white border border-zinc-200 rounded-3xl p-5">
                  <div className="mb-3">
                    <div className="font-semibold text-zinc-900">Skylights</div>
                    <div className="text-xs text-amber-700/80 mt-0.5">
                      Detach and reset
                    </div>
                  </div>
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

                {/* Ridge Vent */}
                <div className="bg-white border border-zinc-200 rounded-3xl p-5">
                  <div className="mb-3">
                    <div className="font-semibold text-zinc-900">Ridge Vent</div>
                    <div className="text-xs text-amber-700/80 mt-0.5">
                      Total LF of ridge vent
                    </div>
                  </div>
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
              <div className="w-full max-w-6xl mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs text-zinc-500">TOTAL PRICE</div>
                  {selectedShingle === '' ? (
                    <div className="text-2xl font-semibold text-zinc-400">
                      Select a product to view pricing
                    </div>
                  ) : (
                    <>
                      <div className="text-5xl font-semibold text-emerald-700 tabular-nums">
                        ${estimatorTotalPrice.toLocaleString()}
                      </div>
                      {bufferUsed > 0 && (
                        <div className="text-xs text-amber-700 mt-0.5">
                          List $
                          {originalTotalForBuffer.toLocaleString()} · discount $
                          {bufferUsed.toLocaleString()}
                        </div>
                      )}
                    </>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setShowProfessionalEstimate(true)}
                  className="btn-primary px-8 py-4 rounded-3xl font-semibold w-full sm:w-auto sm:shrink-0"
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
              const profileDocuments = (profileLead?.documents || []).filter(
                (d) => !isEstimatePdfDocument(d)
              );
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

              const tabs: { id: ProfileTab; label: string }[] = [
                { id: 'overview', label: 'Overview' },
                { id: 'pipeline', label: 'Pipeline' },
                { id: 'measurements', label: 'Measurements' },
                { id: 'financial', label: 'Financial' },
                { id: 'insurance', label: 'Insurance' },
                { id: 'notes', label: 'Messages' },
                { id: 'estimates', label: 'Estimates' },
                { id: 'photos', label: 'Photos' },
                { id: 'documents', label: 'Documents' },
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
                            ← Pipeline
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
                            </div>

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
                                          className="text-xs text-zinc-500 hover:text-red-500/90 shrink-0 px-2 py-1"
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
                          <div className="flex items-center justify-between gap-3 mb-3">
                            <h2 className="text-lg font-semibold text-zinc-900 mb-4">
                                Pipeline
                              </h2>
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
                            <div className="text-sm text-zinc-800 flex items-center gap-2 flex-wrap">
                              <span className="font-medium">Current status:</span>
                              <span
                                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${PIPELINE_STAGE_STYLES[leadCategory]?.badge || 'bg-zinc-100 text-zinc-700 border-zinc-200'}`}
                              >
                                <span
                                  className={`w-2 h-2 rounded-full ${PIPELINE_STAGE_STYLES[leadCategory]?.dash || 'bg-zinc-400'}`}
                                  aria-hidden
                                />
                                {leadCategory}
                              </span>
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
                              const styles = PIPELINE_STAGE_STYLES[stage];
                              return (
                                <li key={stage}>
                                  <button
                                    type="button"
                                    onClick={() => setLeadMilestone(stage)}
                                    className={`w-full text-left flex items-center gap-4 rounded-2xl border px-4 py-3.5 transition-colors ${
                                      current
                                        ? `bg-white shadow-sm ring-2 ${styles.ring} border-zinc-300`
                                        : done
                                          ? 'border-zinc-200 bg-white hover:border-zinc-300'
                                          : 'border-zinc-100 bg-zinc-100/80 hover:border-zinc-200'
                                    }`}
                                  >
                                    <div
                                      className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${
                                        current
                                          ? `${styles.dash} text-white`
                                          : done
                                            ? 'bg-zinc-200 text-zinc-700'
                                            : 'bg-white border border-zinc-200 text-zinc-400'
                                      }`}
                                    >
                                      {idx + 1}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-2">
                                        <span
                                          className={`w-2.5 h-2.5 rounded-full shrink-0 ${styles.dash}`}
                                          aria-hidden
                                        />
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
                                      </div>
                                      <div className="text-xs text-zinc-500 mt-0.5">
                                        {current
                                          ? 'Current milestone'
                                          : done
                                            ? 'Completed'
                                            : 'Upcoming'}
                                      </div>
                                    </div>
                                    {current && (
                                      <span
                                        className={`shrink-0 text-xs font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full border ${styles.badge}`}
                                      >
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
                        <section className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6">
                          <h2 className="text-lg font-semibold text-zinc-900 mb-4">
                            Measurements
                          </h2>

                        <div className="w-full space-y-5">
                          {/* Read-only property address from lead profile */}
                          <div className="rounded-2xl border border-zinc-100 bg-zinc-100/80 px-4 py-3.5">
                            <div className="flex items-center justify-between gap-3 mb-4">
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
                            <div className="rounded-3xl bg-zinc-100 border border-zinc-100 px-6 py-12 text-center space-y-5">
                              <div className="space-y-1">
                                <p className="text-sm font-medium text-zinc-800">
                                  Get the roof numbers
                                </p>
                                <p className="text-sm text-zinc-500 max-w-md mx-auto">
                                  {hasProfileAddress
                                    ? 'Upload an EagleView when you have one. Otherwise auto-measure or trace the roof on the map.'
                                    : 'Add a property address on Overview first, then measure.'}
                                </p>
                              </div>

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
                                  onClick={() =>
                                    measurementFileRef.current?.click()
                                  }
                                  className="btn-primary px-7 py-3 rounded-full text-sm font-semibold"
                                  title="Upload EagleView / Roofr PDF — fills squares, pitch, ridge, hip, eave, rake"
                                >
                                  Upload EagleView
                                </button>
                                <button
                                  type="button"
                                  disabled={solarMeasuring || !hasProfileAddress}
                                  onClick={() => void runSolarAutoMeasure()}
                                  className="px-7 py-3 rounded-full text-sm font-semibold border border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
                                  title="Instant Roofer AI (~$1–3) when your key is enabled"
                                >
                                  {solarMeasuring ? 'Measuring…' : 'Auto-measure'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (!hasProfileAddress) {
                                      setProfileTab('overview');
                                      showToast(
                                        'Add a property address under Overview first'
                                      );
                                      return;
                                    }
                                    void startNewMeasurementOnLead();
                                  }}
                                  className="px-7 py-3 rounded-full text-sm font-semibold border border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50"
                                >
                                  {hasProfileAddress
                                    ? 'Trace on map'
                                    : 'Add address first'}
                                </button>
                              </div>

                              <div className="relative inline-flex justify-center">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setMeasureMoreOpen((o) => !o)
                                  }
                                  className="text-sm font-medium text-zinc-500 hover:text-zinc-800 px-3 py-1.5"
                                >
                                  More options
                                </button>
                                {measureMoreOpen && (
                                  <div className="absolute top-full mt-1 z-20 min-w-[220px] rounded-2xl border border-zinc-200 bg-white shadow-lg p-1.5 text-left">
                                    <button
                                      type="button"
                                      disabled={
                                        humanOrdering || !hasProfileAddress
                                      }
                                      onClick={() => {
                                        setMeasureMoreOpen(false);
                                        void orderHumanCertifiedMeasure();
                                      }}
                                      className="w-full text-left px-3 py-2.5 rounded-xl text-sm text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
                                      title="Instant Roofer Human Certified (~$10, ~1 hour) — includes ridge/hip/eave/rake"
                                    >
                                      {humanOrdering
                                        ? 'Ordering…'
                                        : 'Order human report (~$10)'}
                                    </button>
                                    <p className="px-3 pb-2 text-[11px] text-zinc-400 leading-snug">
                                      Optional when you need certified edges and
                                      don’t have an EagleView.
                                    </p>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}

                          {humanOrders.length > 0 && (
                            <div className="rounded-2xl border border-zinc-200 bg-white p-4 space-y-2">
                              <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                                Instant Roofer human orders
                              </div>
                              {humanOrders.slice(0, 5).map((o) => (
                                <div
                                  key={o.id}
                                  className="flex items-center gap-2 rounded-xl border border-zinc-100 px-3 py-2.5"
                                >
                                  <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium text-zinc-900 truncate">
                                      {o.address || 'Human Certified'}
                                    </div>
                                    <div className="text-xs text-zinc-400">
                                      {o.status}
                                      {o.failureReason ? ` · ${o.failureReason}` : ''}
                                    </div>
                                  </div>
                                  {o.reportUrl ? (
                                    <a
                                      href={o.reportUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-sm font-semibold text-sky-700 hover:underline shrink-0"
                                    >
                                      Open
                                    </a>
                                  ) : (
                                    <span className="text-xs text-zinc-400 shrink-0">
                                      ~1 hr
                                    </span>
                                  )}
                                </div>
                              ))}
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
                                      className="text-xs text-zinc-500 hover:text-red-500/90 shrink-0 px-2 py-1"
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

                              {autoMeasureHint && (
                                <p className="text-xs text-center text-zinc-600 bg-zinc-100 rounded-xl px-3 py-2">
                                  {autoMeasureHint}
                                </p>
                              )}

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
                                        className="text-xs text-zinc-500 hover:text-red-500/90 shrink-0 px-2 py-1"
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
                                        {(sessionReport.ridgeLF || 0) > 0
                                          ? `${sessionReport.ridgeLF} lf`
                                          : '—'}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[11px] text-zinc-400 font-medium">
                                        Eave
                                      </div>
                                      <div className="text-base font-semibold tabular-nums text-zinc-800 mt-0.5">
                                        {(sessionReport.eaveLF || 0) > 0
                                          ? `${sessionReport.eaveLF} lf`
                                          : '—'}
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
                              {[...profileMeasurements].reverse().map((m, mIdx) => (
                                <div
                                  key={`meas-${m.id}-${mIdx}`}
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
                                      className="btn-primary px-8 py-3 rounded-full text-sm font-semibold disabled:opacity-50"
                                    >
                                      Apply
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => deleteRoofMeasurement(m.id)}
                                    className="text-xs text-zinc-500 hover:text-red-500/90 shrink-0 px-2 py-1 self-center"
                                  >
                                    Delete
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        
                        </section>);
                      })()}

                      {profileTab === 'financial' && (
                        <section className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6">
                        <div className="space-y-4">
                          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                            <div className="lg:col-span-2 space-y-3">
                              <div className="flex items-center justify-between gap-3 mb-4">
                                <h2 className="text-lg font-semibold text-zinc-900 mb-4">
                                  Worksheet
                                </h2>
                                <div className="relative">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setFinSectionMenuOpen((o) => !o)
                                    }
                                    className="text-sm font-medium text-sky-600 hover:underline"
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
                                        className="text-xs font-medium text-sky-600"
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
                                        className="text-xs text-zinc-500 hover:text-red-500/90 shrink-0 px-2 py-1"
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
                                            className="text-xs text-zinc-500 hover:text-red-500/90 shrink-0 px-2 py-1 self-center"
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
                                  <span className="font-semibold text-emerald-700 tabular-nums">
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
                              <div className="rounded-2xl border-2 border-sky-500 bg-white p-4">
                                <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
                                  Approved job value
                                </div>
                                <div className="text-xl font-semibold text-emerald-700 tabular-nums">
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
                                <div className="text-lg font-semibold text-red-500/90 tabular-nums">
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
                        </section>
                      )}

                      {profileTab === 'insurance' && (
                        <section className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6">
                          <h2 className="text-lg font-semibold text-zinc-900 mb-4">
                            Insurance claim
                          </h2>
                          
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
                            <div>
                              <div className={labelClass}>Adjustment date</div>
                              <input
                                type="date"
                                value={adjustmentDate}
                                onChange={(e) => setAdjustmentDate(e.target.value)}
                                className={fieldClass}
                              />
                            </div>
                            <div>
                              <div className={labelClass}>Adjustment time</div>
                              <input
                                type="time"
                                value={adjustmentTime}
                                onChange={(e) => setAdjustmentTime(e.target.value)}
                                className={fieldClass}
                              />
                            </div>
                          </div>

                        </section>
                      )}

                      {profileTab === 'notes' && (
                        <section className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6">
                          <h2 className="text-lg font-semibold text-zinc-900 mb-4">
                            Messages
                          </h2>
                          
                          <div className="flex flex-col sm:flex-row gap-2 mb-6 items-center">
                            <input
                              value={leadNoteDraft}
                              onChange={(e) => setLeadNoteDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  addLeadNote();
                                }
                              }}
                              placeholder="Add a message about this lead..."
                              className={`${fieldClass} flex-1`}
                            />
                            <button
                              type="button"
                              onClick={addLeadNote}
                              className="btn-primary px-8 py-3 rounded-full text-sm font-semibold shrink-0"
                            >
                              Add message
                            </button>
                          </div>
                          <div className="space-y-3">
                            {profileNotes.length > 0 ? (
                              [...profileNotes].reverse().map((note, reverseIndex) => {
                                const noteIndex =
                                  profileNotes.length - 1 - reverseIndex;
                                return (
                                <div
                                  key={note.id || `${note.date}-${noteIndex}`}
                                  className="relative pl-6 border-l-2 border-zinc-200"
                                >
                                  <div className="absolute -left-[7px] top-1.5 w-3 h-3 rounded-full bg-zinc-400 border-2 border-white shadow" />
                                  <div className="bg-zinc-100 rounded-2xl p-4 text-sm flex items-center justify-between gap-3">
                                    <div className="min-w-0 flex-1">
                                      <div className="text-zinc-500 text-xs font-medium mb-1">
                                        {note.date}
                                      </div>
                                      <div className="whitespace-pre-wrap text-zinc-800">
                                        {note.text}
                                      </div>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => removeLeadNote(noteIndex)}
                                      className="text-xs text-zinc-500 hover:text-red-500/90 shrink-0 px-2 py-1 self-center"
                                    >
                                      Delete
                                    </button>
                                  </div>
                                </div>
                                );
                              })
                            ) : (
                              <div className="text-zinc-400 py-10 text-center rounded-2xl border border-dashed border-zinc-200">
                                No messages yet — add the first update above.
                              </div>
                            )}
                          </div>
                        </section>
                      )}

                      {profileTab === 'estimates' && (
                        <section className="bg-white border border-zinc-200 rounded-3xl p-5 sm:p-6">
                          <div className="flex items-center justify-between gap-3 mb-3">
                            <h2 className="text-lg font-semibold text-zinc-900 mb-4">
                                Estimates
                              </h2>
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
                                  key={`est-${est.id ?? 'n'}-${index}`}
                                  className="w-full border border-zinc-200 rounded-2xl p-5 hover:border-sky-300 hover:bg-zinc-100 transition-colors"
                                >
                                  <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
                                    <button
                                      type="button"
                                      className="text-left min-w-0 flex-1 items-center"
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
                                    <div className="flex items-center gap-2 shrink-0">
                                      <div className="text-xl font-semibold text-emerald-700">
                                        $
                                        {(
                                          est.negotiatedPrice ||
                                          est.total ||
                                          0
                                        ).toLocaleString()}
                                      </div>
                                      {est.pdfUrl ? (
                                        <a
                                          href={est.pdfUrl}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="text-xs font-semibold text-sky-700 hover:underline px-2 py-1"
                                        >
                                          PDF
                                        </a>
                                      ) : null}
                                      <button
                                        type="button"
                                        onClick={() =>
                                          removeLeadEstimate(est.id, index)
                                        }
                                        className="text-xs text-zinc-500 hover:text-red-500/90 shrink-0 px-2 py-1"
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
                          <div className="flex items-center justify-between gap-3 mb-3">
                            <h2 className="text-lg font-semibold text-zinc-900 mb-4">Photos</h2>
                            {profilePhotos.length > 0 && (
                              <div className="text-sm font-medium text-zinc-500 bg-zinc-100 border border-zinc-200 rounded-xl px-3 py-1.5 self-start">
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
                                className="btn-primary px-8 py-3 rounded-full text-sm font-semibold disabled:opacity-50"
                              >
                                {photosUploading ? 'Working…' : 'Take photo'}
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openPhotoReportBuilder();
                                }}
                                className="btn-primary px-8 py-3 rounded-full text-sm font-semibold"
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
                                className="btn-primary px-8 py-3 rounded-full text-sm font-semibold disabled:opacity-50"
                              >
                                {photosUploading ? 'Working…' : 'Upload photos'}
                              </button>
                            </div>
                          </div>

                          {profilePhotos.length > 0 ? (
                            <div className="mt-6">
                              <div className="flex items-center justify-between mb-3">
                                <div className="text-sm text-zinc-500">
                                  Thumbnail grid · tap to enlarge · Delete to remove
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
                                      className="text-xs text-zinc-500 hover:text-red-500/90 shrink-0 px-2 py-1"
                                      aria-label={`Delete ${photo.name}`}
                                    >
                                      Delete
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

                          <div className="flex items-center justify-between gap-3 mb-3">
                            <h2 className="text-lg font-semibold text-zinc-900 mb-4">
                                Documents
                              </h2>
                            <div className="relative shrink-0">
                              <button
                                type="button"
                                disabled={docsUploading}
                                onClick={() => setDocAddMenuOpen((o) => !o)}
                                className="inline-flex items-center justify-center btn-primary px-8 py-3 rounded-full text-sm font-semibold disabled:opacity-50"
                              >
                                {docsUploading ? 'Uploading…' : '+ Add'}
                              </button>
                              
      
      
      
      
      
      {docAddMenuOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
          onClick={() => setDocAddMenuOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white border border-zinc-200 shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100">
              <div className="text-base font-semibold text-zinc-900">Add document</div>
              <button
                type="button"
                className="text-xs text-zinc-500 hover:text-red-500/90 shrink-0 px-2 py-1"
                onClick={() => setDocAddMenuOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="p-2">
              <button
                type="button"
                className="w-full text-left px-4 py-3 rounded-xl text-sm font-medium text-zinc-900 hover:bg-zinc-50"
                onClick={() => {
                  setDocAddMenuOpen(false);
                  docInputRef.current?.click();
                }}
              >
                Upload file
              </button>
              <button
                type="button"
                className="w-full text-left px-4 py-3 rounded-xl text-sm font-medium text-zinc-900 hover:bg-zinc-50"
                onClick={() => {
                  setDocAddMenuOpen(false);
                  openMitigationWorkspace('personal');
                }}
              >
                Mitigation invoice
              </button>
              <button
                type="button"
                className="w-full text-left px-4 py-3 rounded-xl text-sm font-medium text-zinc-900 hover:bg-zinc-50"
                onClick={() => {
                  setDocAddMenuOpen(false);
                  openEmergencyAgreement(currentLeadId);
                }}
              >
                Mitigation Service Agreement
              </button>
              <button
                type="button"
                className="w-full text-left px-4 py-3 rounded-xl text-sm font-medium text-zinc-900 hover:bg-zinc-50"
                onClick={() => {
                  openSystemDoc('takeoff');
                }}
              >
                Take off sheet
              </button>
              <button
                type="button"
                className="w-full text-left px-4 py-3 rounded-xl text-sm font-medium text-zinc-900 hover:bg-zinc-50"
                onClick={() => {
                  openSystemDoc('pricing');
                }}
              >
                Company pricing
              </button>
            </div>
          </div>
        </div>
      )}






                            </div>
                          </div>

                          {profileDocuments.length === 0 ? (
                            <div className="rounded-2xl border border-dashed border-zinc-200 px-6 py-12 text-center">
                              <p className="text-sm font-medium text-zinc-800">
                                No documents yet
                              </p>
                              <p className="text-sm text-zinc-500 mt-2">
                                Use + Add to upload a file or pick a company document.
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
                                      className="text-sm font-medium hover:underline truncate block text-left w-full text-zinc-800 hover:text-sky-600 transition-colors"
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
                                    className="text-xs text-zinc-500 hover:text-red-500/90 shrink-0 px-2 py-1"
                                  >
                                    Delete
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
                                className="px-4 py-2 rounded-xl border-2 border-sky-500 bg-white text-sky-700 text-sm font-medium hover:bg-sky-50"
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
                                  <label className="text-sm text-zinc-500 mb-1.5 block">
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
                                  <label className="text-sm text-zinc-500 mb-1.5 block">
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
              <div className="px-5 py-3 border-b border-zinc-50 space-y-3">
                <input
                  value={photoReportTitle}
                  onChange={(e) => setPhotoReportTitle(e.target.value)}
                  className="w-full border border-zinc-200 rounded-2xl px-4 py-2.5 text-sm text-zinc-900"
                  placeholder="Report title"
                />
                <label className="flex items-start gap-3 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={photoReportIncludeBranding}
                    onChange={(e) =>
                      setPhotoReportIncludeBranding(e.target.checked)
                    }
                    className="mt-1 rounded border-zinc-300"
                  />
                  <span>
                    <span className="block text-sm font-medium text-zinc-900">
                      Include logo & company
                    </span>
                    <span className="block text-xs text-zinc-500 mt-0.5">
                      Turn off for a bland report (e.g. personal LLC mitigation
                      + service agreement).
                    </span>
                  </span>
                </label>
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
                        className="text-xs text-zinc-500 hover:text-red-500/90 shrink-0 px-2 py-1 self-center"
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