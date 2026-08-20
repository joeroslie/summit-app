'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  PHONE_NAV_COMMIT_PX,
  PHONE_NAV_LOCK_PX,
  PHONE_NAV_MAP_SEL,
} from '@/lib/phone-nav';

const MAX_PULL = 88;
const RUBBER = 0.42;

type Props = {
  onRefresh: () => void | Promise<void>;
  children: ReactNode;
  className?: string;
  /** `window` = page lists. `self` = this element is the scroller (photos grid). */
  scrollParent?: 'window' | 'self';
};

function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function rubber(dy: number) {
  if (dy <= 0) return 0;
  return Math.min(MAX_PULL, dy * RUBBER + Math.min(dy, 28) * (1 - RUBBER));
}

export default function PhonePullToRefresh({
  onRefresh,
  children,
  className = '',
  scrollParent = 'window',
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const onRefreshRef = useRef(onRefresh);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let startX = 0;
    let startY = 0;
    let tracking = false;
    let locked: 'h' | 'v' | null = null;

    const scrollTop = () => {
      if (scrollParent === 'self') return root.scrollTop;
      return window.scrollY || document.documentElement.scrollTop || 0;
    };

    const setPullPx = (px: number) => {
      pullRef.current = px;
      setPull(px);
    };

    const onStart = (e: TouchEvent) => {
      if (refreshingRef.current) return;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (!t) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.closest?.(
          `input, textarea, select, [contenteditable="true"], ${PHONE_NAV_MAP_SEL}, .weather-day-cal`
        )
      )
        return;
      if (scrollTop() > 0) return;
      tracking = true;
      locked = null;
      startX = t.clientX;
      startY = t.clientY;
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      if (e.touches.length !== 1) {
        tracking = false;
        locked = null;
        setPullPx(0);
        return;
      }
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (!locked) {
        if (Math.abs(dx) < PHONE_NAV_LOCK_PX && Math.abs(dy) < PHONE_NAV_LOCK_PX)
          return;
        locked = Math.abs(dy) > Math.abs(dx) ? 'v' : 'h';
        if (locked === 'h') {
          tracking = false;
          return;
        }
      }
      if (locked !== 'v') return;
      if (dy <= 0 || scrollTop() > 0) {
        setPullPx(0);
        return;
      }
      e.preventDefault();
      setPullPx(prefersReducedMotion() ? Math.min(dy, 8) : rubber(dy));
    };

    const onEnd = () => {
      if (!tracking && locked !== 'v') {
        tracking = false;
        locked = null;
        return;
      }
      const dist = pullRef.current;
      tracking = false;
      locked = null;
      if (dist >= PHONE_NAV_COMMIT_PX && !refreshingRef.current) {
        refreshingRef.current = true;
        setRefreshing(true);
        setPullPx(40);
        void Promise.resolve(onRefreshRef.current()).finally(() => {
          refreshingRef.current = false;
          setRefreshing(false);
          setPullPx(0);
        });
        return;
      }
      setPullPx(0);
    };

    const optsMove = { passive: false } as const;
    const optsPassive = { passive: true } as const;
    root.addEventListener('touchstart', onStart, optsPassive);
    root.addEventListener('touchmove', onMove, optsMove);
    root.addEventListener('touchend', onEnd, optsPassive);
    root.addEventListener('touchcancel', onEnd, optsPassive);
    return () => {
      root.removeEventListener('touchstart', onStart);
      root.removeEventListener('touchmove', onMove);
      root.removeEventListener('touchend', onEnd);
      root.removeEventListener('touchcancel', onEnd);
    };
  }, [scrollParent]);

  const show = pull > 4 || refreshing;

  return (
    <div
      ref={rootRef}
      className={`relative ${className}`.trim()}
    >
      <div
        aria-hidden={!show}
        className="flex items-center justify-center overflow-hidden shrink-0"
        style={{ height: pull }}
      >
        {show ? (
          <span
            className={`h-5 w-5 rounded-full border-2 border-zinc-300 border-t-zinc-700 ${
              refreshing ? 'animate-spin' : ''
            }`}
            style={
              refreshing || prefersReducedMotion()
                ? undefined
                : { transform: `rotate(${pull * 4}deg)` }
            }
          />
        ) : null}
      </div>
      {children}
    </div>
  );
}
