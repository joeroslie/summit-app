'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { dispositionStyle, type CanvassPin } from '@/lib/canvassing';
import {
  attachPhoneMapEdgeYield,
  phonePointerYieldsEdgeNav,
} from '@/lib/phone-nav';

type LatLngPoint = { lat: number; lng: number };

type CanvassMapProps = {
  pins: CanvassPin[];
  selectedPinId: number | null;
  onSelectPin: (id: number) => void;
  /** Tap the basemap to drop a new pin at that spot. */
  onMapDrop: (point: LatLngPoint) => void;
  /** Fly-to point — set after "Use my location" / address search / selecting a pin. */
  center?: LatLngPoint | null;
  className?: string;
  height?: number;
};

type BasemapMode = 'satellite' | 'street';

const DEFAULT_CENTER: LatLngPoint = { lat: 33.4484, lng: -112.074 }; // Phoenix, AZ

function waitForSize(el: HTMLElement, attempts = 40): Promise<void> {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = () => {
      if (el.clientWidth > 20 && el.clientHeight > 20) {
        resolve();
        return;
      }
      n += 1;
      if (n >= attempts) {
        reject(new Error('Map container has no size'));
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Canvassing pin map — twin of components/RoofTracer.tsx's Leaflet setup
 * (dynamic import, satellite/street toggle, tile-error fallback) but for
 * dropping + browsing door-knock pins instead of tracing a roof outline.
 */
export default function CanvassMap({
  pins,
  selectedPinId,
  onSelectPin,
  onMapDrop,
  center,
  className = '',
  height = 480,
}: CanvassMapProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import('leaflet').Map | null>(null);
  const groupRef = useRef<import('leaflet').FeatureGroup | null>(null);
  const satRef = useRef<import('leaflet').TileLayer | null>(null);
  const streetRef = useRef<import('leaflet').TileLayer | null>(null);
  const LRef = useRef<typeof import('leaflet') | null>(null);
  const pinsRef = useRef<CanvassPin[]>(pins);
  const selectedIdRef = useRef<number | null>(selectedPinId);
  const onSelectPinRef = useRef(onSelectPin);
  const onMapDropRef = useRef(onMapDrop);
  const initGen = useRef(0);

  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [basemap, setBasemap] = useState<BasemapMode>('satellite');
  const [tileHint, setTileHint] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    pinsRef.current = pins;
    selectedIdRef.current = selectedPinId;
    onSelectPinRef.current = onSelectPin;
    onMapDropRef.current = onMapDrop;
  }, [pins, selectedPinId, onSelectPin, onMapDrop]);

  const safeInvalidate = useCallback((map: import('leaflet').Map | null) => {
    if (!map) return;
    try {
      map.invalidateSize({ animate: false, pan: false });
    } catch {
      /* mid-destroy */
    }
  }, []);

  const redraw = useCallback(() => {
    const group = groupRef.current;
    const L = LRef.current;
    if (!group || !L) return;
    group.clearLayers();
    const selectedId = selectedIdRef.current;
    pinsRef.current.forEach((pin) => {
      const style = dispositionStyle(pin.disposition);
      const isSelected = pin.id === selectedId;
      const marker = L.circleMarker([pin.lat, pin.lng], {
        radius: isSelected ? 12 : 9,
        color: isSelected ? 'var(--graphite)' : style.markerStroke,
        weight: isSelected ? 3 : 2,
        fillColor: style.marker,
        fillOpacity: 0.95,
      });
      marker.bindTooltip(pin.address || style.label, {
        permanent: false,
        direction: 'top',
      });
      marker.on('click', (e) => {
        e.originalEvent?.stopPropagation();
        onSelectPinRef.current(pin.id);
      });
      marker.addTo(group);
    });
  }, []);

  useEffect(() => {
    redraw();
  }, [pins, selectedPinId, redraw]);

  useEffect(() => {
    const gen = ++initGen.current;
    let cancelled = false;
    let map: import('leaflet').Map | null = null;
    let resizeObs: ResizeObserver | null = null;
    let yieldEdge: (() => void) | undefined;
    let tileErrorCount = 0;
    const timers: number[] = [];

    const scheduleInvalidate = (m: import('leaflet').Map) => {
      [0, 16, 50, 100, 200, 400, 800, 1200].forEach((ms) => {
        timers.push(
          window.setTimeout(() => {
            if (!cancelled && initGen.current === gen) safeInvalidate(m);
          }, ms)
        );
      });
    };

    (async () => {
      setReady(false);
      setInitError(null);

      for (let i = 0; i < 4; i++) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
      if (cancelled || initGen.current !== gen) return;

      const el = mapEl.current;
      if (!el) {
        setInitError('Map container not ready');
        return;
      }

      el.style.height = `${height}px`;
      el.style.minHeight = `${height}px`;
      el.style.width = '100%';

      try {
        await waitForSize(el, 50);
      } catch {
        el.style.height = `${Math.max(height, 400)}px`;
        el.style.minHeight = `${Math.max(height, 400)}px`;
      }

      if (cancelled || initGen.current !== gen || !mapEl.current) return;

      let L: typeof import('leaflet');
      try {
        const Lmod = await import('leaflet');
        L = ((Lmod as { default?: typeof import('leaflet') }).default ??
          Lmod) as typeof import('leaflet');
      } catch {
        if (!cancelled) setInitError('Failed to load map library');
        return;
      }
      if (cancelled || initGen.current !== gen || !mapEl.current) return;
      LRef.current = L;

      const node = mapEl.current as HTMLElement & { _leaflet_id?: number };
      if (node._leaflet_id) {
        try {
          mapRef.current?.remove();
        } catch {
          /* ignore */
        }
        node.innerHTML = '';
        delete node._leaflet_id;
      }

      const startCenter = center || pins[0] || null;
      const start = startCenter || DEFAULT_CENTER;
      const zoom = startCenter ? 17 : 11;

      let created: import('leaflet').Map;
      try {
        created = L.map(mapEl.current, {
          center: [start.lat, start.lng],
          zoom,
          minZoom: 3,
          maxZoom: 22,
          zoomControl: true,
          attributionControl: true,
          preferCanvas: false,
          fadeAnimation: false,
          zoomAnimation: true,
        });
      } catch (err) {
        if (!cancelled) {
          setInitError(err instanceof Error ? err.message : 'Could not create map');
        }
        return;
      }
      map = created;
      yieldEdge = attachPhoneMapEdgeYield(created, created.getContainer());

      if (cancelled || initGen.current !== gen) {
        created.remove();
        return;
      }

      const googleSat = L.tileLayer(
        'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
        {
          subdomains: ['0', '1', '2', '3'],
          maxZoom: 22,
          maxNativeZoom: 21,
          tileSize: 256,
          zoomOffset: 0,
          updateWhenIdle: false,
          updateWhenZooming: true,
          keepBuffer: 2,
          attribution: 'Imagery &copy; Google',
        }
      );
      const esriSat = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        {
          maxZoom: 22,
          maxNativeZoom: 19,
          tileSize: 256,
          attribution: 'Tiles &copy; Esri',
        }
      );
      const street = L.tileLayer(
        'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        {
          maxZoom: 19,
          maxNativeZoom: 19,
          tileSize: 256,
          attribution: '&copy; OpenStreetMap',
        }
      );

      satRef.current = googleSat;
      streetRef.current = street;
      googleSat.addTo(created);

      L.control
        .layers(
          {
            'Satellite (hi-res)': googleSat,
            'Satellite (Esri)': esriSat,
            Street: street,
          },
          {},
          { position: 'topright', collapsed: false }
        )
        .addTo(created);

      const fallbackStreet = () => {
        if (!mapRef.current) return;
        try {
          if (created.hasLayer(googleSat)) created.removeLayer(googleSat);
          if (created.hasLayer(esriSat)) created.removeLayer(esriSat);
          if (!created.hasLayer(street)) street.addTo(created);
          setBasemap('street');
          setTileHint('Using street map — satellite tiles failed');
        } catch {
          /* ignore */
        }
      };

      googleSat.on('tileerror', () => {
        tileErrorCount += 1;
        if (tileErrorCount === 3) {
          try {
            if (created.hasLayer(googleSat)) created.removeLayer(googleSat);
            if (!created.hasLayer(esriSat)) esriSat.addTo(created);
            setTileHint('Switched to Esri satellite');
          } catch {
            fallbackStreet();
          }
        }
        if (tileErrorCount >= 8) fallbackStreet();
      });

      esriSat.on('tileerror', () => {
        tileErrorCount += 1;
        if (tileErrorCount >= 10) fallbackStreet();
      });

      created.on('baselayerchange', (e: { name?: string }) => {
        const name = e.name || '';
        if (name === 'Street') {
          setBasemap('street');
          setTileHint('Street map');
        } else {
          setBasemap('satellite');
          setTileHint(null);
        }
        scheduleInvalidate(created);
      });

      created.zoomControl.setPosition('topleft');

      const group = L.featureGroup().addTo(created);
      groupRef.current = group;
      mapRef.current = created;

      created.whenReady(() => {
        if (cancelled || initGen.current !== gen || !mapRef.current) return;
        scheduleInvalidate(created);
        redraw();
        created.setView([start.lat, start.lng], zoom, { animate: false });
        created.eachLayer((layer) => {
          try {
            (layer as { redraw?: () => void }).redraw?.();
          } catch {
            /* ignore */
          }
        });
        setReady(true);
      });

      created.on('click', (e: import('leaflet').LeafletMouseEvent) => {
        if (!mapRef.current) return;
        const orig = e.originalEvent as MouseEvent | undefined;
        if (orig && phonePointerYieldsEdgeNav(orig.clientX, orig)) return;
        onMapDropRef.current({ lat: e.latlng.lat, lng: e.latlng.lng });
      });

      if (typeof ResizeObserver !== 'undefined' && mapEl.current) {
        resizeObs = new ResizeObserver(() => {
          safeInvalidate(created);
        });
        resizeObs.observe(mapEl.current);
        if (wrapRef.current) resizeObs.observe(wrapRef.current);
      }

      scheduleInvalidate(created);
    })();

    return () => {
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
      resizeObs?.disconnect();
      try {
        yieldEdge?.();
      } catch {
        /* ignore */
      }
      try {
        map?.off();
        map?.remove();
      } catch {
        /* ignore */
      }
      if (mapRef.current === map) {
        mapRef.current = null;
        groupRef.current = null;
        satRef.current = null;
        streetRef.current = null;
      }
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryToken, height]);

  // Fly to a new center (locate-me / address search / pin selected) without remounting.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !center || !ready) return;
    if (!Number.isFinite(center.lat) || !Number.isFinite(center.lng)) return;
    try {
      map.setView([center.lat, center.lng], Math.max(map.getZoom(), 18), {
        animate: true,
      });
    } catch {
      /* not ready */
    }
  }, [center, ready]);

  const switchToStreet = () => {
    const map = mapRef.current;
    const street = streetRef.current;
    const sat = satRef.current;
    if (!map || !street) {
      setTileHint('Map not ready — try Retry');
      return;
    }
    try {
      map.eachLayer((layer) => {
        if (
          layer !== groupRef.current &&
          layer !== street &&
          'getTileUrl' in (layer as object)
        ) {
          try {
            map.removeLayer(layer);
          } catch {
            /* ignore */
          }
        }
      });
      if (sat && map.hasLayer(sat)) map.removeLayer(sat);
      if (!map.hasLayer(street)) street.addTo(map);
      setBasemap('street');
      setTileHint('Street map');
      safeInvalidate(map);
    } catch {
      setTileHint('Could not switch basemap');
    }
  };

  const retry = () => {
    setInitError(null);
    setReady(false);
    setRetryToken((n) => n + 1);
  };

  return (
    <div ref={wrapRef} className={className}>
      <div
        ref={mapEl}
        className="canvass-map w-full rounded-3xl overflow-hidden bg-slate-100 relative z-0 ring-1 ring-slate-200/80"
        style={{ height, minHeight: height, width: '100%' }}
      />

      {initError && (
        <div className="mt-2 flex items-center justify-center gap-2 text-sm text-zinc-600">
          <span>Map failed</span>
          <button
            type="button"
            onClick={retry}
            className="font-semibold text-slate-900 underline"
          >
            Retry
          </button>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-2 px-0.5">
        <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
          <svg className="w-3.5 h-3.5 text-zinc-400" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 21c-4.5-4.2-7-7.9-7-11a7 7 0 1 1 14 0c0 3.1-2.5 6.8-7 11Z" />
            <circle cx="12" cy="10" r="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {!ready
            ? 'Loading…'
            : `${pins.length} pin${pins.length === 1 ? '' : 's'} · tap the map to drop one`}
          {tileHint ? ` · ${tileHint}` : ''}
        </span>
        <button
          type="button"
          onClick={switchToStreet}
          disabled={!ready}
          className="text-xs font-medium text-zinc-600 hover:text-zinc-900 disabled:opacity-30 rounded-full border border-zinc-200 px-2.5 py-1 transition-colors"
        >
          {basemap === 'street' ? 'Satellite' : 'Street'}
        </button>
      </div>
    </div>
  );
}
