'use client';

import { useId, useState, type RefObject } from 'react';
import type { AppSearchHit } from '@/lib/app-search';

type HeaderSearchProps = {
  value: string;
  onChange: (value: string) => void;
  results: AppSearchHit[];
  onSelect: (hit: AppSearchHit) => void;
  containerRef: RefObject<HTMLDivElement | null>;
};

export default function HeaderSearch({
  value,
  onChange,
  results,
  onSelect,
  containerRef,
}: HeaderSearchProps) {
  const listId = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const query = value.trim();
  const open = Boolean(query);
  const safeIndex =
    results.length === 0 ? 0 : Math.min(activeIndex, results.length - 1);

  const selectIndex = (index: number) => {
    const hit = results[index];
    if (hit) onSelect(hit);
  };

  return (
    <div
      ref={containerRef}
      className="flex-1 min-w-0 max-w-xl lg:max-w-lg relative"
    >
      <input
        type="search"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setActiveIndex(0);
        }}
        placeholder="Search"
        aria-label="Search"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && results[safeIndex]
            ? `${listId}-${results[safeIndex].id}`
            : undefined
        }
        role="combobox"
        autoComplete="off"
        className="glass w-full h-10 px-4 rounded-full text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-[var(--accent-blue-ring)]"
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (results.length === 0) return;
            setActiveIndex((i) => (i + 1) % results.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (results.length === 0) return;
            setActiveIndex((i) => (i - 1 + results.length) % results.length);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            selectIndex(safeIndex);
          }
        }}
      />
      {open && (
        <div
          id={listId}
          role="listbox"
          className="menu-panel z-[60] overflow-hidden rounded-2xl text-zinc-900 max-md:fixed max-md:left-3 max-md:right-3 max-md:top-[calc(var(--header-h)+0.35rem)] md:absolute md:left-0 md:right-0 md:mt-2"
        >
          {results.length === 0 ? (
            <div className="px-4 py-6 text-sm text-zinc-400 text-center">
              No matches for “{value.trim()}”
            </div>
          ) : (
            <div className="max-h-[min(70vh,24rem)] overflow-y-auto py-1">
              {results.map((hit, index) => {
                const active = index === safeIndex;
                return (
                  <button
                    key={hit.id}
                    id={`${listId}-${hit.id}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => onSelect(hit)}
                    className={`w-full text-left px-4 py-3 transition-colors border-b border-zinc-200 last:border-0 ${
                      active ? 'bg-black/[0.06]' : 'hover:bg-black/[0.04]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium text-sm truncate text-zinc-900">
                        {hit.title}
                      </div>
                      <span className="text-xs uppercase tracking-wide text-zinc-400 shrink-0">
                        {hit.kindLabel}
                      </span>
                    </div>
                    {hit.subtitle ? (
                      <div className="text-xs text-zinc-500 mt-0.5 truncate">
                        {hit.subtitle}
                      </div>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
