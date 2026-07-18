'use client';
import { useState, useEffect, useRef } from 'react';
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

type ShingleType = 'cambridge' | 'dynasty' | 'armourshake' | '';
type FasciaMode = 'repair' | 'full' | '';
type DeckingMode = 'repair' | 'full' | '';
type FasciaType = '2x6' | '2x8' | '';
type Underlayment = 'standard' | 'high-temp' | '';

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
  solarPanels: string;
  hvacUnits: string;
  skylights: string;
  ridgeVentLF: string;
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
};

type LeadNote = {
  text: string;
  date: string;
};

/** Base64 data-URL previews for now; migrate to Supabase storage for 500+ photos later. */
type LeadPhoto = {
  id: string;
  name: string;
  dataUrl: string;
  createdAt: string;
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
  | 'documents';

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
  measurements?: RoofMeasurement[];
  /** Optional scheduled follow-up (YYYY-MM-DD) — used for Google Calendar sync */
  followUpDate?: string;
  /** Google Calendar event id after sync */
  calendarEventId?: string;
  calendarHtmlLink?: string;
  calendarSyncedAt?: string;
};

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
    measurements: Array.isArray(raw.measurements)
      ? (raw.measurements
          .map((m) => normalizeMeasurement(m as Partial<RoofMeasurement>))
          .filter(Boolean) as RoofMeasurement[])
      : [],
    followUpDate: raw.followUpDate ?? '',
    calendarEventId: raw.calendarEventId,
    calendarHtmlLink: raw.calendarHtmlLink,
    calendarSyncedAt: raw.calendarSyncedAt,
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
    measurements: [],
    ...overrides,
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
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
  const [selectedShingle, setSelectedShingle] = useState<ShingleType>('');
  const [cambridgeColor, setCambridgeColor] = useState('');
  const [dynastyColor, setDynastyColor] = useState('');
  const [armourshakeColor, setArmourshakeColor] = useState('');
  const [selectedUnderlayment, setSelectedUnderlayment] = useState<Underlayment>('');
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
  const [solarPanels, setSolarPanels] = useState('');
  const [hvacUnits, setHvacUnits] = useState('');
  const [skylights, setSkylights] = useState('');
  const [ridgeVentLF, setRidgeVentLF] = useState('');
  const [notes, setNotes] = useState('');
  const [leadNoteDraft, setLeadNoteDraft] = useState('');
  const [isEditingLead, setIsEditingLead] = useState(false);
  const [profileTab, setProfileTab] = useState<ProfileTab>('overview');
  const [photoDragOver, setPhotoDragOver] = useState(false);
  const [photosUploading, setPhotosUploading] = useState(false);
  const [lightboxPhoto, setLightboxPhoto] = useState<LeadPhoto | null>(null);
  const [dragLeadId, setDragLeadId] = useState<number | null>(null);
  const [dragOverStage, setDragOverStage] = useState<PipelineStage | null>(null);
  const suppressCardClickRef = useRef(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
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
  const [trash, setTrash] = useState<Lead[]>([]);
  const [leadsView, setLeadsView] = useState<'active' | 'trash'>('active');
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

  const FLOOR_PRICES: Record<Exclude<ShingleType, ''>, number> = {
    cambridge: 485,
    dynasty: 500,
    armourshake: 685,
  };

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
    const basePerSq = selectedShingle ? FLOOR_PRICES[selectedShingle] : 500;
    let layerAdder = 0;
    if (ly === 2) layerAdder = 15;
    if (ly === 3) layerAdder = 30;
    if (ly === 4) layerAdder = 45;
    let pitchAdder = 0;
    if (['8/12','9/12','10/12','11/12','12/12'].includes(pt)) pitchAdder = 15;
    let underlaymentAdder = 0;
    const isLowSlope = ['2/12', '3/12'].includes(pt);
    if (selectedUnderlayment && (selectedUnderlayment === 'high-temp' || isLowSlope)) {
      underlaymentAdder = sq * 8;
      if (isLowSlope) underlaymentAdder += sq * 8;
    }
    let fasciaAdder = 0;
    if (flf > 10 && fasciaType) {
      const rate = fasciaType === '2x8'
        ? (fasciaMode === 'full' ? 15 : 17)
        : (fasciaMode === 'full' ? 13.5 : 15.5);
      fasciaAdder = (flf - 10) * rate;
    }
    let deckingAdder = 0;
    let sheetsNeeded = 0;
    if (deckingMode === 'full') {
      sheetsNeeded = Math.ceil(roofAreaSqFt / 32);
      deckingAdder = sheetsNeeded * 60;
    } else if (deckingMode === 'repair' && dsh > 2) {
      deckingAdder = (dsh - 2) * 75;
    }
    const solarAdder = panels * 250;
    const hvacAdder = hvac * 1500;
    const skylightAdder = sky * 575;
    const ridgeAdder = ridge * 16;
    const mbAdder = mbSq * 600;

    const baseRoofPrice = Math.round(baseRoofArea * (basePerSq + layerAdder + pitchAdder) + underlaymentAdder);
    const internalCost = baseRoofPrice + fasciaAdder + deckingAdder + solarAdder + hvacAdder + skylightAdder + ridgeAdder + mbAdder;
    const hasRealData = sq > 0 && selectedShingle !== '';
    const total = hasRealData ? Math.round(internalCost + 3500) : 0;

    return { 
      total, 
      baseRoofPrice, 
      fasciaCost: fasciaAdder, 
      deckingCost: deckingAdder,
      solarCost: solarAdder,
      hvacCost: hvacAdder,
      skylightCost: skylightAdder,
      ridgeCost: ridgeAdder,
      mbCost: mbAdder,
      sheetsNeeded 
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
      if (savedLeads) {
        const parsed = JSON.parse(savedLeads) as Array<
          Partial<Lead> & { clientJobNumber?: string }
        >;
        setLeads(parsed.map(normalizeLead));
      }
      if (savedTrash) {
        const parsed = JSON.parse(savedTrash) as Array<
          Partial<Lead> & { clientJobNumber?: string }
        >;
        setTrash(parsed.map(normalizeLead));
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
  }, []);

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

  // Material (includes MB adders)
  let realMaterial = 0;
  if (selectedShingle === 'dynasty') realMaterial += sq * 31.33 * 3;
  if (selectedShingle === 'cambridge') realMaterial += sq * 29.67 * 3;
  if (selectedShingle === 'armourshake') realMaterial += sq * 48 * 5;
  realMaterial += ridge * 6;
  realMaterial += mbSq * 123;
  realMaterial += (mbSq * 2) * 126;

  // Labor (includes HVAC / solar adders)
  let realLabor = sq * 100;
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
  } else if (deckingMode === 'repair' && dsh > 2) {
    realLabor += (dsh - 2) * 20;
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
  const mbCapMaterial = mbSq * 123;
  const mbBasePlyMaterial = (mbSq * 2) * 126;
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
      solarPanels,
      hvacUnits,
      skylights,
      ridgeVentLF,
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
    setLeads(updatedLeads);
    localStorage.setItem('summitLeads', JSON.stringify(updatedLeads));
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
    setSolarPanels('');
    setHvacUnits('');
    setSkylights('');
    setRidgeVentLF('');
    setNotes('');
    setSelectedShingle('');
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
    if (!confirm('Delete this measurement?')) return;
    const updated = leads.map((lead) =>
      lead.id === currentLeadId
        ? {
            ...lead,
            measurements: (lead.measurements || []).filter((m) => m.id !== measurementId),
          }
        : lead
    );
    persistLeads(updated);
    if (selectedMeasurementId === measurementId) setSelectedMeasurementId(null);
    if (activeMeasurementId === measurementId) setActiveMeasurementId(null);
    showToast('Measurement deleted');
  };

  /** Open estimate (or internal) workspace inside a lead profile. */
  const enterLeadEstimator = (
    leadId: number,
    workspace: EstimateWorkspace = 'estimate'
  ) => {
    setShowEstimatePicker(false);
    setShowProfessionalEstimate(false);
    setShowMeasureAddressModal(false);
    setHubReport(null);
    setEstimatorSourceLeadId(leadId);
    setCurrentLeadId(leadId);
    setIsEditingLead(true);
    setActiveTab('leads');
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
    setSolarPanels(estimate.solarPanels || '');
    setHvacUnits(estimate.hvacUnits || '');
    setSkylights(estimate.skylights || '');
    setRidgeVentLF(estimate.ridgeVentLF || '');
    setSelectedShingle(estimate.selectedShingle || '');
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
      enterLeadEstimator(linkId, 'estimate');
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
    solarPanels,
    hvacUnits,
    skylights,
    ridgeVentLF,
    notes,
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
    negotiatedPrice,
  ]);

  const showToast = (message: string) => {
    setToastMessage(message);
    window.setTimeout(() => setToastMessage(null), 2500);
  };

  const persistLeads = (updated: Lead[]) => {
    setLeads(updated);
    localStorage.setItem('summitLeads', JSON.stringify(updated));
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

  const addNewLead = () => {
    const newLead = createEmptyLead({
      category: 'Lead',
      clientFirstName: '',
      clientLastName: '',
    });
    const updated = [newLead, ...leads];
    persistLeads(updated);
    showToast('New lead created — opening profile');
    setLeadsView('active');
    setLeadsSearch('');
    window.setTimeout(() => {
      openLeadProfile(newLead.id, newLead);
    }, 80);
  };

  const createNewLead = addNewLead;

  const moveToTrash = (leadId: number) => {
    const leadToMove = leads.find((l) => l.id === leadId);
    if (!leadToMove) return;
    if (
      !confirm(
        `Move “${[leadToMove.clientFirstName, leadToMove.clientLastName].filter(Boolean).join(' ') || 'this lead'}” to trash?`
      )
    ) {
      return;
    }
    const newLeads = leads.filter((l) => l.id !== leadId);
    const newTrash = [...trash, leadToMove];
    setLeads(newLeads);
    setTrash(newTrash);
    localStorage.setItem('summitLeads', JSON.stringify(newLeads));
    localStorage.setItem('summitTrash', JSON.stringify(newTrash));
    if (currentLeadId === leadId) {
      setIsEditingLead(false);
      setCurrentLeadId(null);
      setLightboxPhoto(null);
    }
    showToast('Lead moved to trash');
  };

  const restoreFromTrash = (leadId: number) => {
    const leadToRestore = trash.find((l) => l.id === leadId);
    if (!leadToRestore) return;
    const newTrash = trash.filter((l) => l.id !== leadId);
    const newLeads = [...leads, leadToRestore];
    setTrash(newTrash);
    setLeads(newLeads);
    localStorage.setItem('summitLeads', JSON.stringify(newLeads));
    localStorage.setItem('summitTrash', JSON.stringify(newTrash));
    showToast('Lead restored');
  };

  const permanentlyDelete = (leadId: number) => {
    if (!confirm('Permanently delete this lead? This cannot be undone.')) return;
    const newTrash = trash.filter((l) => l.id !== leadId);
    setTrash(newTrash);
    localStorage.setItem('summitTrash', JSON.stringify(newTrash));
    showToast('Lead permanently deleted');
  };

  const emptyTrash = () => {
    if (trash.length === 0) return;
    if (!confirm(`Permanently empty trash (${trash.length} lead${trash.length === 1 ? '' : 's'})?`)) {
      return;
    }
    setTrash([]);
    localStorage.setItem('summitTrash', JSON.stringify([]));
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

  const handlePhotoFiles = async (fileList: FileList | File[]) => {
    if (!currentLeadId || photosUploading) return;
    const imageFiles = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length === 0) {
      showToast('Please select image files');
      return;
    }
    setPhotosUploading(true);
    try {
      // Sequential read keeps memory calmer for large multi-select batches
      const newPhotos: LeadPhoto[] = [];
      const stamp =
        new Date().toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }) +
        ' ' +
        new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      for (let i = 0; i < imageFiles.length; i++) {
        const file = imageFiles[i];
        newPhotos.push({
          id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 9)}`,
          name: file.name,
          dataUrl: await readFileAsDataUrl(file),
          createdAt: stamp,
        });
      }
      const updatedLeads = leads.map((lead) =>
        lead.id === currentLeadId
          ? { ...lead, photos: [...(lead.photos || []), ...newPhotos] }
          : lead
      );
      persistLeads(updatedLeads);
      showToast(
        newPhotos.length === 1 ? '1 photo added' : `${newPhotos.length} photos added`
      );
    } catch {
      showToast('Failed to read photo(s)');
    } finally {
      setPhotosUploading(false);
    }
  };

  const removeLeadPhoto = (photoId: string) => {
    if (!currentLeadId) return;
    const updatedLeads = leads.map((lead) =>
      lead.id === currentLeadId
        ? { ...lead, photos: (lead.photos || []).filter((p) => p.id !== photoId) }
        : lead
    );
    persistLeads(updatedLeads);
    if (lightboxPhoto?.id === photoId) setLightboxPhoto(null);
    showToast('Photo removed');
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

  const saveLeadProfile = () => {
    if (!saveLeadDraft({ silent: true })) return;
    // Stay on dedicated full-screen profile after save (AccuLynx-style)
    setIsEditingLead(true);
    setActiveTab('leads');
    showToast('Lead profile saved');
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

  const toggleShingle = (type: Exclude<ShingleType, ''>) => {
    setSelectedShingle(selectedShingle === type ? '' : type);
  };

  const toggleFascia = (mode: Exclude<FasciaMode, ''>) => setFasciaMode(fasciaMode === mode ? '' : mode);
  const toggleDecking = (mode: Exclude<DeckingMode, ''>) => setDeckingMode(deckingMode === mode ? '' : mode);

  // Live lead contact for estimate UI + PDF (never typed on the estimate form)
  const estimatorClient = resolveEstimatorClient();

  const getShingleDisplayName = () => {
    if (selectedShingle === 'cambridge') return 'Cambridge';
    if (selectedShingle === 'dynasty') return 'Dynasty';
    if (selectedShingle === 'armourshake') return 'Armourshake';
    return '';
  };

  const getShingleColor = () => {
    if (selectedShingle === 'dynasty') return dynastyColor || 'Color Selected';
    if (selectedShingle === 'cambridge') return cambridgeColor || 'Color Selected';
    if (selectedShingle === 'armourshake') return armourshakeColor || 'Color Selected';
    return 'Color Selected';
  };

  const getUnderlaymentLabel = () => {
    if (selectedUnderlayment === 'high-temp') {
      return 'Install TopShield Bigfoot 30 High-Temp Synthetic Underlayment';
    }
    return 'Install TopShield Securegrip 30 Full Synthetic Underlayment';
  };

  const buildScopeOfWork = () => {
    const mbSq = parseFloat(modifiedBitumenSquares) || 0;
    const ridgeLf = parseFloat(ridgeVentLF) || 0;
    const items: string[] = [
      'Tear off, Haul & Dispose Shingles',
      'Check decking for non-nailable surfaces (Dry rot, broken, soft areas)',
      'Install IKO Stormshield Ice & Water',
      getUnderlaymentLabel(),
      `Install 2x2 Drip Edge on rakes and eaves (${dripEdgeColor || 'Color Selected'})`,
      'Install IKO Leading Edge Starter Plus',
      'Remove and Replace all roof to wall flashings (step flashing, counter flashing)',
      'Remove and Replace all Pipe Jacks & T-Top Vents',
    ];

    if (selectedShingle) {
      items.push(`Install IKO ${getShingleDisplayName()} AR Shingles (${getShingleColor()})`);
    }
    if (ridgeLf > 0) {
      items.push(`Install IKO Hip and Ridge (${ridgeLf} LF)`);
    }
    if (mbSq > 0) {
      items.push(
        `Install TopShield PRO SA Cap Modified Bitumen (${modifiedBitumenColor || 'Color Selected'}) - ${mbSq} squares`
      );
    }
    if (fasciaMode) {
      const fasciaLabel = fasciaType ? `${fasciaType} ` : '';
      items.push(
        `${fasciaMode === 'full' ? 'Full fascia replacement' : 'Fascia repair'} (${fasciaLabel}${fasciaLF || 0} LF)`
      );
    }
    if (deckingMode === 'full') {
      items.push(`Full re-deck (${sheetsNeeded} sheets estimated)`);
    } else if (deckingMode === 'repair' && parseFloat(deckingSheets) > 0) {
      items.push(`Decking repair (${deckingSheets} sheets)`);
    }
    if (parseFloat(solarPanels) > 0) {
      items.push(`Solar Panels detach/reset (${solarPanels})`);
    }
    if (parseFloat(hvacUnits) > 0) {
      items.push(`HVAC Detach and Reset (${hvacUnits})`);
    }
    if (parseFloat(skylights) > 0) {
      items.push(`Skylights detach/reset (${skylights})`);
    }

    items.push('Clean up and Dispose of all debris on jobsite');

    if (notes.trim()) {
      items.push(`Additional Notes: ${notes.trim()}`);
    }

    return items;
  };

  const brandCompany =
    userCompany.trim() || DEFAULT_USER_PROFILE.company;

  const generatePDF = () => {
    const client = resolveEstimatorClient();
    const doc = new jsPDF();
    const scopeItems = buildScopeOfWork().filter((item) => !item.startsWith('Additional Notes:'));
    const pageWidth = doc.internal.pageSize.getWidth();
    const maxWidth = pageWidth - 40;
    const pmPhone = displayPhoneUS(userPhone) || userPhone;

    doc.setFontSize(20);
    doc.text(brandCompany, 20, 20);
    doc.setFontSize(12);
    doc.text('Professional Roofing Estimate', 20, 28);
    doc.setFontSize(10);
    doc.text(`Prepared ${estimateDate}`, 20, 34);

    doc.setFontSize(11);
    doc.text(`Client: ${client.fullName}`, 20, 46);
    doc.text(`Phone: ${client.phone || 'N/A'}`, 20, 52);
    doc.text(`Email: ${client.email || 'N/A'}`, 20, 58);
    const addressLines = doc.splitTextToSize(`Address: ${client.fullAddress}`, maxWidth);
    doc.text(addressLines, 20, 64);
    let y = 64 + addressLines.length * 6;
    doc.text(`Job #: ${client.jobNumber || 'N/A'}`, 20, y);
    y += 10;

    // Project manager contact
    doc.setFontSize(11);
    doc.text('Your Project Manager', 20, y);
    y += 6;
    doc.setFontSize(10);
    doc.text(`${userName || 'Rep'} · ${userTitle || 'Project Manager'}`, 20, y);
    y += 5;
    doc.text(`Phone: ${pmPhone}`, 20, y);
    y += 5;
    doc.text(`Email: ${userEmail || 'N/A'}`, 20, y);
    y += 12;

    doc.setFontSize(12);
    doc.text('Scope of Work', 20, y);
    y += 8;
    doc.setFontSize(10);

    scopeItems.forEach((item) => {
      const lines = doc.splitTextToSize(`• ${item}`, maxWidth);
      if (y + lines.length * 5 > 270) {
        doc.addPage();
        y = 20;
      }
      doc.text(lines, 20, y);
      y += lines.length * 5 + 2;
    });

    if (notes.trim()) {
      y += 10;
      if (y > 250) {
        doc.addPage();
        y = 20;
      }
      doc.setFontSize(12);
      doc.text('ADDITIONAL NOTES', 20, y);
      y += 8;
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

    doc.setFontSize(14);
    doc.text('Total Investment', 20, y);
    doc.text(`$${estimatorTotalPrice.toLocaleString()}`, pageWidth - 20, y, { align: 'right' });

    y += 8;
    doc.setFontSize(11);
    doc.text(`Special discount applied — $${bufferUsed.toLocaleString()}`, 20, y);

    y += 12;
    doc.setFontSize(10);
    doc.text('Subject to change order upon day of build. This estimate is valid for 30 days.', 20, y);

    y += 10;
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
    const scopeItems = buildScopeOfWork().filter((item) => !item.startsWith('Additional Notes:'));

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
            <div className="text-zinc-500 mt-1">Professional Roofing Estimate</div>
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
                  <div key={index}>• {item}</div>
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
              <div className="text-amber-700 text-right font-medium">
                Special discount applied — ${bufferUsed.toLocaleString()}
              </div>
            </div>

            <div className="mt-8 text-xs text-amber-800/90 border-t border-amber-100 pt-6">
              Subject to change order upon day of build. This estimate is valid for 30 days.
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
    icon: 'home' | 'jobs' | 'estimates' | 'calendar' | 'performance' | 'tools' | 'documents' | 'settings';
  };

  const sidebarPrimary: SidebarItem[] = [
    { tab: 'home', label: 'Home', icon: 'home' },
    { tab: 'leads', label: 'Jobs', icon: 'jobs' },
    { tab: 'estimates', label: 'Estimates', icon: 'estimates' },
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
                            className="w-full text-left rounded-2xl border border-zinc-200 px-4 py-3 hover:border-emerald-300 hover:bg-emerald-50/30 transition-colors"
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

                <div className="flex flex-col sm:items-end gap-3">
                  <button
                    type="button"
                    onClick={() => createNewLead()}
                    className="btn-primary px-5 py-2.5 rounded-2xl text-sm font-semibold"
                  >
                    New Lead
                  </button>
                  <div className="sm:text-right">
                    <div className="text-sm uppercase tracking-widest text-zinc-400">
                      Pipeline Overview
                    </div>
                    <div className="text-sm font-medium text-sky-800/80 mt-1">
                      {leads.length} active job{leads.length === 1 ? '' : 's'}
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4 mb-16">
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
                      onClick={() => {
                        setPipelineFilter(stage);
                        setLeadsView('active');
                        setLeadsSearch('');
                        handleTabChange('leads');
                      }}
                      className={`rounded-3xl border bg-white p-4 sm:p-5 text-center transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${
                        active
                          ? `border-zinc-800 ring-2 ${styles.ring} shadow-sm`
                          : 'border-zinc-200 hover:border-zinc-300'
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
                      <div className="mt-1.5 text-[10px] font-medium text-zinc-400">
                        View
                      </div>
                    </button>
                  );
                })}
              </div>

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
                  className="group bg-white border border-zinc-200/80 hover:border-emerald-300/80 hover:shadow-md hover:-translate-y-0.5 rounded-3xl p-7 sm:p-8 cursor-pointer transition-all duration-200"
                >
                  <div className="text-xl sm:text-2xl font-semibold text-zinc-900 mb-1 group-hover:text-emerald-900 transition-colors">
                    Estimates
                  </div>
                  <p className="text-sm text-zinc-500 group-hover:text-zinc-600">
                    All saved quotes across leads
                  </p>
                </div>

                <div
                  onClick={() => handleTabChange('leads')}
                  className="group bg-white border border-zinc-200/80 hover:border-emerald-300/80 hover:shadow-md hover:-translate-y-0.5 rounded-3xl p-7 sm:p-8 cursor-pointer transition-all duration-200"
                >
                  <div className="text-xl sm:text-2xl font-semibold text-zinc-900 mb-1 group-hover:text-emerald-900 transition-colors">
                    Jobs
                  </div>
                  <p className="text-sm text-zinc-500 group-hover:text-zinc-600">
                    Pipeline board · open a job to estimate
                  </p>
                </div>

                <div
                  onClick={() => handleTabChange('documents')}
                  className="group bg-white border border-zinc-200/80 hover:border-zinc-300 hover:shadow-md hover:-translate-y-0.5 rounded-3xl p-7 sm:p-8 cursor-pointer transition-all duration-200"
                >
                  <div className="text-xl sm:text-2xl font-semibold text-zinc-900 mb-1">
                    Documents
                  </div>
                  <p className="text-sm text-zinc-500">Contracts and files</p>
                </div>

                <div
                  onClick={() => handleTabChange('calendar')}
                  className="group bg-white border border-zinc-200/80 hover:border-zinc-300 hover:shadow-md hover:-translate-y-0.5 rounded-3xl p-7 sm:p-8 cursor-pointer transition-all duration-200 sm:col-span-2 lg:col-span-1"
                >
                  <div className="text-xl sm:text-2xl font-semibold text-zinc-900 mb-1">
                    Calendar
                  </div>
                  <p className="text-sm text-zinc-500">Schedule and follow-ups</p>
                </div>
              </div>
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
                        className="bg-white border border-zinc-200 rounded-3xl p-5 hover:border-zinc-300 hover:shadow-sm transition-all"
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
          <div className="pb-8 w-full">
            <h1 className="text-3xl font-semibold text-zinc-900 tracking-tight">
              Documents
            </h1>
            <p className="text-zinc-500 mt-1 mb-8">
              Contracts, signed estimates, and job files
            </p>
            <div className="rounded-3xl border border-dashed border-zinc-200 bg-white px-6 py-16 text-center">
              <p className="text-sm font-medium text-zinc-800">No documents yet</p>
              <p className="text-sm text-zinc-500 mt-2 max-w-md mx-auto">
                Saved PDFs and contracts for your leads will show up here.
              </p>
            </div>
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
                                : 'bg-white border-zinc-200 text-zinc-700 hover:border-zinc-300'
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
                            className="px-3 py-1.5 rounded-full text-xs font-medium border border-zinc-200 text-zinc-700 hover:bg-zinc-100 hover:border-zinc-300"
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
                Shortcuts for estimating and job work
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <button
                type="button"
                onClick={() => createNewLead()}
                className="text-left group bg-white border border-zinc-200/80 hover:border-sky-300/80 hover:shadow-md hover:-translate-y-0.5 rounded-3xl p-6 sm:p-7 transition-all duration-200"
              >
                <div className="text-xl font-semibold text-zinc-900 mb-1 group-hover:text-sky-900">
                  New Lead
                </div>
                <p className="text-sm text-zinc-500">
                  Start a job in the pipeline
                </p>
              </button>
              <button
                type="button"
                onClick={() => openEstimatePicker('estimate')}
                className="text-left group bg-white border border-zinc-200/80 hover:border-emerald-300/80 hover:shadow-md hover:-translate-y-0.5 rounded-3xl p-6 sm:p-7 transition-all duration-200"
              >
                <div className="text-xl font-semibold text-zinc-900 mb-1 group-hover:text-emerald-900">
                  New estimate
                </div>
                <p className="text-sm text-zinc-500">
                  Pick a lead and build a quote
                </p>
              </button>
              <button
                type="button"
                onClick={() => openEstimatePicker('internal')}
                className="text-left group bg-white border border-zinc-200/80 hover:border-amber-300/80 hover:shadow-md hover:-translate-y-0.5 rounded-3xl p-6 sm:p-7 transition-all duration-200"
              >
                <div className="text-xl font-semibold text-zinc-900 mb-1 group-hover:text-amber-900">
                  Internal calc
                </div>
                <p className="text-sm text-zinc-500">
                  Cost, commission, and buffer on a lead
                </p>
              </button>
              <button
                type="button"
                onClick={() => openEstimatesHub()}
                className="text-left group bg-white border border-zinc-200/80 hover:border-zinc-300 hover:shadow-md hover:-translate-y-0.5 rounded-3xl p-6 sm:p-7 transition-all duration-200"
              >
                <div className="text-xl font-semibold text-zinc-900 mb-1">
                  All estimates
                </div>
                <p className="text-sm text-zinc-500">
                  Browse saved quotes across jobs
                </p>
              </button>
              <button
                type="button"
                onClick={() => handleTabChange('calendar')}
                className="text-left group bg-white border border-zinc-200/80 hover:border-zinc-300 hover:shadow-md hover:-translate-y-0.5 rounded-3xl p-6 sm:p-7 transition-all duration-200"
              >
                <div className="text-xl font-semibold text-zinc-900 mb-1">
                  Calendar
                </div>
                <p className="text-sm text-zinc-500">
                  Schedule and follow-ups
                </p>
              </button>
              <button
                type="button"
                onClick={() => handleTabChange('documents')}
                className="text-left group bg-white border border-zinc-200/80 hover:border-zinc-300 hover:shadow-md hover:-translate-y-0.5 rounded-3xl p-6 sm:p-7 transition-all duration-200"
              >
                <div className="text-xl font-semibold text-zinc-900 mb-1">
                  Documents
                </div>
                <p className="text-sm text-zinc-500">
                  Contracts and job files
                </p>
              </button>
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
                <h1 className="text-3xl font-semibold text-zinc-900 tracking-tight">Jobs</h1>
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
                      : 'bg-white text-zinc-600 border border-zinc-200 hover:border-zinc-300'
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
                          : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300 hover:shadow-sm'
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
              trash.length === 0 ? (
                <div className="text-center py-20 text-zinc-400">Trash is empty.</div>
              ) : (
                <div>
                  <div className="flex justify-end mb-4">
                    <button
                      onClick={emptyTrash}
                      className="px-6 py-2 bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-100 rounded-2xl text-sm font-medium transition-colors"
                    >
                      Empty trash permanently
                    </button>
                  </div>
                  <div className="space-y-4">
                    {trash.map((lead) => (
                      <div
                        key={lead.id}
                        className="bg-white border border-zinc-200 rounded-3xl p-6 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4"
                      >
                        <div>
                          <div className="font-semibold text-zinc-900">
                            {lead.clientFirstName} {lead.clientLastName}
                          </div>
                          <div className="text-sm text-zinc-500">
                            {lead.clientAddress} • {lead.date}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => restoreFromTrash(lead.id)}
                            className="px-5 py-3 border border-zinc-300 rounded-2xl text-sm hover:bg-zinc-100 hover:border-zinc-200 transition-colors"
                          >
                            Restore
                          </button>
                          <button
                            onClick={() => permanentlyDelete(lead.id)}
                            className="px-5 py-3 bg-zinc-100 hover:bg-zinc-50 hover:text-zinc-800 text-zinc-800 rounded-2xl text-sm font-medium transition-colors"
                          >
                            Delete permanently
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
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
                    {estimateWorkspace === 'estimate'
                      ? 'Customer quote'
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
                          <span>Base labor</span>
                          <span>${(sq * 100).toFixed(2)}</span>
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
                        {mbCapMaterial > 0 && (
                          <div className="flex justify-between">
                            <span>TopShield PRO SA Cap</span>
                            <span>${mbCapMaterial.toFixed(2)}</span>
                          </div>
                        )}
                        {mbBasePlyMaterial > 0 && (
                          <div className="flex justify-between">
                            <span>MB base ply (2 layers)</span>
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

            {estimateWorkspace === 'estimate' && (
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
                  <div className="text-xs text-zinc-500 mb-1">MB SQUARES (FLAT)</div>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={modifiedBitumenSquares}
                    onChange={(e) => setModifiedBitumenSquares(e.target.value)}
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
              <div className="text-sm font-semibold text-zinc-600 mb-4">CHOOSE YOUR SHINGLE</div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div onClick={() => toggleShingle('cambridge')} className={`bg-white border-2 rounded-3xl p-6 cursor-pointer transition-all ${selectedShingle === 'cambridge' ? 'border-sky-400/70 bg-sky-50/40 shadow-sm ring-1 ring-sky-200/60' : 'border-zinc-200 hover:border-zinc-300'}`}>
                  <div className="text-emerald-700 text-xs font-semibold mb-1">GOOD</div>
                  <div className="font-semibold text-xl mb-3 text-zinc-900">IKO Cambridge</div>
                  <p className="text-sm text-zinc-600 mb-4">Architectural shingle with a dimensional wood-shake look at a great value. Built-in algae resistance and strong wind protection.</p>
                  <div className="text-xs text-zinc-500 mb-1">COLOR</div>
                  <select value={cambridgeColor} onChange={(e) => setCambridgeColor(e.target.value)} className="w-full border border-zinc-200 rounded-2xl px-4 py-2 text-sm text-zinc-900" onClick={e => e.stopPropagation()}>
                    <option value="">Select color...</option>
                    <option>Charcoal Grey</option><option>Driftwood</option><option>Earthtone Cedar</option><option>Harvard Slate</option><option>Dual Black</option><option>Weatherwood</option><option>Dual Brown</option><option>Dual Grey</option>
                  </select>
                </div>
                <div onClick={() => toggleShingle('dynasty')} className={`bg-white border-2 rounded-3xl p-6 cursor-pointer transition-all relative ${selectedShingle === 'dynasty' ? 'border-sky-400/70 bg-sky-50/40 shadow-sm ring-1 ring-sky-200/60' : 'border-zinc-200 hover:border-zinc-300'}`}>
                  <div className="absolute -top-2 right-6 bg-sky-700 text-white text-xs px-3 py-0.5 rounded-full font-medium shadow-sm">RECOMMENDED</div>
                  <div className="text-sky-700 text-xs font-semibold mb-1">BETTER</div>
                  <div className="font-semibold text-xl mb-3 text-zinc-900">IKO Dynasty</div>
                  <p className="text-sm text-zinc-600 mb-4">High-performance shingle with ArmourZone reinforced nailing area for superior wind resistance up to 130 mph. Class 3 impact resistance and excellent durability.</p>
                  <div className="text-xs text-zinc-500 mb-1">COLOR</div>
                  <select value={dynastyColor} onChange={(e) => setDynastyColor(e.target.value)} className="w-full border border-zinc-200 rounded-2xl px-4 py-2 text-sm text-zinc-900" onClick={e => e.stopPropagation()}>
                    <option value="">Select color...</option>
                    <option>Granite Black</option><option>Shadow Brown</option><option>Cornerstone / Weatherwood</option><option>Frostone Grey</option><option>Glacier</option><option>Brownstone</option><option>Driftshake</option><option>Biscayne</option><option>Atlantic Blue</option><option>Monaco Red</option><option>Emerald Green</option><option>Sentinel Slate</option><option>Matte Black</option>
                  </select>
                </div>
                <div onClick={() => toggleShingle('armourshake')} className={`bg-white border-2 rounded-3xl p-6 cursor-pointer transition-all ${selectedShingle === 'armourshake' ? 'border-sky-400/70 bg-sky-50/40 shadow-sm ring-1 ring-sky-200/60' : 'border-zinc-200 hover:border-zinc-300'}`}>
                  <div className="text-amber-700 text-xs font-semibold mb-1">PREMIUM</div>
                  <div className="font-semibold text-xl mb-3 text-zinc-900">IKO Armourshake</div>
                  <p className="text-sm text-zinc-600 mb-4">Designer shingle with exceptional thickness and deep shadow lines for a true wood-shake appearance. Premium weight and standout curb appeal.</p>
                  <div className="text-xs text-zinc-500 mb-1">COLOR</div>
                  <select value={armourshakeColor} onChange={(e) => setArmourshakeColor(e.target.value)} className="w-full border border-zinc-200 rounded-2xl px-4 py-2 text-sm text-zinc-900" onClick={e => e.stopPropagation()}>
                    <option value="">Select color...</option>
                    <option>Shadow Black</option><option>Greystone</option><option>Chalet Wood</option><option>Weathered Stone</option><option>Western Redwood</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="mb-8">
              <div className="text-sm font-semibold text-zinc-600 mb-4">MODIFIED BITUMEN (Low Slope / Flat)</div>
              <div className="bg-white rounded-3xl p-6 border border-zinc-200">
                <div className="font-semibold text-xl mb-3 text-zinc-900">TopShield PRO SA Cap</div>
                <p className="text-sm text-zinc-600 mb-4">Premium self-adhered granular cap sheet for low-slope roofing. Exceptional durability and long-term waterproofing protection.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <div className="text-xs text-zinc-500 mb-1">MB SQUARES</div>
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={modifiedBitumenSquares}
                      onChange={(e) => setModifiedBitumenSquares(e.target.value)}
                      placeholder="0"
                      className="w-full text-2xl font-semibold border border-zinc-200 rounded-2xl px-4 py-3 text-zinc-900 focus:outline-none focus:border-zinc-400"
                    />
                  </div>
                  <div>
                    <div className="text-xs text-zinc-500 mb-1">COLOR</div>
                    <select
                      value={modifiedBitumenColor}
                      onChange={(e) => setModifiedBitumenColor(e.target.value)}
                      className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900"
                    >
                      <option value="">Select color...</option>
                      <option>Thunder Black</option>
                      <option>Gunmetal Gray</option>
                      <option>Weathered Wood</option>
                      <option>Russet Ridge</option>
                      <option>Roasted Chestnut</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
            <div className="mb-8">
              <div className="text-sm font-semibold text-zinc-600 mb-4">UNDERLAYMENT</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div onClick={() => setSelectedUnderlayment(selectedUnderlayment === 'standard' ? '' : 'standard')} className={`bg-white border-2 rounded-3xl p-6 cursor-pointer transition-all ${selectedUnderlayment === 'standard' ? 'border-sky-400/70 bg-sky-50/40 shadow-sm ring-1 ring-sky-200/60' : 'border-zinc-200 hover:border-zinc-300'}`}>
                  <div className="font-semibold text-lg mb-1 text-zinc-900">Standard Synthetic</div>
                  <div className="text-sm text-zinc-600">IKO Stormtite or equivalent</div>
                </div>
                <div onClick={() => setSelectedUnderlayment(selectedUnderlayment === 'high-temp' ? '' : 'high-temp')} className={`bg-white border-2 rounded-3xl p-6 cursor-pointer transition-all ${selectedUnderlayment === 'high-temp' ? 'border-sky-400/70 bg-sky-50/40 shadow-sm ring-1 ring-sky-200/60' : 'border-zinc-200 hover:border-zinc-300'}`}>
                  <div className="font-semibold text-lg mb-1 text-zinc-900">High-Temp Synthetic</div>
                  <div className="text-sm text-zinc-600">TopShield Bigfoot 30 • AZ heat ready</div>
                </div>
              </div>
            </div>
            <div className="mb-8">
              <div className="text-sm font-semibold text-zinc-600 mb-4">ADDERS</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div className="bg-white border border-zinc-200 rounded-3xl p-6">
                  <div className="flex justify-between items-center mb-3">
                    <div className="font-semibold text-zinc-900">Fascia</div>
                    <div className="text-xs text-emerald-700/80">10 LF included at no cost on repairs</div>
                  </div>
                  <div className="flex gap-2 mb-3">
                    <button onClick={() => toggleFascia('repair')} className={`flex-1 py-2 rounded-2xl text-sm font-medium border transition-all ${fasciaMode === 'repair' ? 'border-sky-400/60 bg-sky-50 text-sky-900' : 'border-zinc-300'}`}>Repair</button>
                    <button onClick={() => toggleFascia('full')} className={`flex-1 py-2 rounded-2xl text-sm font-medium border transition-all ${fasciaMode === 'full' ? 'border-sky-400/60 bg-sky-50 text-sky-900' : 'border-zinc-300'}`}>Full Replacement</button>
                  </div>
                  <select value={fasciaType} onChange={(e) => setFasciaType(e.target.value as '2x6' | '2x8' | '')} className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900 mb-3">
                    <option value="">Select Fascia Type...</option>
                    <option value="2x6">2x6 Prime Combed</option>
                    <option value="2x8">2x8 Prime Combed</option>
                  </select>
                  <input type="number" value={fasciaLF} onChange={(e) => setFasciaLF(e.target.value)} placeholder="Linear Feet (after 10 free)" className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900" />
                  {parseFloat(fasciaLF) > 10 && fasciaType && (
                    <div className="mt-3 text-sm">
                      <div className="flex justify-between items-center">
                        <div className="text-amber-700">Cost</div>
                        <div className="font-semibold text-emerald-700">+ ${fasciaCost}</div>
                      </div>
                      <div className="text-xs text-amber-700 mt-1">Subject to change upon signed change order</div>
                    </div>
                  )}
                </div>
                <div className="bg-white border border-zinc-200 rounded-3xl p-6">
                  <div className="flex justify-between items-center mb-3">
                    <div className="font-semibold text-zinc-900">Decking</div>
                    <div className="text-xs text-emerald-700/80">2 sheets included at no cost on repairs</div>
                  </div>
                  <div className="flex gap-2 mb-4">
                    <button onClick={() => toggleDecking('repair')} className={`flex-1 py-2 rounded-2xl text-sm font-medium border transition-all ${deckingMode === 'repair' ? 'border-sky-400/60 bg-sky-50 text-sky-900' : 'border-zinc-300'}`}>Repair</button>
                    <button onClick={() => toggleDecking('full')} className={`flex-1 py-2 rounded-2xl text-sm font-medium border transition-all ${deckingMode === 'full' ? 'border-sky-400/60 bg-sky-50 text-sky-900' : 'border-zinc-300'}`}>Full Re-Deck</button>
                  </div>
                  {deckingMode === 'full' ? (
                    <div>
                      <div className="flex justify-between items-end mb-1">
                        <div className="text-sm text-amber-700">Estimated Sheets Needed</div>
                        <div className="text-3xl font-semibold text-zinc-900">{sheetsNeeded}</div>
                      </div>
                      <div className="flex justify-between items-center mb-3">
                        <div className="text-sm text-amber-700">Cost</div>
                        <div className="text-lg font-semibold text-emerald-700">+ ${(deckingCost).toLocaleString()}</div>
                      </div>
                      <div className="text-xs text-amber-700">Subject to change upon signed change order</div>
                    </div>
                  ) : deckingMode === 'repair' ? (
                    <div>
                      <input type="number" value={deckingSheets} onChange={(e) => setDeckingSheets(e.target.value)} placeholder="Additional Sheets" className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900 mb-2" />
                      {parseFloat(deckingSheets) > 2 && (
                        <div className="text-sm mb-2">
                          <div className="flex justify-between items-center">
                            <div className="text-amber-700">Cost</div>
                            <div className="font-semibold text-emerald-700">+ ${deckingCost}</div>
                          </div>
                        </div>
                      )}
                      <div className="text-xs text-amber-700">Subject to change upon signed change order</div>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-white border border-zinc-200 rounded-3xl p-5">
                  <div className="font-semibold mb-2 text-zinc-900">Solar Panels</div>
                  <input type="number" value={solarPanels} onChange={(e) => setSolarPanels(e.target.value)} placeholder="# of Panels" className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900" />
                  {parseFloat(solarPanels) > 0 && <div className="text-xs text-emerald-700 mt-2">+ ${(parseFloat(solarPanels) * 250).toLocaleString()}</div>}
                </div>
                <div className="bg-white border border-zinc-200 rounded-3xl p-5">
                  <div className="font-semibold mb-2 text-zinc-900">HVAC</div>
                  <div className="text-xs text-zinc-500 mb-2">detach and reset</div>
                  <input type="number" value={hvacUnits} onChange={(e) => setHvacUnits(e.target.value)} placeholder="# of Units" className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900" />
                  {parseFloat(hvacUnits) > 0 && <div className="text-xs text-emerald-700 mt-2">+ ${(parseFloat(hvacUnits) * 1500).toLocaleString()}</div>}
                </div>
                <div className="bg-white border border-zinc-200 rounded-3xl p-5">
                  <div className="font-semibold mb-2 text-zinc-900">Skylights</div>
                  <div className="text-xs text-zinc-500 mb-2">detach and reset</div>
                  <input type="number" value={skylights} onChange={(e) => setSkylights(e.target.value)} placeholder="# of Skylights" className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900" />
                  {parseFloat(skylights) > 0 && <div className="text-xs text-emerald-700 mt-2">+ ${(parseFloat(skylights) * 575).toLocaleString()}</div>}
                </div>
                <div className="bg-white border border-zinc-200 rounded-3xl p-5">
                  <div className="font-semibold mb-2 text-zinc-900">Ridge Vent</div>
                  <input type="number" value={ridgeVentLF} onChange={(e) => setRidgeVentLF(e.target.value)} placeholder="Linear Feet" className="w-full border border-zinc-200 rounded-2xl px-4 py-3 text-sm text-zinc-900" />
                  {parseFloat(ridgeVentLF) > 0 && <div className="text-xs text-emerald-700 mt-2">+ ${(parseFloat(ridgeVentLF) * 16).toFixed(0)}</div>}
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
                    <div className="text-2xl font-semibold text-zinc-400">Select a shingle to view pricing</div>
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
                                onClick={() => setProfileTab(tab.id)}
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

                          <div className="pt-2 pb-4">
                            <button
                              type="button"
                              onClick={() => {
                                if (currentLeadId != null) moveToTrash(currentLeadId);
                              }}
                              disabled={currentLeadId == null}
                              className="w-full py-3.5 rounded-2xl text-sm font-semibold border border-red-200 text-red-700 bg-white hover:bg-red-50 hover:border-red-300 transition-colors disabled:opacity-40"
                            >
                              Delete lead
                            </button>
                            <p className="text-center text-xs text-zinc-400 mt-2">
                              Moves this lead to trash. You can restore it later.
                            </p>
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
                            </div>
                          )}

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
                                          className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-white border border-emerald-200 text-emerald-900 hover:bg-emerald-50 transition-colors"
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
                                          className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-white border border-emerald-200 text-emerald-900 hover:bg-emerald-50 transition-colors"
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
                                          className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-white border border-emerald-200 text-emerald-900 hover:bg-emerald-50 transition-colors"
                                        >
                                          More pitched
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => prepareSectionKind('flat')}
                                          className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-white border border-emerald-200 text-emerald-900 hover:bg-emerald-50 transition-colors"
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
                              [...profileNotes].reverse().map((note, index) => (
                                <div
                                  key={`${note.date}-${index}`}
                                  className="relative pl-6 border-l-2 border-zinc-200"
                                >
                                  <div className="absolute -left-[7px] top-1.5 w-3 h-3 rounded-full bg-zinc-400 border-2 border-white shadow" />
                                  <div className="bg-zinc-100 rounded-2xl p-4 text-sm">
                                    <div className="text-zinc-500 text-xs mb-1 font-medium">
                                      {note.date}
                                    </div>
                                    <div className="whitespace-pre-wrap text-zinc-800">
                                      {note.text}
                                    </div>
                                  </div>
                                </div>
                              ))
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
                                <button
                                  key={est.id ?? index}
                                  type="button"
                                  className="w-full text-left border border-zinc-200 rounded-2xl p-5 hover:border-zinc-300 hover:bg-zinc-100 transition-colors"
                                  onClick={() => loadEstimate(est)}
                                >
                                  <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2">
                                    <div>
                                      <div className="font-medium text-zinc-900">
                                        Estimate · {est.date}
                                      </div>
                                      <div className="text-sm text-zinc-500 mt-0.5">
                                        {est.squares || 0} squares ·{' '}
                                        {est.selectedShingle || 'No shingle'}
                                      </div>
                                    </div>
                                    <div className="text-xl font-semibold text-zinc-900">
                                      $
                                      {(
                                        est.negotiatedPrice ||
                                        est.total ||
                                        0
                                      ).toLocaleString()}
                                    </div>
                                  </div>
                                </button>
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
                              <p className="text-sm text-zinc-500 mt-0.5">
                                Multi-upload site photos. Local previews for now; Supabase later
                                for 500+.
                              </p>
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
                            accept="image/*"
                            multiple
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
                                : 'border-zinc-200 bg-zinc-100 hover:border-zinc-300'
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
                            <button
                              type="button"
                              disabled={photosUploading}
                              onClick={(e) => {
                                e.stopPropagation();
                                photoInputRef.current?.click();
                              }}
                              className="btn-primary mt-4 px-5 py-2.5 rounded-2xl text-sm font-medium disabled:opacity-50"
                            >
                              {photosUploading ? 'Working…' : 'Upload photos'}
                            </button>
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
                                      src={photo.dataUrl}
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
                          <h2 className="text-lg font-semibold text-zinc-900 mb-1">
                            Documents
                          </h2>
                          <p className="text-sm text-zinc-500 mb-5">
                            Contracts and files for this lead.
                          </p>
                          <div className="rounded-2xl border border-dashed border-zinc-200 px-6 py-12 text-center">
                            <p className="text-sm font-medium text-zinc-800">No documents yet</p>
                            <p className="text-sm text-zinc-500 mt-2">
                              PDFs and signed paperwork will appear here.
                            </p>
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
                        src={lightboxPhoto.dataUrl}
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