'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LatLngPoint } from '@/lib/roof-geometry';
import {
  DEFAULT_SNAP_MODE,
  smartSnapPoint,
  suggestNextCorners,
  type SnapMode,
  type SuggestCorner,
} from '@/lib/roof-snap';

type RoofTracerProps = {
  initialPoints?: LatLngPoint[];
  center?: LatLngPoint | null;
  onChange: (points: LatLngPoint[]) => void;
  /** Called when polygon reaches 3+ points (auto-calc trigger). */
  onPolygonComplete?: (points: LatLngPoint[]) => void;
  onSave?: () => void;
  canSave?: boolean;
  className?: string;
  height?: number;
  onBasemapChange?: (mode: 'satellite' | 'street') => void;
  /** Smart assist on by default for field speed */
  smartAssistDefault?: boolean;
};

type BasemapMode = 'satellite' | 'street';

const DEFAULT_CENTER: LatLngPoint = { lat: 33.4484, lng: -112.074 };

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
 * Satellite roof tracer with client-side smart assist:
 * snap to vertices/edges/ortho, ghost corner suggestions, close-to-start.
 * No external vision API — pure geometry for field speed.
 */
export default function RoofTracer({
  initialPoints = [],
  center,
  onChange,
  onPolygonComplete,
  onSave: _onSave,
  canSave: _canSave = false,
  className = '',
  height = 480,
  onBasemapChange,
  smartAssistDefault = true,
}: RoofTracerProps) {
  void _onSave;
  void _canSave;

  const wrapRef = useRef<HTMLDivElement>(null);
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import('leaflet').Map | null>(null);
  const groupRef = useRef<import('leaflet').FeatureGroup | null>(null);
  const suggestGroupRef = useRef<import('leaflet').FeatureGroup | null>(null);
  const pinRef = useRef<import('leaflet').CircleMarker | null>(null);
  const satRef = useRef<import('leaflet').TileLayer | null>(null);
  const streetRef = useRef<import('leaflet').TileLayer | null>(null);
  const LRef = useRef<typeof import('leaflet') | null>(null);
  const pointsRef = useRef<LatLngPoint[]>(initialPoints);
  const centerRef = useRef(center);
  const onChangeRef = useRef(onChange);
  const onPolygonCompleteRef = useRef(onPolygonComplete);
  const onBasemapChangeRef = useRef(onBasemapChange);
  const smartRef = useRef(smartAssistDefault);
  const snapModeRef = useRef<SnapMode>({ ...DEFAULT_SNAP_MODE });
  const initGen = useRef(0);

  const [pointCount, setPointCount] = useState(initialPoints.length);
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [basemap, setBasemap] = useState<BasemapMode>('satellite');
  const [tileHint, setTileHint] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  // Smart assist always on for field speed (snap + ghost corners)
  const smartAssist = smartAssistDefault;

  // Keep callback/value refs in sync for Leaflet handlers (not during pure render)
  useEffect(() => {
    centerRef.current = center;
    smartRef.current = smartAssist;
    onChangeRef.current = onChange;
    onPolygonCompleteRef.current = onPolygonComplete;
    onBasemapChangeRef.current = onBasemapChange;
  }, [center, smartAssist, onChange, onPolygonComplete, onBasemapChange]);

  const safeInvalidate = useCallback((map: import('leaflet').Map | null) => {
    if (!map) return;
    try {
      map.invalidateSize({ animate: false, pan: false });
    } catch {
      /* mid-destroy */
    }
  }, []);

  const redrawSuggestions = useCallback(() => {
    const group = suggestGroupRef.current;
    const L = LRef.current;
    if (!group || !L) return;
    group.clearLayers();
    if (!smartRef.current) return;
    const pts = pointsRef.current;
    const suggestions = suggestNextCorners(pts);

    suggestions.forEach((s: SuggestCorner) => {
      const isClose = s.kind === 'close' || s.kind === 'close-rect';
      L.circleMarker([s.point.lat, s.point.lng], {
        radius: isClose ? 9 : 7,
        color: isClose ? '#d97706' : '#64748b',
        weight: 2,
        fillColor: isClose ? '#fbbf24' : '#e2e8f0',
        fillOpacity: 0.85,
        dashArray: '2 2',
      })
        .bindTooltip(s.label, {
          permanent: false,
          direction: 'top',
          className: 'text-xs',
        })
        .addTo(group);
    });
  }, []);

  const redraw = useCallback(() => {
    const group = groupRef.current;
    const L = LRef.current;
    if (!group || !L) return;
    group.clearLayers();
    const pts = pointsRef.current;
    pts.forEach((p, i) => {
      L.circleMarker([p.lat, p.lng], {
        radius: 7,
        color: '#141618',
        weight: 2,
        fillColor: '#0f766e', // soft teal accent points
        fillOpacity: 1,
      })
        .bindTooltip(String(i + 1), { permanent: false, direction: 'top' })
        .addTo(group);
    });
    if (pts.length >= 2) {
      L.polyline(
        pts.map((p) => [p.lat, p.lng] as [number, number]),
        { color: '#0f766e', weight: 3, opacity: 0.92 }
      ).addTo(group);
    }
    if (pts.length >= 3) {
      L.polygon(
        pts.map((p) => [p.lat, p.lng] as [number, number]),
        {
          color: '#134e4a',
          weight: 2,
          fillColor: '#2dd4bf', // soft teal wash
          fillOpacity: 0.18,
        }
      ).addTo(group);
    }
    redrawSuggestions();
  }, [redrawSuggestions]);

  const commitPoint = useCallback(
    (raw: LatLngPoint) => {
      const pts = pointsRef.current;
      const suggestions = smartRef.current ? suggestNextCorners(pts) : [];
      const mode = smartRef.current
        ? snapModeRef.current
        : {
            vertex: false,
            edge: false,
            ortho: false,
            close: false,
            suggest: false,
          };

      const { point, snapped } = smartSnapPoint(raw, pts, mode, suggestions);

      // Closing: if snapped to first point, don't add duplicate — polygon is complete
      if (
        snapped === 'close' &&
        pts.length >= 3 &&
        Math.abs(point.lat - pts[0].lat) < 1e-10 &&
        Math.abs(point.lng - pts[0].lng) < 1e-10
      ) {
        onPolygonCompleteRef.current?.(pts);
        redraw();
        return;
      }

      const next = [...pts, point];
      const prevLen = pts.length;
      pointsRef.current = next;
      setPointCount(next.length);
      onChangeRef.current(next);
      redraw();
      if (next.length >= 3 && (prevLen < 3 || next.length > prevLen)) {
        onPolygonCompleteRef.current?.(next);
      }
    },
    [redraw]
  );

  useEffect(() => {
    const gen = ++initGen.current;
    let cancelled = false;
    let map: import('leaflet').Map | null = null;
    let resizeObs: ResizeObserver | null = null;
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

      const startCenter = centerRef.current || center || initialPoints[0] || null;
      const start = startCenter || DEFAULT_CENTER;
      const zoom = startCenter ? 20 : 12;

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
          onBasemapChangeRef.current?.('street');
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
          onBasemapChangeRef.current?.('street');
        } else {
          setBasemap('satellite');
          setTileHint(null);
          onBasemapChangeRef.current?.('satellite');
        }
        scheduleInvalidate(created);
      });

      created.zoomControl.setPosition('topleft');

      const group = L.featureGroup().addTo(created);
      const suggestGroup = L.featureGroup().addTo(created);
      groupRef.current = group;
      suggestGroupRef.current = suggestGroup;
      mapRef.current = created;

      if (startCenter) {
        pinRef.current = L.circleMarker([startCenter.lat, startCenter.lng], {
          radius: 10,
          color: '#f59e0b',
          weight: 3,
          fillColor: '#fbbf24',
          fillOpacity: 0.95,
        })
          .bindTooltip('Property', { permanent: false, direction: 'top' })
          .addTo(created);
      }

      pointsRef.current = [...initialPoints];
      setPointCount(initialPoints.length);

      created.whenReady(() => {
        if (cancelled || initGen.current !== gen || !mapRef.current) return;
        scheduleInvalidate(created);
        redraw();
        if (initialPoints.length >= 2) {
          try {
            created.fitBounds(group.getBounds().pad(0.2), { maxZoom: 21 });
          } catch {
            /* empty */
          }
        } else if (startCenter) {
          created.setView([startCenter.lat, startCenter.lng], 20, {
            animate: false,
          });
        } else {
          created.setView([start.lat, start.lng], zoom, { animate: false });
        }
        created.eachLayer((layer) => {
          try {
            const tileLayer = layer as { redraw?: () => void };
            tileLayer.redraw?.();
          } catch {
            /* ignore */
          }
        });
        setReady(true);
      });

      created.on('click', (e: import('leaflet').LeafletMouseEvent) => {
        if (!mapRef.current) return;
        commitPoint({ lat: e.latlng.lat, lng: e.latlng.lng });
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
        map?.off();
        map?.remove();
      } catch {
        /* ignore */
      }
      if (mapRef.current === map) {
        mapRef.current = null;
        groupRef.current = null;
        suggestGroupRef.current = null;
        pinRef.current = null;
        satRef.current = null;
        streetRef.current = null;
      }
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryToken, height]);

  // Address geocode finished or updated — pin + fly to property
  useEffect(() => {
    const map = mapRef.current;
    const L = LRef.current;
    if (!map || !center) return;
    if (!Number.isFinite(center.lat) || !Number.isFinite(center.lng)) return;

    const apply = () => {
      try {
        if (pinRef.current) {
          pinRef.current.setLatLng([center.lat, center.lng]);
        } else if (L) {
          pinRef.current = L.circleMarker([center.lat, center.lng], {
            radius: 10,
            color: '#f59e0b',
            weight: 3,
            fillColor: '#fbbf24',
            fillOpacity: 0.95,
          })
            .bindTooltip('Property', { permanent: false, direction: 'top' })
            .addTo(map);
        }

        safeInvalidate(map);
        // Hard snap to house (no fly-from-wrong-place) for field accuracy
        map.setView([center.lat, center.lng], 20, { animate: false });
        [50, 150, 350, 700].forEach((ms) => {
          window.setTimeout(() => {
            try {
              safeInvalidate(map);
              map.setView([center.lat, center.lng], 20, { animate: false });
              map.eachLayer((layer) => {
                try {
                  (layer as { redraw?: () => void }).redraw?.();
                } catch {
                  /* ignore */
                }
              });
            } catch {
              /* ignore */
            }
          }, ms);
        });
      } catch {
        /* not ready */
      }
    };

    if (ready) apply();
    else {
      const id = window.setTimeout(apply, 400);
      return () => window.clearTimeout(id);
    }
  }, [center, ready, safeInvalidate]);

  // Refresh ghost corners when smart assist toggled
  useEffect(() => {
    if (ready) redrawSuggestions();
  }, [smartAssist, ready, redrawSuggestions]);

  const undo = () => {
    if (!mapRef.current) return;
    const next = pointsRef.current.slice(0, -1);
    pointsRef.current = next;
    setPointCount(next.length);
    onChangeRef.current(next);
    redraw();
    if (next.length >= 3) onPolygonCompleteRef.current?.(next);
  };

  const clearTrace = () => {
    pointsRef.current = [];
    setPointCount(0);
    onChangeRef.current([]);
    try {
      groupRef.current?.clearLayers();
      suggestGroupRef.current?.clearLayers();
    } catch {
      /* ignore */
    }
    redrawSuggestions();
  };

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
          layer !== suggestGroupRef.current &&
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
      onBasemapChangeRef.current?.('street');
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

  const complete = pointCount >= 3;

  return (
    <div ref={wrapRef} className={className}>
      <div
        ref={mapEl}
        className="roof-tracer-map w-full rounded-3xl overflow-hidden bg-slate-100 relative z-0 ring-1 ring-slate-200/80"
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
        <span className="text-xs text-slate-400">
          {!ready
            ? 'Loading…'
            : complete
              ? `${pointCount} points`
              : `Tap corners · ${pointCount}`}
          {tileHint ? ` · ${tileHint}` : ''}
        </span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={undo}
            disabled={!ready || pointCount === 0}
            className="text-xs font-medium text-slate-600 disabled:opacity-30"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={clearTrace}
            disabled={!ready || pointCount === 0}
            className="text-xs font-medium text-slate-600 disabled:opacity-30"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={switchToStreet}
            disabled={!ready}
            className="text-xs font-medium text-slate-600 disabled:opacity-30"
          >
            {basemap === 'street' ? 'Satellite' : 'Street'}
          </button>
        </div>
      </div>
    </div>
  );
}
