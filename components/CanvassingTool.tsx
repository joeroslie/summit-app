'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';
import AddressAutocomplete, {
  type AddressParts,
} from '@/components/AddressAutocomplete';
import CanvassMap from '@/components/CanvassMap';
import {
  DISPOSITIONS,
  dispositionStyle,
  type CanvassPin,
  type CreatedLeadInfo,
  type Disposition,
  type PropertyLookupData,
} from '@/lib/canvassing';

const STORAGE_KEY = 'summitCanvassPins';

function loadLocalPins(): CanvassPin[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CanvassPin[]) : [];
  } catch {
    return [];
  }
}

function saveLocalPins(pins: CanvassPin[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pins));
  } catch {
    /* ignore quota */
  }
}

function newLocalPinId(): number {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

function isToday(iso: string | null | undefined, todayStr: string): boolean {
  return !!iso && iso.slice(0, 10) === todayStr;
}

function money(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return `$${Math.round(n).toLocaleString()}`;
}

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
};

export default function CanvassingTool({
  onCreateLead,
  onOpenLead,
  showToast,
}: CanvassingToolProps) {
  const supabase = useMemo(() => getSupabase(), []);
  const supabaseEnabled = isSupabaseConfigured() && supabase != null;

  const [pins, setPins] = useState<CanvassPin[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [flyTo, setFlyTo] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [addressSearch, setAddressSearch] = useState('');

  // Initial load — Supabase when configured, localStorage otherwise (matches the
  // rest of the app's offline-first pattern).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (supabaseEnabled && supabase) {
        try {
          const { data, error } = await supabase
            .from('canvass_pins')
            .select('*')
            .order('created_at', { ascending: false });
          if (cancelled) return;
          if (error) {
            console.error('canvass_pins load error:', error);
            setPins(loadLocalPins());
          } else {
            setPins((data || []) as CanvassPin[]);
          }
        } catch (err) {
          console.error('canvass_pins load error:', err);
          if (!cancelled) setPins(loadLocalPins());
        }
      } else if (!cancelled) {
        setPins(loadLocalPins());
      }
      if (!cancelled) setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, supabaseEnabled]);

  // Mirror to localStorage only when running without Supabase (source of truth).
  useEffect(() => {
    if (loaded && !supabaseEnabled) saveLocalPins(pins);
  }, [pins, loaded, supabaseEnabled]);

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
      if (supabaseEnabled && supabase) {
        const { error } = await supabase
          .from('canvass_pins')
          .update(patch)
          .eq('id', id);
        if (error) {
          console.error('canvass_pins update error:', error);
          showToast('Update failed — check connection');
        }
      }
    },
    [supabase, supabaseEnabled, showToast]
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

      if (supabaseEnabled && supabase) {
        const { data, error } = await supabase
          .from('canvass_pins')
          .insert(base)
          .select('*')
          .single();
        if (error || !data) {
          console.error('canvass_pins insert error:', error);
          showToast('Could not save pin — check connection');
          return null;
        }
        const pin = data as CanvassPin;
        setPins((prev) => [pin, ...prev]);
        setSelectedId(pin.id);
        setFlyTo(point);
        return pin;
      }

      const pin: CanvassPin = {
        id: newLocalPinId(),
        created_at: now,
        updated_at: now,
        ...base,
      };
      setPins((prev) => [pin, ...prev]);
      setSelectedId(pin.id);
      setFlyTo(point);
      return pin;
    },
    [supabase, supabaseEnabled, showToast]
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

  const fetchPropertyData = useCallback(
    async (pin: CanvassPin): Promise<PropertyLookupData> => {
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
      if (!data.available) {
        showToast('No public parcel data here — Maricopa/Pima County, AZ only');
      }
      return stamped;
    },
    [patchPin, showToast]
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
      if (supabaseEnabled && supabase) {
        void supabase
          .from('canvass_pins')
          .delete()
          .eq('id', pin.id)
          .then(({ error }) => {
            if (error) {
              console.error('canvass_pins delete error:', error);
              showToast('Delete failed — check connection');
            }
          });
      }
    },
    [supabase, supabaseEnabled, showToast]
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

  const todayStr = new Date().toISOString().slice(0, 10);
  const stats = useMemo(() => {
    const doorsToday = pins.filter((p) => isToday(p.created_at, todayStr)).length;
    const conversationsToday = pins.filter(
      (p) =>
        isToday(p.status_changed_at, todayStr) &&
        p.disposition !== 'not_contacted' &&
        p.disposition !== 'not_home'
    ).length;
    const signedToday = pins.filter(
      (p) => isToday(p.status_changed_at, todayStr) && p.disposition === 'signed'
    ).length;
    return { doorsToday, conversationsToday, signedToday };
  }, [pins, todayStr]);

  const sortedPins = useMemo(
    () =>
      [...pins].sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      ),
    [pins]
  );

  return (
    <div className="page-shell page-fade">
      <div className="mb-8 flex items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold text-zinc-900 tracking-tight">
          Canvassing
        </h1>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="rounded-3xl border border-zinc-200 bg-white p-5">
          <div className="text-[11px] uppercase tracking-wide text-zinc-400 font-medium">
            Doors knocked today
          </div>
          <div className="text-3xl font-semibold tabular-nums text-zinc-900 mt-1">
            {stats.doorsToday}
          </div>
        </div>
        <div className="rounded-3xl border border-zinc-200 bg-white p-5">
          <div className="text-[11px] uppercase tracking-wide text-zinc-400 font-medium">
            Conversations today
          </div>
          <div className="text-3xl font-semibold tabular-nums text-sky-700 mt-1">
            {stats.conversationsToday}
          </div>
        </div>
        <div className="rounded-3xl border border-zinc-200 bg-white p-5">
          <div className="text-[11px] uppercase tracking-wide text-zinc-400 font-medium">
            Signed today
          </div>
          <div className="text-3xl font-semibold tabular-nums text-emerald-700 mt-1">
            {stats.signedToday}
          </div>
        </div>
      </div>

      <div className="rounded-3xl border border-zinc-200 bg-white p-5 sm:p-6 mb-6">
        <div className="flex flex-col sm:flex-row gap-3">
          <button
            type="button"
            onClick={useMyLocation}
            disabled={locating}
            className="btn-primary px-5 py-3 rounded-2xl text-sm font-semibold whitespace-nowrap disabled:opacity-50"
          >
            {locating ? 'Finding you…' : 'Drop pin at my location'}
          </button>
          <div className="flex-1">
            <AddressAutocomplete
              value={addressSearch}
              onChange={setAddressSearch}
              onSelect={handleAddressSelect}
              placeholder="Or search an address to drop a pin there…"
              className="w-full rounded-2xl border border-zinc-200 px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-sky-300"
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
            <div className="text-sm text-zinc-500 py-10 text-center">
              Drop a pin or select one on the map to see details
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
            />
          )}
        </div>

        {/* All pins */}
        <div className="rounded-3xl border border-zinc-200 bg-white p-5 sm:p-6">
          <div className="text-sm font-semibold text-zinc-900 mb-3">
            All pins
            {pins.length > 0 ? (
              <span className="font-normal text-zinc-400"> · {pins.length}</span>
            ) : null}
          </div>
          {sortedPins.length === 0 ? (
            <div className="text-sm text-zinc-500 py-6 text-center">
              No pins yet
            </div>
          ) : (
            <div className="space-y-2 max-h-[560px] overflow-y-auto -mx-1 px-1">
              {sortedPins.map((pin) => {
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
}: PinDetailPanelProps) {
  const [ownerDraft, setOwnerDraft] = useState(pin.owner_name || '');
  const [addressDraft, setAddressDraft] = useState(pin.address || '');
  const [notesDraft, setNotesDraft] = useState(pin.notes || '');
  const [propertyLoading, setPropertyLoading] = useState(false);
  const [propertyData, setPropertyData] = useState<PropertyLookupData | null>(
    pin.property_data && (pin.property_data as PropertyLookupData).fetchedAt
      ? (pin.property_data as PropertyLookupData)
      : null
  );
  const [showCreateLead, setShowCreateLead] = useState(false);
  const [createLeadName, setCreateLeadName] = useState(pin.owner_name || '');
  const [creatingLead, setCreatingLead] = useState(false);

  const style = dispositionStyle(pin.disposition);

  const runFetchPropertyData = async () => {
    setPropertyLoading(true);
    try {
      const data = await onFetchPropertyData(pin);
      setPropertyData(data);
      if (!pin.owner_name && data.ownerName) setOwnerDraft(data.ownerName);
    } catch (err) {
      console.error('property lookup failed:', err);
    } finally {
      setPropertyLoading(false);
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
          className="w-full rounded-2xl border border-zinc-200 px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-sky-300"
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
              className="text-[11px] font-medium text-sky-700 hover:text-sky-800"
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
          className="w-full rounded-2xl border border-zinc-200 px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-sky-300"
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
          className="w-full rounded-2xl border border-zinc-200 px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-sky-300 resize-none"
        />
      </div>

      {/* Free public property data (Zillow-style radar) */}
      <div className="rounded-2xl border border-zinc-200 bg-zinc-50/70 p-4">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="text-xs font-semibold text-zinc-700">
            Property data
          </div>
          <button
            type="button"
            onClick={() => void runFetchPropertyData()}
            disabled={propertyLoading}
            className="text-xs font-medium text-sky-700 hover:text-sky-800 disabled:opacity-50"
          >
            {propertyLoading
              ? 'Looking up…'
              : propertyData
                ? 'Refresh lookup'
                : 'Look up property data'}
          </button>
        </div>
        {!propertyData ? (
          <p className="text-xs text-zinc-500">
            Free county-assessor lookup (Maricopa &amp; Pima County, AZ) — owner
            name, year built, assessed value.
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
                className="text-sm font-medium text-sky-700 hover:text-sky-800"
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
              className="w-full rounded-2xl border border-zinc-200 px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-sky-300"
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
