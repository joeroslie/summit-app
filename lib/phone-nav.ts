/** Finger pagers (iPhone + iPad). Gate on TouchEvent, never max-width. */

import { PIPELINE_STAGES, type PipelineStage } from '@/lib/pipeline';

/**
 * Map-only leftover edge so Leaflet pan / pin-drag don't eat the pager.
 * Non-map screens page from the full width, including bezels.
 */
export const PHONE_EDGE_NAV_PX = 48;
/** Horizontal travel before Back / Forward commits. */
export const PHONE_NAV_COMMIT_PX = 64;
/** Start locking the gesture (prevent scroll) after this much horizontal move. */
export const PHONE_NAV_LOCK_PX = 12;
/** Chip-row centering + page change share this glide. Not scrollIntoView. */
export const PHONE_PAGER_GLIDE_MS = 200;

/** Bottom tab bar is tap / swipe-up only — never a horizontal pager. */
export const PHONE_NAV_SKIP_SEL =
  '[data-phone-tab-bar], [data-pdf-preview], .weather-day-cal';
export const PHONE_NAV_MAP_SEL =
  '.leaflet-container, .canvass-map, .weather-map, .roof-tracer-map';
export const PHONE_CHIP_STRIP_SEL = '[data-phone-chip-strip]';

let pagerGlideUntil = 0;

function easeOutQuad(t: number) {
  return 1 - (1 - t) * (1 - t);
}

/** True while a pager glide is in flight — ignore extra commits from the same flick. */
export function phonePagerGlideLocked() {
  return typeof performance !== 'undefined' && performance.now() < pagerGlideUntil;
}

export function markPhonePagerGlide() {
  if (typeof performance === 'undefined') return;
  pagerGlideUntil = performance.now() + PHONE_PAGER_GLIDE_MS;
}

/** Kill iOS overflow momentum so a fast swipe cannot coast past the adjacent chip. */
export function freezePhoneChipStrips() {
  if (typeof document === 'undefined') return;
  document.querySelectorAll<HTMLElement>(PHONE_CHIP_STRIP_SEL).forEach((el) => {
    el.style.overflowX = 'hidden';
  });
}

export function unfreezePhoneChipStrips() {
  if (typeof document === 'undefined') return;
  document.querySelectorAll<HTMLElement>(PHONE_CHIP_STRIP_SEL).forEach((el) => {
    el.style.overflowX = '';
  });
}

export function cancelChipGlide(
  strip: HTMLElement | null,
  rafRef: { current: number | null }
) {
  if (rafRef.current != null) {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }
  if (strip) strip.style.overflowX = '';
}

/** Center a chip with the same 200ms ease-out Pipeline uses. Never scrollIntoView. */
export function glideChipCenter(
  strip: HTMLElement,
  chip: HTMLElement,
  rafRef: { current: number | null }
) {
  const stripRect = strip.getBoundingClientRect();
  const chipRect = chip.getBoundingClientRect();
  const to =
    strip.scrollLeft +
    (chipRect.left + chipRect.width / 2) -
    (stripRect.left + stripRect.width / 2);
  const max = Math.max(0, strip.scrollWidth - strip.clientWidth);
  const target = Math.max(0, Math.min(to, max));
  const from = strip.scrollLeft;
  if (rafRef.current != null) {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }
  strip.style.overflowX = 'hidden';
  const finish = () => {
    strip.scrollLeft = target;
    strip.style.overflowX = '';
    rafRef.current = null;
  };
  const reduce =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || Math.abs(target - from) < 1) {
    finish();
    return;
  }
  const start = performance.now();
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / PHONE_PAGER_GLIDE_MS);
    strip.scrollLeft = from + (target - from) * easeOutQuad(t);
    if (t < 1) rafRef.current = requestAnimationFrame(tick);
    else finish();
  };
  rafRef.current = requestAnimationFrame(tick);
}

