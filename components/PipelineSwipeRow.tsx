'use client';

import { useEffect, useRef } from 'react';
import {
  PIPELINE_STAGE_STYLES,
  adjacentPipelineStage,
  normalizePipelineStage,
  type PipelineStage,
} from '@/lib/pipeline';
import { PHONE_EDGE_NAV_PX, isPhoneBackArmed, isPhoneForwardArmed } from '@/lib/phone-nav';

const AXIS_LOCK_PX = 10;
const COMMIT_PX = 64;
const SNAP_MS = 240;
const SNAP_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
const RUBBER = 0.22;

type Lead = {
  id: number;
  clientFirstName: string;
  clientLastName: string;
  clientAddress: string;
  category: string;
  estimates?: { date?: string }[];
};

type Props = {
  lead: Lead;
  showStage: boolean;
  onOpen: () => void;
  onMoveToStage: (stage: PipelineStage) => void;
};

function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export default function PipelineSwipeRow({
  lead,
  showStage,
  onOpen,
  onMoveToStage,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const xRef = useRef(0);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const trackingRef = useRef(false);
  const lockedRef = useRef<'h' | 'v' | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const snappingRef = useRef(false);
  const onMoveRef = useRef(onMoveToStage);
  useEffect(() => {
    onMoveRef.current = onMoveToStage;
  }, [onMoveToStage]);

  const stage = normalizePipelineStage(lead.category);
  const nextStage = adjacentPipelineStage(stage, 1);
  const prevStage = adjacentPipelineStage(stage, -1);
  const styles = PIPELINE_STAGE_STYLES[stage];
  const name =
    [lead.clientFirstName, lead.clientLastName].filter(Boolean).join(' ') ||
    'Untitled lead';

  const setX = (px: number, withSnap: boolean) => {
    xRef.current = px;
    const card = cardRef.current;
    if (!card) return;
    if (px === 0 && !withSnap) {
      card.style.transition = 'none';
      card.style.transform = '';
      return;
    }
    card.style.transition = withSnap
      ? `transform ${SNAP_MS}ms ${SNAP_EASE}`
      : 'none';
    card.style.transform = `translate3d(${px}px,0,0)`;
    if (px === 0 && withSnap) {
      window.setTimeout(() => {
        if (xRef.current !== 0 || !cardRef.current) return;
        cardRef.current.style.transition = '';
        cardRef.current.style.transform = '';
      }, SNAP_MS);
    }
  };

  useEffect(() => {
    const root = rootRef.current;
    const card = cardRef.current;
    if (!root || !card) return;

    const rubber = (dx: number) => {
      if (dx > 0 && !nextStage) return dx * RUBBER;
      if (dx < 0 && !prevStage) return dx * RUBBER;
      return dx;
    };

    const endGesture = () => {
      trackingRef.current = false;
      lockedRef.current = null;
      pointerIdRef.current = null;
      root.classList.remove('is-dragging', 'is-pressed');
    };

    const commit = (target: PipelineStage, dir: 1 | -1) => {
      snappingRef.current = true;
      suppressClickRef.current = true;
      const width = root.getBoundingClientRect().width || 320;
      if (prefersReducedMotion()) {
        onMoveRef.current(target);
        snappingRef.current = false;
        endGesture();
        return;
      }
      setX(dir * (width + 24), true);
      window.setTimeout(() => {
        onMoveRef.current(target);
        snappingRef.current = false;
      }, SNAP_MS);
    };

    const onDown = (e: PointerEvent) => {
      if (snappingRef.current) return;
      if (
        e.pointerType === 'touch' &&
        isPhoneBackArmed() &&
        e.clientX <= PHONE_EDGE_NAV_PX
      ) {
        return;
      }
      if (
        e.pointerType === 'touch' &&
        isPhoneForwardArmed() &&
        e.clientX >= window.innerWidth - PHONE_EDGE_NAV_PX
      ) {
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target?.closest('button')) return;
      trackingRef.current = true;
      lockedRef.current = null;
      pointerIdRef.current = e.pointerId;
      startXRef.current = e.clientX;
      startYRef.current = e.clientY;
      suppressClickRef.current = false;
      root.classList.add('is-pressed');
      try {
        root.setPointerCapture(e.pointerId);
      } catch {
        /* capture is optional — touchmove preventDefault still locks the axis */
      }
    };

    const onMove = (e: PointerEvent) => {
      if (!trackingRef.current || snappingRef.current) return;
      if (pointerIdRef.current != null && e.pointerId !== pointerIdRef.current)
        return;
      const dx = e.clientX - startXRef.current;
      const dy = e.clientY - startYRef.current;
      if (!lockedRef.current) {
        if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
        lockedRef.current = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
        if (lockedRef.current === 'v') {
          trackingRef.current = false;
          root.classList.remove('is-pressed');
          return;
        }
        root.classList.add('is-dragging');
        root.classList.remove('is-pressed');
      }
      if (lockedRef.current !== 'h') return;
      if (Math.abs(dx) > 8) suppressClickRef.current = true;
      if (!prefersReducedMotion()) setX(rubber(dx), false);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (lockedRef.current === 'h') e.preventDefault();
    };

    const onUp = (e: PointerEvent) => {
      if (!trackingRef.current && lockedRef.current !== 'h') {
        endGesture();
        return;
      }
      if (pointerIdRef.current != null && e.pointerId !== pointerIdRef.current)
        return;
      const dx = e.clientX - startXRef.current;
      const locked = lockedRef.current;
      endGesture();
      if (locked !== 'h') {
        setX(0, false);
        return;
      }
      if (dx > COMMIT_PX && nextStage) {
        commit(nextStage, 1);
        return;
      }
      if (dx < -COMMIT_PX && prevStage) {
        commit(prevStage, -1);
        return;
      }
      if (prefersReducedMotion()) setX(0, false);
      else setX(0, true);
    };

    root.addEventListener('pointerdown', onDown);
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerup', onUp);
    root.addEventListener('pointercancel', onUp);
    root.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      root.removeEventListener('pointerdown', onDown);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerup', onUp);
      root.removeEventListener('pointercancel', onUp);
      root.removeEventListener('touchmove', onTouchMove);
    };
  }, [nextStage, prevStage]);

  return (
    <div ref={rootRef} className="pl-swipe">
      <div className="pl-swipe-peek" aria-hidden="true">
        <div
          className={`pl-swipe-rail pl-swipe-rail--next ${
            nextStage ? PIPELINE_STAGE_STYLES[nextStage].dash : 'is-empty'
          }`}
          data-stage={nextStage ?? undefined}
        >
          {nextStage ?? ''}
        </div>
        <div
          className={`pl-swipe-rail pl-swipe-rail--prev ${
            prevStage ? PIPELINE_STAGE_STYLES[prevStage].dash : 'is-empty'
          }`}
          data-stage={prevStage ?? undefined}
        >
          {prevStage ?? ''}
        </div>
      </div>
      <div
        ref={cardRef}
        className="pl-swipe-card"
        onClick={() => {
          if (suppressClickRef.current || snappingRef.current) return;
          onOpen();
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-semibold text-base text-[var(--graphite)] truncate">
              {name}
            </div>
            <div className="text-sm text-[var(--steel)] mt-0.5 line-clamp-2 break-words">
              {lead.clientAddress || 'No address'}
            </div>
          </div>
          {showStage && (
            <span
              className={`inline-flex items-center gap-1.5 rounded-full pl-2 pr-2.5 py-1 shrink-0 text-[0.6875rem] font-medium ${styles.badge}`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${styles.dash}`}
                aria-hidden
              />
              {stage}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
