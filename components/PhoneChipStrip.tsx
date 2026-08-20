'use client';

import { useEffect, useRef } from 'react';

type Chip<T extends string> = { id: T; label: string };

type Props<T extends string> = {
  tabs: Chip<T>[];
  activeId: T;
  onSelect: (id: T) => void;
};

/** Tap a chip to change page. Finger swipe is the document pager (same order). */
export default function PhoneChipStrip<T extends string>({
  tabs,
  activeId,
  onSelect,
}: Props<T>) {
  const activeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: 'smooth',
    });
  }, [activeId]);

  return (
    <div
      data-phone-chip-strip
      className="mt-3 -mx-1 overflow-x-auto overscroll-x-none scrollbar-none [touch-action:pan-y_pinch-zoom]"
    >
      <div className="flex gap-1 min-w-max px-1 pb-0.5">
        {tabs.map((tab) => {
          const active = activeId === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              ref={active ? activeRef : undefined}
              onClick={() => onSelect(tab.id)}
              className={`px-3 sm:px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all whitespace-nowrap [touch-action:pan-y_pinch-zoom] ${
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
  );
}
