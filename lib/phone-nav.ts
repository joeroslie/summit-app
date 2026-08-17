/** Phone edge-swipe Back / Forward. Shared so Pipeline cards leave the same strips alone. */

/** Thumb-reachable inset from each screen edge (wider than iOS’s ~20pt bezel). */
export const PHONE_EDGE_NAV_PX = 48;
/** Horizontal travel before Back / Forward commits. */
export const PHONE_NAV_COMMIT_PX = 64;
/** Start locking the gesture (prevent scroll) after this much horizontal move. */
export const PHONE_NAV_LOCK_PX = 12;

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
  | { kind: 'lead'; leadId: number; profileTab: string }
  | { kind: 'tool'; tab: 'canvassing' | 'weather' };

export function phoneEdgeNavZone(
  x: number,
  width: number,
  edgePx: number = PHONE_EDGE_NAV_PX
): 'back' | 'forward' | null {
  if (x <= edgePx) return 'back';
  if (x >= width - edgePx) return 'forward';
  return null;
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
