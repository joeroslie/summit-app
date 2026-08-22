'use client';

import { useEffect, useState } from 'react';

type Props = {
  onClick: () => void;
  'aria-label': string;
  disabled?: boolean;
};

/** 44px circled + — ring stays (add vs close). Fill matches job Close (X). */
export default function CircledPlus({
  onClick,
  'aria-label': ariaLabel,
  disabled,
}: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className="inline-flex items-center justify-center w-11 h-11 p-0 border border-[var(--chrome)] rounded-full bg-transparent text-zinc-600 shrink-0 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-blue-ring)] [@media(hover:hover)_and_(pointer:fine)]:hover:bg-zinc-100 [@media(hover:hover)_and_(pointer:fine)]:hover:text-zinc-900 [@media(pointer:coarse)]:active:bg-zinc-100 [@media(pointer:coarse)]:active:text-zinc-900"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M12 5v14M5 12h14"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}

/** Pointer/desktop vs finger — never max-width. */
export function useFinePointer(): boolean {
  const [fine, setFine] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(hover: hover) and (pointer: fine)');
    const apply = () => setFine(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return fine;
}
