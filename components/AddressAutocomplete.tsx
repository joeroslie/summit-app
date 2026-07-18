'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

export type AddressParts = {
  street: string;
  city: string;
  state: string;
  zip: string;
  lat?: number;
  lng?: number;
  label?: string;
};

type Suggestion = AddressParts & { label: string };

type AddressAutocompleteProps = {
  /** Street line value */
  value: string;
  onChange: (street: string) => void;
  /** Called when user picks a suggestion — fills city/state/zip */
  onSelect?: (parts: AddressParts) => void;
  className?: string;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  /** Optional city/state to bias free-form query */
  cityHint?: string;
  stateHint?: string;
};

/**
 * Street address input with Nominatim suggestions via /api/address-suggest.
 * Debounced; keyboard navigable.
 *
 * Does not open a suggestions popup for prefilled lead data — only while the
 * user is focused and actively typing.
 */
export default function AddressAutocomplete({
  value,
  onChange,
  onSelect,
  className = '',
  placeholder = 'Start typing an address…',
  id,
  disabled,
  cityHint,
  stateHint,
}: AddressAutocompleteProps) {
  const listId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [hi, setHi] = useState(0);
  const seq = useRef(0);
  /** Only fetch while focused and user has typed (not for existing lead data). */
  const [active, setActive] = useState(false);
  /** After a pick, ignore the value until the user types again. */
  const suppressQueryRef = useRef<string | null>(null);

  const fetchSuggestions = useCallback(
    async (q: string) => {
      const query = q.trim();
      if (query.length < 3) {
        setItems([]);
        setOpen(false);
        return;
      }
      if (suppressQueryRef.current != null && query === suppressQueryRef.current) {
        setItems([]);
        setOpen(false);
        return;
      }
      const idn = ++seq.current;
      setLoading(true);
      try {
        let full = query;
        if (cityHint || stateHint) {
          full = [query, cityHint, stateHint].filter(Boolean).join(', ');
        }
        const res = await fetch(
          `/api/address-suggest?q=${encodeURIComponent(full)}`,
          { headers: { Accept: 'application/json' }, cache: 'no-store' }
        );
        if (idn !== seq.current) return;
        if (!res.ok) {
          setItems([]);
          setOpen(false);
          return;
        }
        const data = (await res.json()) as { suggestions?: Suggestion[] };
        const list = data.suggestions || [];
        setItems(list);
        setOpen(list.length > 0);
        setHi(0);
      } catch {
        if (idn === seq.current) {
          setItems([]);
          setOpen(false);
        }
      } finally {
        if (idn === seq.current) setLoading(false);
      }
    },
    [cityHint, stateHint]
  );

  // Debounce suggestions only while the user is actively typing
  useEffect(() => {
    if (!active) return;
    const t = window.setTimeout(() => {
      void fetchSuggestions(value);
    }, 320);
    return () => window.clearTimeout(t);
  }, [value, fetchSuggestions, active]);

  // Click outside
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setActive(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const pick = (s: Suggestion) => {
    const street = s.street || s.label;
    suppressQueryRef.current = street.trim();
    onChange(street);
    onSelect?.({
      street,
      city: s.city,
      state: s.state,
      zip: s.zip,
      lat: s.lat,
      lng: s.lng,
      label: s.label,
    });
    setOpen(false);
    setItems([]);
    setActive(false);
    setLoading(false);
    seq.current += 1; // cancel in-flight
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open || items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHi((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(items[hi] || items[0]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActive(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative w-full">
      <input
        id={id}
        type="text"
        autoComplete="street-address"
        disabled={disabled}
        value={value}
        placeholder={placeholder}
        className={className}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        onChange={(e) => {
          const next = e.target.value;
          // User is typing — allow suggestions again
          if (
            suppressQueryRef.current != null &&
            next.trim() !== suppressQueryRef.current
          ) {
            suppressQueryRef.current = null;
          }
          setActive(true);
          onChange(next);
        }}
        onFocus={() => {
          // Focus alone does not re-open suggestions for existing lead data
          // (only typing sets active). Keep prior items closed.
          setOpen(false);
        }}
        onBlur={() => {
          // Delay so mousedown on a suggestion can fire first
          window.setTimeout(() => {
            if (!wrapRef.current?.contains(document.activeElement)) {
              setActive(false);
              setOpen(false);
            }
          }, 150);
        }}
        onKeyDown={onKeyDown}
      />
      {loading && active && (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-zinc-400">
          …
        </span>
      )}
      {open && active && items.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 top-full z-[50] mt-1 max-h-56 overflow-y-auto rounded-xl border border-zinc-200 bg-white shadow-sm ring-1 ring-black/5 py-1"
        >
          {items.map((s, i) => (
            <li key={`${s.label}-${i}`} role="option" aria-selected={i === hi}>
              <button
                type="button"
                className={`w-full text-left px-3 py-2.5 text-sm transition-colors ${
                  i === hi
                    ? 'bg-zinc-100 text-zinc-900'
                    : 'text-zinc-700 hover:bg-zinc-50'
                }`}
                onMouseEnter={() => setHi(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
              >
                <div className="font-medium truncate">{s.street || s.label}</div>
                <div className="text-xs text-zinc-500 truncate">
                  {[s.city, s.state, s.zip].filter(Boolean).join(', ') || s.label}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
