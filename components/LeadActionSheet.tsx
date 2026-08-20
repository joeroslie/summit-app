'use client';

import { useEffect } from 'react';

export type LeadActionSheetItem = {
  id: string;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
};

type Props = {
  title: string;
  titleId: string;
  open: boolean;
  onClose: () => void;
  items: LeadActionSheetItem[];
};

/** Same overlay as lead Documents add — list after the circled +. */
export default function LeadActionSheet({
  title,
  titleId,
  open,
  onClose,
  items,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white border border-zinc-200 shadow-xl overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100">
          <div id={titleId} className="text-base font-semibold text-zinc-900">
            {title}
          </div>
          <button
            type="button"
            className="text-xs text-zinc-500 hover:text-zinc-800 shrink-0 px-2 py-1"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="p-2">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={item.disabled}
              className="w-full text-left px-4 py-3 rounded-xl text-sm font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-50"
              onClick={() => {
                if (item.disabled) return;
                onClose();
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
