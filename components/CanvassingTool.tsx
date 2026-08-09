'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';
import AddressAutocomplete, {
  type AddressParts,
} from '@/components/AddressAutocomplete';
import CanvassMap from '@/components/CanvassMap';
import {
  DISPOSITIONS,
  dispositionStyle,
  isMissingTableError,
  localDateKey,
  type CanvassPin,
  type CreatedLeadInfo,
  type Disposition,
  type PropertyLookupData,
  type TallyEntry,
  type TallyType,
} from '@/lib/canvassing';

const PINS_STORAGE_KEY = 'summitCanvassPins';
const TALLIES_STORAGE_KEY = 'summitCanvassTallies';

function loadLocal<T>(key: string): T[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function saveLocal<T>(key: string, value: T[]) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota */
  }
}

function newLocalId(): number {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

function money(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return `$${Math.round(n).toLocaleString()}`;
}

type StatAccent = {
  text: string;
  ring: string;
  chip: string;
};

const STAT_ACCENTS: Record<TallyType, StatAccent> = {
  door: {
    text: 'text-zinc-900',
    ring: 'focus-visible:ring-zinc-300',
    chip: 'bg-zinc-900',
  },
  conversation: {
    text: 'text-steel',
    ring: 'focus-visible:ring-steel-soft',
    chip: 'bg-steel',
  },
  signed: {
    text: 'text-emerald-700',
    ring: 'focus-visible:ring-emerald-300',
    chip: 'bg-emerald-600',
  },
};

const STAT_FLASH: Record<TallyType, string> = {
  door: 'rgba(24, 24, 27, 0.18)',
  conversation: 'color-mix(in srgb, var(--steel) 20%, transparent)',
  signed: 'rgba(5, 150, 105, 0.2)',
};

const STAT_CARDS: { type: TallyType; label: string }[] = [
  { type: 'door', label: 'Doors knocked' },
  { type: 'conversation', label: 'Conversations' },
  { type: 'signed', label: 'Signed' },
];

type CanvassingToolProps = {
  /**
   * Hook into the app's existing lead-creation pipeline (same `leads` Supabase
   * table + shape as leads created anywhere else). Returns null on failure.
   */
  onCreateLead: (input: {
    address: string | null;
    ownerName: string | null;
    lat: number;
    lng: number;
  }) => Promise<CreatedLeadInfo | null>;
  /** Jump back into the Leads pipeline for a pin that already has a lead. */
  onOpenLead?: (leadRef: string) => void;
  /** Reuse the app's single global toast instead of a second one. */
  showToast: (message: string) => void;
  /** Return to Tools — same exit affordance as every other full workspace. */
  onBack: () => void;
};

export default function CanvassingTool({
  onCreateLead,
  onOpenLead,
  showToast,
  onBack,
}: CanvassingToolProps) {
  const supabase = useMemo(() => getSupabase(), []);
  const supabaseEnabled = isSupabaseConfigured() && supabase != null;

  const [pins, setPins] = useState<CanvassPin[]>([]);
  const [tallies, setTallies] = useState<TallyEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Whether pins/tallies currently read+write through Supabase. Flips to
  // false (session-only) the moment either table proves unavailable — e.g.
  // the setup SQL hasn't been run yet — so the tool keeps working offline
  // instead of silently failing to save.
  const [pinsRemote, setPinsRemote] = useState(supabaseEnabled);
  const [talliesRemote, setTalliesRemote] = useState(supabaseEnabled);
  const warnedSetupRef = useRef(false);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [flyTo, setFlyTo] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [addressSearch, setAddressSearch] = useState('');
  const [pinFilter, setPinFilter] = useState<'all' | 'today'>('all');
  const [pulse, setPulse] = useState<Record<TallyType, number>>({
    door: 0,
    conversation: 0,
    signed: 0,
  });
  // Pin ids with an automatic (fire-and-forget, on-drop) property lookup still
  // in flight — drives the pending state in the detail panel with no manual
  // trigger involved.
  const [autoLookupPendingIds, setAutoLookupPendingIds] = useState<Set<number>>(
    () => new Set()
  );

  // Initial load — Supabase when configured, localStorage otherwise (matches the
  // rest of the app's offline-first pattern). Falls back per-table if either
  // canvass_pins or canvass_tallies isn't reachable yet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let nextPins: CanvassPin[] = [];
      let nextTallies: TallyEntry[] = [];
      let pinsOk = supabaseEnabled;
      let talliesOk = supabaseEnabled;

      if (supabaseEnabled && supabase) {
        const [pinsRes, talliesRes] = await Promise.all([
          supabase
            .from('canvass_pins')
            .select('*')
            .order('created_at', { ascending: false }),
          supabase
            .from('canvass_tallies')
            .select('*')
            .order('created_at', { ascending: false }),
        ]);

        if (pinsRes.error) {
          console.warn('canvass_pins unavailable, using local storage:', pinsRes.error.message);
          pinsOk = false;
          nextPins = loadLocal<CanvassPin>(PINS_STORAGE_KEY);
        } else {
          nextPins = (pinsRes.data || []) as CanvassPin[];
        }

        if (talliesRes.error) {
          console.warn('canvass_tallies unavailable, using local storage:', talliesRes.error.message);
          talliesOk = false;
          nextTallies = loadLocal<TallyEntry>(TALLIES_STORAGE_KEY);
        } else {
          nextTallies = (talliesRes.data || []) as TallyEntry[];
        }
      } else {
        nextPins = loadLocal<CanvassPin>(PINS_STORAGE_KEY);
        nextTallies = loadLocal<TallyEntry>(TALLIES_STORAGE_KEY);
      }

      if (cancelled) return;
      if (supabaseEnabled && (!pinsOk || !talliesOk) && !warnedSetupRef.current) {
        warnedSetupRef.current = true;
        showToast('Canvassing tables not set up yet — tracking on this device for now');
      }
      setPins(nextPins);
      setTallies(nextTallies);
      setPinsRemote(pinsOk);
      setTalliesRemote(talliesOk);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
    // Mount-only: `supabase` is a stable singleton and `showToast` is only used
    // for a one-time setup notice, not something this effect should re-run for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror to localStorage whenever a table is running in local (non-Supabase) mode.
  useEffect(() => {
    if (loaded && !pinsRemote) saveLocal(PINS_STORAGE_KEY, pins);
  }, [pins, loaded, pinsRemote]);
  useEffect(() => {
    if (loaded && !talliesRemote) saveLocal(TALLIES_STORAGE_KEY, tallies);
  }, [tallies, loaded, talliesRemote]);

  const selectedPin = useMemo(
    () => pins.find((p) => p.id === selectedId) || null,
    [pins, selectedId]
  );

  const patchPin = useCallback(
    async (id: number, patch: Partial<CanvassPin>) => {
      const stampedPatch = { ...patch, updated_at: new Date().toISOString() };
      setPins((prev) =>
        prev.map((p) => (p.id === id ? { ...p, ...stampedPatch } : p))
      );
      if (pinsRemote && supabase) {
        const { error } = await supabase
          .from('canvass_pins')
          .update(patch)
          .eq('id', id);
        if (error) {
          console.warn('canvass_pins update error:', error.message);
          showToast('Update failed — check connection');
        }
      }
    },
    [supabase, pinsRemote, showToast]
  );

  const fetchPropertyData = useCallback(
    async (
      pin: CanvassPin,
      opts: { silent?: boolean } = {}
    ): Promise<PropertyLookupData> => {
      const res = await fetch(
        `/api/property-lookup?lat=${pin.lat}&lng=${pin.lng}`,
        { cache: 'no-store' }
      );
      const data = (await res.json()) as PropertyLookupData;
      const stamped: PropertyLookupData = {
        ...data,
        fetchedAt: new Date().toISOString(),
      };
      const patch: Partial<CanvassPin> = { property_data: stamped };
      if (!pin.owner_name && data.ownerName) {
        patch.owner_name = data.ownerName;
      }
      await patchPin(pin.id, patch);
      if (!data.available && !opts.silent) {
        showToast('No public parcel data here — Maricopa/Pima County, AZ only');
      }
      return stamped;
    },
    [patchPin, showToast]
  );

  /**
   * Fire-and-forget property lookup kicked off the instant a pin exists — Joe
   * doesn't want a manual "load" step. Silent on a miss (no toast spam); the
   * detail panel resolves its own pending → found/not-found state from the
   * pin's `property_data` once this settles.
   */
  const runAutoPropertyLookup = useCallback(
    async (pin: CanvassPin) => {
      setAutoLookupPendingIds((prev) => new Set(prev).add(pin.id));
      try {
        await fetchPropertyData(pin, { silent: true });
      } catch (err) {
        console.warn('automatic property lookup failed:', err);
      } finally {
        setAutoLookupPendingIds((prev) => {
          if (!prev.has(pin.id)) return prev;
          const next = new Set(prev);
          next.delete(pin.id);
          return next;
        });
      }
    },
    [fetchPropertyData]
  );

  const createPin = useCallback(
    async (
      point: { lat: number; lng: number },
      address: string | null
    ): Promise<CanvassPin | null> => {
      const now = new Date().toISOString();
      const base = {
        lat: point.lat,
        lng: point.lng,
        address,
        owner_name: null as string | null,
        property_data: {} as Record<string, never>,
        disposition: 'not_contacted' as Disposition,
        status_changed_at: now,
        notes: null as string | null,
        lead_id: null as string | null,
      };

      let pin: CanvassPin | null = null;

      if (pinsRemote && supabase) {
        const { data, error } = await supabase
          .from('canvass_pins')
          .insert(base)
          .select('*')
          .single();
        if (!error && data) {
          pin = data as CanvassPin;
        } else {
          // Cloud write failed (setup SQL not run yet, offline, etc). Drop the
          // pin locally right now rather than losing it — this is the one flow
          // Joe called out as a hard blocker, so it must never silently fail.
          console.warn('canvass_pins insert failed, saving locally:', error?.message);
          if (isMissingTableError(error) && !warnedSetupRef.current) {
            warnedSetupRef.current = true;
            showToast('Canvassing tables not set up yet — tracking on this device for now');
          } else if (!isMissingTableError(error)) {
            showToast('Could not reach the cloud — pin saved on this device');
          }
          setPinsRemote(false);
        }
      }

      if (!pin) {
        pin = { id: newLocalId(), created_at: now, updated_at: now, ...base };
      }

      setPins((prev) => [pin as CanvassPin, ...prev]);
      setSelectedId(pin.id);
      setFlyTo(point);
      // Automatic — no button, no waiting for the panel to open.
      void runAutoPropertyLookup(pin);
      return pin;
    },
    [supabase, pinsRemote, showToast, runAutoPropertyLookup]
  );

  const dropPinAt = useCallback(
    async (point: { lat: number; lng: number }, address?: string | null) => {
      const pin = await createPin(point, address ?? null);
      if (!pin || address) return;
      // Best-effort reverse geocode — pin is already usable without this.
      try {
        const res = await fetch(
          `/api/reverse-geocode?lat=${point.lat}&lng=${point.lng}`,
          { cache: 'no-store' }
        );
        if (res.ok) {
          const data = (await res.json()) as { address?: string | null };
          if (data?.address) await patchPin(pin.id, { address: data.address });
        }
      } catch {
        /* manual entry still works */
      }
    },
    [createPin, patchPin]
  );

  const useMyLocation = useCallback(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      showToast('Location not available on this device');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        void dropPinAt({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        setLocating(false);
        showToast('Could not get your location — check permissions');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }, [dropPinAt, showToast]);

  const handleAddressSelect = useCallback(
    (parts: AddressParts) => {
      if (typeof parts.lat !== 'number' || typeof parts.lng !== 'number') {
        showToast('No coordinates for that address — try another suggestion');
        return;
      }
      const label =
        parts.label ||
        [parts.street, parts.city, parts.state, parts.zip]
          .filter(Boolean)
          .join(', ');
      setAddressSearch('');
      void dropPinAt({ lat: parts.lat, lng: parts.lng }, label || parts.street);
    },
    [dropPinAt, showToast]
  );

  const changeDisposition = useCallback(
    (pin: CanvassPin, next: Disposition) => {
      if (pin.disposition === next) return;
      void patchPin(pin.id, {
        disposition: next,
        status_changed_at: new Date().toISOString(),
      });
    },
    [patchPin]
  );

  const saveField = useCallback(
    (pin: CanvassPin, field: 'owner_name' | 'address' | 'notes', value: string) => {
      const trimmed = value.trim();
      if (trimmed === (pin[field] || '')) return;
      void patchPin(pin.id, { [field]: trimmed || null });
    },
    [patchPin]
  );

  const deletePin = useCallback(
    (pin: CanvassPin) => {
      if (typeof window !== 'undefined' && !window.confirm('Remove this pin?')) {
        return;
      }
      setPins((prev) => prev.filter((p) => p.id !== pin.id));
      setSelectedId((id) => (id === pin.id ? null : id));
      if (pinsRemote && supabase) {
        void supabase
          .from('canvass_pins')
          .delete()
          .eq('id', pin.id)
          .then(({ error }) => {
            if (error) {
              console.warn('canvass_pins delete error:', error.message);
              showToast('Delete failed — check connection');
            }
          });
      }
    },
    [supabase, pinsRemote, showToast]
  );

  const confirmCreateLead = useCallback(
    async (pin: CanvassPin, ownerName: string): Promise<boolean> => {
      const result = await onCreateLead({
        address: pin.address,
        ownerName: ownerName.trim() || null,
        lat: pin.lat,
        lng: pin.lng,
      });
      if (!result) {
        showToast('Could not create lead');
        return false;
      }
      const leadRef = result.supabaseLeadId || String(result.leadNumericId);
      await patchPin(pin.id, { lead_id: leadRef });
      return true;
    },
    [onCreateLead, patchPin, showToast]
  );

  const logTally = useCallback(
    async (type: TallyType) => {
      const now = new Date().toISOString();
      if (talliesRemote && supabase) {
        const { data, error } = await supabase
          .from('canvass_tallies')
          .insert({ type })
          .select('*')
          .single();
        if (!error && data) {
          setTallies((prev) => [data as TallyEntry, ...prev]);
          return;
        }
        console.warn('canvass_tallies insert failed, saving locally:', error?.message);
        if (isMissingTableError(error) && !warnedSetupRef.current) {
          warnedSetupRef.current = true;
          showToast('Canvassing tables not set up yet — tracking on this device for now');
        }
        setTalliesRemote(false);
      }
      setTallies((prev) => [
        { id: newLocalId(), created_at: now, type },
        ...prev,
      ]);
    },
    [supabase, talliesRemote, showToast]
  );

  const undoTally = useCallback(
    (type: TallyType) => {
      const todayKey = localDateKey();
      const todays = tallies.filter(
        (t) => t.type === type && localDateKey(t.created_at) === todayKey
      );
      if (todays.length === 0) return;
      const target = todays.reduce((latest, t) =>
        new Date(t.created_at) > new Date(latest.created_at) ? t : latest
      );
      setTallies((prev) => prev.filter((t) => t.id !== target.id));
      if (talliesRemote && supabase) {
        void supabase
          .from('canvass_tallies')
          .delete()
          .eq('id', target.id)
          .then(({ error }) => {
            if (error) console.warn('canvass_tallies delete error:', error.message);
          });
      }
    },
    [tallies, talliesRemote, supabase]
  );

  const handleIncrement = useCallback(
    (type: TallyType) => {
      setPulse((p) => ({ ...p, [type]: p[type] + 1 }));
      void logTally(type);
    },
    [logTally]
  );

  const todayKey = localDateKey();

  const stats: Record<TallyType, { auto: number; manual: number }> = useMemo(() => {
    const doorsAuto = pins.filter((p) => localDateKey(p.created_at) === todayKey).length;
    const conversationsAuto = pins.filter(
      (p) =>
        localDateKey(p.status_changed_at) === todayKey &&
        p.disposition !== 'not_contacted' &&
        p.disposition !== 'not_home'
    ).length;
    const signedAuto = pins.filter(
      (p) => localDateKey(p.status_changed_at) === todayKey && p.disposition === 'signed'
    ).length;
    const manualCount = (type: TallyType) =>
      tallies.filter((t) => t.type === type && localDateKey(t.created_at) === todayKey).length;
    return {
      door: { auto: doorsAuto, manual: manualCount('door') },
      conversation: { auto: conversationsAuto, manual: manualCount('conversation') },
      signed: { auto: signedAuto, manual: manualCount('signed') },
    };
  }, [pins, tallies, todayKey]);

  const visiblePins = useMemo(() => {
    const base = pinFilter === 'today'
      ? pins.filter((p) => localDateKey(p.created_at) === todayKey)
      : pins;
    return [...base].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  }, [pins, pinFilter, todayKey]);

  return (
    <div className="page-shell page-fade">
      <button
        type="button"
        onClick={onBack}
        className="text-sm text-zinc-500 hover:text-zinc-800 mb-3 inline-flex items-center gap-1"
      >
        ← Back to Tools
      </button>

      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold text-zinc-900 tracking-tight">
          Canvassing
        </h1>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {STAT_CARDS.map((cfg) => {
          const s = stats[cfg.type];
          return (
            <StatCard
              key={cfg.type}
              label={cfg.label}
              total={s.auto + s.manual}
              autoCount={s.auto}
              accent={STAT_ACCENTS[cfg.type]}
              flashColor={STAT_FLASH[cfg.type]}
              pulseNonce={pulse[cfg.type]}
              onIncrement={() => handleIncrement(cfg.type)}
              onDecrement={() => undoTally(cfg.type)}
              canDecrement={s.manual > 0}
            />
          );
        })}
      </div>

      <div className="rounded-3xl border border-zinc-200 bg-white p-5 sm:p-6 mb-6">
        <div className="flex flex-col sm:flex-row gap-3">
          <button
            type="button"
            onClick={useMyLocation}
            disabled={locating}
            className="btn-primary px-5 py-3 rounded-2xl text-sm font-semibold whitespace-nowrap disabled:opacity-50 inline-flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 21c-4.5-4.2-7-7.9-7-11a7 7 0 1 1 14 0c0 3.1-2.5 6.8-7 11Z" />
              <circle cx="12" cy="10" r="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {locating ? 'Finding you…' : 'Drop pin at my location'}
          </button>
          <div className="flex-1 relative">
            <svg
              className="w-4 h-4 text-zinc-400 absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              viewBox="0 0 24 24"
              aria-hidden
            >
              <circle cx="11" cy="11" r="7" />
              <path strokeLinecap="round" d="m20 20-3.2-3.2" />
            </svg>
            <AddressAutocomplete
              value={addressSearch}
              onChange={setAddressSearch}
              onSelect={handleAddressSelect}
              placeholder="Or search an address to drop a pin there…"
              className="w-full rounded-2xl border border-zinc-200 pl-10 pr-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-300/50"
            />
          </div>
        </div>
      </div>

      <CanvassMap
        pins={pins}
        selectedPinId={selectedId}
        onSelectPin={setSelectedId}
        onMapDrop={(point) => void dropPinAt(point)}
        center={flyTo}
        height={480}
        className="mb-6"
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4">
        <div className="rounded-3xl border border-zinc-200 bg-white p-5 sm:p-6">
          {!selectedPin ? (
            <div className="flex flex-col items-center justify-center py-14 text-center">
              <div className="w-11 h-11 rounded-full bg-zinc-100 flex items-center justify-center mb-3">
                <svg className="w-5 h-5 text-zinc-400" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 21c-4.5-4.2-7-7.9-7-11a7 7 0 1 1 14 0c0 3.1-2.5 6.8-7 11Z" />
                  <circle cx="12" cy="10" r="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div className="text-sm text-zinc-500">
                Drop a pin or select one on the map to see details
              </div>
            </div>
          ) : (
            <PinDetailPanel
              key={selectedPin.id}
              pin={selectedPin}
              onChangeDisposition={changeDisposition}
              onSaveField={saveField}
              onDelete={deletePin}
              onFetchPropertyData={fetchPropertyData}
              onConfirmCreateLead={confirmCreateLead}
              onOpenLead={onOpenLead}
              autoLookupPending={autoLookupPendingIds.has(selectedPin.id)}
            />
          )}
        </div>

        {/* All pins */}
        <div className="rounded-3xl border border-zinc-200 bg-white p-5 sm:p-6">
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="text-sm font-semibold text-zinc-900">
              Pins
              {pins.length > 0 ? (
                <span className="font-normal text-zinc-400"> · {pins.length}</span>
              ) : null}
            </div>
            <div className="inline-flex rounded-xl border border-zinc-200 bg-zinc-50 p-0.5">
              {(['all', 'today'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setPinFilter(f)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                    pinFilter === f
                      ? 'bg-white text-zinc-900 shadow-sm'
                      : 'text-zinc-500 hover:text-zinc-700'
                  }`}
                >
                  {f === 'all' ? 'All' : 'Today'}
                </button>
              ))}
            </div>
          </div>
          {visiblePins.length === 0 ? (
            <div className="text-sm text-zinc-500 py-6 text-center">
              {pinFilter === 'today' ? 'No pins dropped today yet' : 'No pins yet'}
            </div>
          ) : (
            <div className="space-y-2 max-h-[560px] overflow-y-auto -mx-1 px-1">
              {visiblePins.map((pin) => {
                const style = dispositionStyle(pin.disposition);
                const active = pin.id === selectedId;
                return (
                  <button
                    key={pin.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(pin.id);
                      setFlyTo({ lat: pin.lat, lng: pin.lng });
                    }}
                    className={`w-full text-left rounded-2xl border px-3 py-2.5 transition-colors ${
                      active
                        ? 'border-zinc-900 bg-zinc-50'
                        : 'border-zinc-200 hover:bg-zinc-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-zinc-900 truncate">
                        {pin.address || `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`}
                      </span>
                      <span
                        className={`shrink-0 w-2 h-2 rounded-full ${style.dot}`}
                      />
                    </div>
                    <div className="text-xs text-zinc-400 mt-0.5">
                      {style.label} · {new Date(pin.created_at).toLocaleDateString()}
                      {pin.lead_id ? ' · Lead created' : ''}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type StatCardProps = {
  label: string;
  total: number;
  autoCount: number;
  accent: StatAccent;
  flashColor: string;
  pulseNonce: number;
  onIncrement: () => void;
  onDecrement: () => void;
  canDecrement: boolean;
};

/**
 * Daily dashboard card — tap anywhere on the card (or its + affordance) to log
 * one now; a small − control undoes the most recent manual tap for today.
 * Pin-derived activity ("N from pins") is folded into the same total so this
 * is one honest daily number, not a second, disconnected counter.
 */
function StatCard({
  label,
  total,
  autoCount,
  accent,
  flashColor,
  pulseNonce,
  onIncrement,
  onDecrement,
  canDecrement,
}: StatCardProps) {
  const [flash, setFlash] = useState(false);
  const isFirst = useRef(true);

  useEffect(() => {
    if (isFirst.current) {
      isFirst.current = false;
      return;
    }
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), 420);
    return () => window.clearTimeout(t);
  }, [pulseNonce]);

  return (
    <div
      className={`relative rounded-3xl border border-zinc-200 bg-white p-5 ${
        flash ? 'tally-card-flash' : ''
      }`}
      style={flash ? ({ '--tally-flash': flashColor } as CSSProperties) : undefined}
    >
      <button
        type="button"
        onClick={onIncrement}
        aria-label={`Log a ${label.toLowerCase()} entry`}
        className={`absolute inset-0 z-0 rounded-3xl focus:outline-none focus-visible:ring-2 ${accent.ring} active:bg-zinc-50/80 transition-colors`}
      />
      <div className="relative z-10 flex items-start justify-between gap-2">
        <div className="text-[11px] uppercase tracking-wide text-zinc-400 font-medium">
          {label} today
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDecrement();
          }}
          disabled={!canDecrement}
          aria-label={`Remove last ${label.toLowerCase()} entry`}
          className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-base font-semibold leading-none transition-colors ${
            canDecrement
              ? 'text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100'
              : 'text-zinc-200'
          }`}
        >
          −
        </button>
      </div>
      <div
        key={pulseNonce}
        className={`relative z-10 pointer-events-none text-4xl font-semibold tabular-nums ${accent.text} mt-1`}
      >
        <span className={pulseNonce > 0 ? 'tally-pop' : ''}>{total}</span>
      </div>
      <div className="relative z-10 pointer-events-none flex items-center justify-between mt-3">
        <span className="text-xs text-zinc-400">
          {autoCount > 0 ? `${autoCount} from pins` : 'Tap card to log one'}
        </span>
        <span
          className={`w-6 h-6 rounded-full ${accent.chip} text-white inline-flex items-center justify-center`}
        >
          {/* SVG, not a text "+" glyph — font metrics (ascent/descent, line-height)
              made a text character sit slightly off-center; a path centered on
              the 24x24 viewBox lines up exactly regardless of font. */}
          <svg
            className="w-3 h-3"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </span>
      </div>
    </div>
  );
}

type PinDetailPanelProps = {
  pin: CanvassPin;
  onChangeDisposition: (pin: CanvassPin, next: Disposition) => void;
  onSaveField: (
    pin: CanvassPin,
    field: 'owner_name' | 'address' | 'notes',
    value: string
  ) => void;
  onDelete: (pin: CanvassPin) => void;
  onFetchPropertyData: (pin: CanvassPin) => Promise<PropertyLookupData>;
  onConfirmCreateLead: (pin: CanvassPin, ownerName: string) => Promise<boolean>;
  onOpenLead?: (leadRef: string) => void;
  /** True while the automatic (fire-and-forget) lookup kicked off on drop is in flight. */
  autoLookupPending: boolean;
};

/**
 * Detail/editor for one selected pin. Kept as its own component (mounted with
 * `key={pin.id}` by the parent) so switching pins resets draft state for free —
 * no effect-driven state sync needed.
 */
function PinDetailPanel({
  pin,
  onChangeDisposition,
  onSaveField,
  onDelete,
  onFetchPropertyData,
  onConfirmCreateLead,
  onOpenLead,
  autoLookupPending,
}: PinDetailPanelProps) {
  const [ownerDraft, setOwnerDraft] = useState(pin.owner_name || '');
  const [addressDraft, setAddressDraft] = useState(pin.address || '');
  const [notesDraft, setNotesDraft] = useState(pin.notes || '');
  const [manualLookupLoading, setManualLookupLoading] = useState(false);
  const [showCreateLead, setShowCreateLead] = useState(false);
  const [createLeadName, setCreateLeadName] = useState(pin.owner_name || '');
  const [creatingLead, setCreatingLead] = useState(false);

  const style = dispositionStyle(pin.disposition);
  // Always derived straight from the pin — this is what makes the automatic,
  // on-drop lookup show up with no manual step: as soon as the parent patches
  // `property_data` after the background fetch resolves, this pin prop
  // updates and the result renders here on its own.
  const propertyData: PropertyLookupData | null =
    pin.property_data && (pin.property_data as PropertyLookupData).fetchedAt
      ? (pin.property_data as PropertyLookupData)
      : null;
  const propertyLoading = autoLookupPending || manualLookupLoading;

  const runFetchPropertyData = async () => {
    setManualLookupLoading(true);
    try {
      const data = await onFetchPropertyData(pin);
      if (!pin.owner_name && data.ownerName) setOwnerDraft(data.ownerName);
    } catch (err) {
      console.warn('property lookup failed:', err);
    } finally {
      setManualLookupLoading(false);
    }
  };

  const runConfirmCreateLead = async () => {
    setCreatingLead(true);
    try {
      const ok = await onConfirmCreateLead(pin, createLeadName);
      if (ok) setShowCreateLead(false);
    } finally {
      setCreatingLead(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${style.badge}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
            {style.label}
          </div>
          <div className="text-xs text-zinc-400 mt-2">
            Dropped {new Date(pin.created_at).toLocaleString()}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onDelete(pin)}
          className="text-xs font-medium text-red-600 hover:text-red-700"
        >
          Remove pin
        </button>
      </div>

      <div>
        <label className="block text-[11px] font-medium text-zinc-400 mb-1.5">
          Address
        </label>
        <input
          type="text"
          value={addressDraft}
          onChange={(e) => setAddressDraft(e.target.value)}
          onBlur={() => onSaveField(pin, 'address', addressDraft)}
          placeholder="Not set — type an address"
          className="w-full rounded-2xl border border-zinc-200 px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-300/50"
        />
      </div>

      <div>
        <label className="block text-[11px] font-medium text-zinc-400 mb-1.5">
          Disposition
        </label>
        <div className="flex flex-wrap gap-2">
          {DISPOSITIONS.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => onChangeDisposition(pin, d.id)}
              className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                pin.disposition === d.id
                  ? d.badge
                  : 'bg-white border-zinc-200 text-zinc-500 hover:bg-zinc-50'
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="block text-[11px] font-medium text-zinc-400">
            Owner name (manual entry)
          </label>
          {propertyData?.ownerName && propertyData.ownerName !== ownerDraft ? (
            <button
              type="button"
              onClick={() => {
                const name = propertyData.ownerName || '';
                setOwnerDraft(name);
                onSaveField(pin, 'owner_name', name);
              }}
              className="text-[11px] font-medium text-graphite hover:text-graphite-hover"
            >
              Use “{propertyData.ownerName}”
            </button>
          ) : null}
        </div>
        <input
          type="text"
          value={ownerDraft}
          onChange={(e) => setOwnerDraft(e.target.value)}
          onBlur={() => onSaveField(pin, 'owner_name', ownerDraft)}
          placeholder="Not known yet"
          className="w-full rounded-2xl border border-zinc-200 px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-300/50"
        />
      </div>

      <div>
        <label className="block text-[11px] font-medium text-zinc-400 mb-1.5">
          Notes
        </label>
        <textarea
          value={notesDraft}
          onChange={(e) => setNotesDraft(e.target.value)}
          onBlur={() => onSaveField(pin, 'notes', notesDraft)}
          placeholder="What happened at this door…"
          rows={3}
          className="w-full rounded-2xl border border-zinc-200 px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-300/50 resize-none"
        />
      </div>

      {/* Free public property data (Zillow-style radar) — fetched automatically
          the moment the pin is dropped, no manual "load" step. */}
      <div className="rounded-2xl border border-zinc-200 bg-zinc-50/70 p-4">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="text-xs font-semibold text-zinc-700">
            Property data
          </div>
          {propertyData ? (
            <button
              type="button"
              onClick={() => void runFetchPropertyData()}
              disabled={propertyLoading}
              className="text-xs font-medium text-graphite hover:text-graphite-hover disabled:opacity-50"
            >
              {propertyLoading ? 'Refreshing…' : 'Refresh lookup'}
            </button>
          ) : propertyLoading ? (
            <span className="text-xs font-medium text-zinc-400">Looking up…</span>
          ) : (
            <button
              type="button"
              onClick={() => void runFetchPropertyData()}
              className="text-xs font-medium text-graphite hover:text-graphite-hover"
            >
              Try again
            </button>
          )}
        </div>
        {propertyLoading && !propertyData ? (
          <div className="flex items-center gap-2 text-xs text-zinc-500 py-1" aria-live="polite">
            <svg
              className="w-3.5 h-3.5 animate-spin text-zinc-400 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden
            >
              <circle className="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" />
              <path
                className="opacity-90"
                d="M21 12a9 9 0 0 0-9-9"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </svg>
            Checking county records for this address…
          </div>
        ) : !propertyData ? (
          <p className="text-xs text-zinc-500">
            No public parcel record found here — Maricopa/Pima County, AZ
            coverage only. Add owner name manually above.
          </p>
        ) : propertyData.available ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div>
              <div className="text-[11px] text-zinc-400">Owner of record</div>
              <div className="text-zinc-900 font-medium">
                {propertyData.ownerName || '—'}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-zinc-400">Year built</div>
              <div className="text-zinc-900 font-medium">
                {propertyData.yearBuilt || '—'}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-zinc-400">Assessed value</div>
              <div className="text-zinc-900 font-medium">
                {money(propertyData.assessedValue) || '—'}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-zinc-400">Source</div>
              <div className="text-zinc-900 font-medium">
                {propertyData.source === 'maricopa'
                  ? 'Maricopa County Assessor'
                  : propertyData.source === 'pima'
                    ? 'Pima County Assessor'
                    : '—'}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-xs text-zinc-500">
            No public parcel record found here — Maricopa/Pima County, AZ
            coverage only. Add owner name manually above.
          </p>
        )}
      </div>

      {/* Create lead */}
      <div className="pt-1 border-t border-zinc-100">
        {pin.lead_id ? (
          <div className="flex items-center justify-between gap-3 pt-4">
            <div className="text-sm font-medium text-emerald-700">
              ✓ Lead created from this pin
            </div>
            {onOpenLead ? (
              <button
                type="button"
                onClick={() => onOpenLead(pin.lead_id as string)}
                className="text-sm font-medium text-graphite hover:text-graphite-hover"
              >
                Open lead
              </button>
            ) : null}
          </div>
        ) : showCreateLead ? (
          <div className="pt-4 space-y-3">
            <label className="block text-[11px] font-medium text-zinc-400">
              Homeowner name (optional — you can fill this in later)
            </label>
            <input
              type="text"
              value={createLeadName}
              onChange={(e) => setCreateLeadName(e.target.value)}
              placeholder="First and last name"
              className="w-full rounded-2xl border border-zinc-200 px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-300/50"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void runConfirmCreateLead()}
                disabled={creatingLead}
                className="btn-primary px-5 py-2.5 rounded-2xl text-sm font-semibold disabled:opacity-50"
              >
                {creatingLead ? 'Creating…' : 'Confirm — create lead'}
              </button>
              <button
                type="button"
                onClick={() => setShowCreateLead(false)}
                className="px-5 py-2.5 rounded-2xl text-sm font-medium text-zinc-600 hover:bg-zinc-50"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowCreateLead(true)}
            className="mt-4 btn-primary px-5 py-2.5 rounded-2xl text-sm font-semibold"
          >
            Create lead
          </button>
        )}
      </div>
    </div>
  );
}