/** Lead profile chips — swipe order. Tapping a chip and swiping here are the same place. */
export const LEAD_PROFILE_PAGER = [
  { id: 'overview', label: 'Overview' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'measurements', label: 'Measurements' },
  { id: 'financial', label: 'Financial' },
  { id: 'insurance', label: 'Insurance' },
  { id: 'notes', label: 'Messages' },
  { id: 'estimates', label: 'Estimates' },
  { id: 'orders', label: 'Orders' },
  { id: 'photos', label: 'Photos' },
  { id: 'documents', label: 'Documents' },
] as const;

export type LeadProfilePagerId = (typeof LEAD_PROFILE_PAGER)[number]['id'];

export function leadProfilePagerIndex(tab: string): number {
  return LEAD_PROFILE_PAGER.findIndex((t) => t.id === tab);
}

export type LeadProfilePagerStep =
  | { kind: 'chip'; id: LeadProfilePagerId }
  | { kind: 'exit' }
  | { kind: 'rubber' };

/** Finger left = next chip; finger right = previous. Overview previous exits to the board. */
export function leadProfilePagerStep(
  tab: string,
  dir: 1 | -1
): LeadProfilePagerStep {
  const idx = leadProfilePagerIndex(tab);
  if (idx < 0) return dir < 0 ? { kind: 'exit' } : { kind: 'rubber' };
  const next = idx + dir;
  if (next < 0) return { kind: 'exit' };
  const chip = LEAD_PROFILE_PAGER[next];
  if (!chip) return { kind: 'rubber' };
  return { kind: 'chip', id: chip.id };
}

export const PIPELINE_BOARD_PAGER = ['all', ...PIPELINE_STAGES] as const;

export type PipelineBoardPagerId = (typeof PIPELINE_BOARD_PAGER)[number];

export type PipelineBoardPagerStep =
  | { kind: 'chip'; filter: PipelineStage | null }
  | { kind: 'exit' }
  | { kind: 'rubber' };

/** Jump chips: All → Lead → … → Closed. All + previous = Home. Closed + next = stop. */
export function pipelineBoardPagerStep(
  filter: PipelineStage | null,
  dir: 1 | -1
): PipelineBoardPagerStep {
  const current: PipelineBoardPagerId = filter ?? 'all';
  const idx = PIPELINE_BOARD_PAGER.indexOf(current);
  if (idx < 0) return dir < 0 ? { kind: 'exit' } : { kind: 'rubber' };
  const next = idx + dir;
  if (next < 0) return { kind: 'exit' };
  const chip = PIPELINE_BOARD_PAGER[next];
  if (!chip) return { kind: 'rubber' };
  return { kind: 'chip', filter: chip === 'all' ? null : chip };
}

export function pulsePhonePagerRubber(
  el: HTMLElement | null,
  dir: 1 | -1
) {
  if (!el) return;
  const x = dir > 0 ? -14 : 14;
  el.animate(
    [
      { transform: 'translateX(0)' },
      { transform: `translateX(${x}px)` },
      { transform: 'translateX(0)' },
    ],
    { duration: 220, easing: 'ease-out' }
  );
}

/** True for a real finger TouchEvent / pointerType touch — not mouse or trackpad. */
export function eventIsFingerTouch(e: Event): boolean {
  if (e.type.startsWith('touch')) return true;
  const pe = e as PointerEvent;
  if (typeof pe.pointerType === 'string') return pe.pointerType === 'touch';
  const me = e as MouseEvent & {
    sourceCapabilities?: { firesTouchEvents?: boolean };
  };
  return Boolean(me.sourceCapabilities?.firesTouchEvents);
}

