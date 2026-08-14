'use client';

import { useEffect, useRef } from 'react';

export type RoofSystemId = 'shingle' | 'tile' | 'flat';

const SYSTEMS: {
  id: RoofSystemId;
  label: string;
  orderLabel: string;
  hint: string;
  tint: string;
}[] = [
  {
    id: 'shingle',
    label: 'Shingle',
    orderLabel: 'Shingle order',
    hint: 'Shingles, hip & ridge, starter, underlayment',
    tint: '',
  },
  {
    id: 'tile',
    label: 'Tile',
    orderLabel: 'Tile order',
    hint: 'Tile, hip & ridge, underlayment, accessories',
    tint: '',
  },
  {
    id: 'flat',
    label: 'Low slope',
    orderLabel: 'Low-slope order',
    hint: 'Modified bitumen, coatings, foam, ice & water',
    tint: 'glass-tint-blue',
  },
];

export function roofSystemLabel(id: RoofSystemId | '' | null | undefined): string {
  if (id === 'shingle') return 'Shingle';
  if (id === 'tile') return 'Tile';
  if (id === 'flat') return 'Low slope';
  return '';
}

export default function RoofSystemPicker({
  onSelect,
  variant = 'estimate',
}: {
  onSelect: (id: RoofSystemId) => void;
  variant?: 'estimate' | 'order';
}) {
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      const idx = e.key === '1' ? 0 : e.key === '2' ? 1 : e.key === '3' ? 2 : -1;
      if (idx < 0) return;
      e.preventDefault();
      onSelectRef.current(SYSTEMS[idx].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-3 gap-3"
      role="group"
      aria-label={variant === 'order' ? 'Order type' : 'Roof type'}
    >
      {SYSTEMS.map((sys) => (
        <button
          key={sys.id}
          type="button"
          onClick={() => onSelect(sys.id)}
          className={`roof-pick glass glass-hover ${sys.tint}`}
        >
          <div className="roof-pick__label">
            {variant === 'order' ? sys.orderLabel : sys.label}
          </div>
          <p className="roof-pick__hint">{sys.hint}</p>
          <div className="roof-pick__go">Continue →</div>
        </button>
      ))}
    </div>
  );
}