export type PhoneForwardRestore =
  | { kind: 'sidebar' }
  | { kind: 'userMenu' }
  | { kind: 'headerSearch'; query: string }
  | {
      kind: 'lightbox';
      photo: {
        id: string;
        name: string;
        url?: string;
        dataUrl?: string;
        createdAt: string;
      };
    }
  | { kind: 'estimatePicker'; invoice: boolean }
  | { kind: 'professionalEstimate' }
  | { kind: 'pdf'; url: string; name: string; file: File | null }
  | {
      kind: 'docWorkspace';
      workspace:
        | 'takeoff'
        | 'pricing'
        | 'mitigation'
        | 'mitigation_personal'
        | 'mitigation_company'
        | 'emergency';
      origin: 'hub' | 'lead';
      leadId: number | null;
    }
  | { kind: 'estimator'; leadId: number | null }
  | {
      kind: 'lead';
      leadId: number;
      profileTab: string;
    }
  | { kind: 'tool'; tab: 'canvassing' | 'weather' }
  /** Pipeline board jump chips (All → Lead → …). Not visit history. */
  | { kind: 'board' }
  /** A bottom/More/sidebar tab above Home. Not a stack of tabs. */
  | {
      kind: 'tab';
      tab: 'leads' | 'calendar' | 'tasks' | 'tools' | 'documents' | 'settings';
    };

/**
 * Maps only: small left strip = previous, small right strip = next.
 * Non-map screens page from the full width, including bezels.
 */
export function phoneEdgeNavZone(
  x: number,
  width: number,
  edgePx: number = PHONE_EDGE_NAV_PX
): 'back' | 'forward' | null {
  if (x <= edgePx) return 'back';
  if (x >= width - edgePx) return 'forward';
  return null;
}

/** True when this X is in the map-only leftover Back / Forward edge. */
export function phonePointerYieldsEdgeNav(
  clientX: number,
  event?: Event
): boolean {
  if (typeof window === 'undefined') return false;
  if (event && !eventIsFingerTouch(event)) return false;
  if (clientX <= PHONE_EDGE_NAV_PX && isPhoneBackArmed()) return true;
  if (clientX >= window.innerWidth - PHONE_EDGE_NAV_PX && isPhoneForwardArmed())
    return true;
  return false;
}

type LeafletDragging = { enable: () => void; disable: () => void };

/** Leaflet must not steal the Back / Forward strips on phone. */
export function attachPhoneMapEdgeYield(
  map: { dragging: LeafletDragging },
  container: HTMLElement
): () => void {
  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) {
      map.dragging.enable();
      return;
    }
    const t = e.touches[0];
    if (!t || phonePointerYieldsEdgeNav(t.clientX)) {
      map.dragging.disable();
      return;
    }
    map.dragging.enable();
  };
  const onEnd = () => {
    map.dragging.enable();
  };
  container.addEventListener('touchstart', onStart, {
    capture: true,
    passive: true,
  });
  container.addEventListener('touchend', onEnd, {
    capture: true,
    passive: true,
  });
  container.addEventListener('touchcancel', onEnd, {
    capture: true,
    passive: true,
  });
  return () => {
    container.removeEventListener('touchstart', onStart, true);
    container.removeEventListener('touchend', onEnd, true);
    container.removeEventListener('touchcancel', onEnd, true);
    try {
      map.dragging.enable();
    } catch {
      /* map may already be gone */
    }
  };
}

export function setPhoneForwardFlag(armed: boolean) {
  if (typeof document === 'undefined') return;
  if (armed) document.documentElement.dataset.phoneForward = '1';
  else delete document.documentElement.dataset.phoneForward;
}

export function isPhoneForwardArmed() {
  return (
    typeof document !== 'undefined' &&
    document.documentElement.dataset.phoneForward === '1'
  );
}

export function setPhoneBackFlag(armed: boolean) {
  if (typeof document === 'undefined') return;
  if (armed) document.documentElement.dataset.phoneBack = '1';
  else delete document.documentElement.dataset.phoneBack;
}

export function isPhoneBackArmed() {
  return (
    typeof document !== 'undefined' &&
    document.documentElement.dataset.phoneBack === '1'
  );
}
