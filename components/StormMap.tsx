'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { attachPhoneMapEdgeYield } from '@/lib/phone-nav';
import {
  bearingDegrees,
  clampNearRadiusMiles,
  destinationPoint,
  eventStyle,
  haversineMiles,
  markerRadiusFor,
  MILES_TO_METERS,
  type StormReport,
} from '@/lib/weather';
import {
  CLUSTER_SEVERITY_STYLES,
  zoneFillColor,
  zoneStrokeColor,
  type StormCluster,
} from '@/lib/storm-clusters';
import {
  RADAR_HOLD_LAST_MS,
  RADAR_MAX_NATIVE_ZOOM,
  RADAR_MAX_ZOOM,
  RADAR_OPACITY,
  RADAR_PLAY_MS,
  radarTileUrl,
  type RadarFrame,
} from '@/lib/radar';

type LatLngPoint = { lat: number; lng: number };

type StormMapProps = {
  reports: StormReport[];
  selectedReportId: string | null;
  onSelectReport: (id: string) => void;
  /** "You are here" dot — twin of Hail Recon/HailTrace's locator. */
  userLocation?: LatLngPoint | null;
  /** Fly-to point — set after selecting a report / "Show my location". */
  center?: LatLngPoint | null;
  /** Bump to re-fit the map to all currently plotted reports. */
  fitSignal?: number;
  /** Approximate damage-zone polygons, clustered from the plotted reports. */
  clusters?: StormCluster[];
  /** Toggle for the damage-zone overlay layer. */
  showDamageZones?: boolean;
  /** Live RainViewer reflectivity loop under the report pins. */
  showWeatherOverlay?: boolean;
  radarHost?: string;
  radarFrames?: RadarFrame[];
  /** Miles from `userLocation` — draws a draggable circumference when set. */
  nearRadiusMiles?: number | null;
  onNearRadiusChange?: (miles: number) => void;
  className?: string;
  /** Pixel height. Omit to use the shared `.weather-map` CSS size. */
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
 * Storm report map — twin of components/CanvassMap.tsx's Leaflet setup
 * (dynamic import, satellite/street toggle, tile-error fallback) but for
 * plotting NOAA hail/wind/tornado point reports instead of canvass pins.
 * Optional weather overlay is a reflectivity loop under those pins.
 */
export default function StormMap({
  reports,
  selectedReportId,
  onSelectReport,
  userLocation,
  center,
  fitSignal,
  clusters,
  showDamageZones,
  showWeatherOverlay = false,
  radarHost = '',
  radarFrames = [],
  nearRadiusMiles = null,
  onNearRadiusChange,
  className = '',
  height,
}: StormMapProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import('leaflet').Map | null>(null);
  const groupRef = useRef<import('leaflet').FeatureGroup | null>(null);
  const zoneGroupRef = useRef<import('leaflet').FeatureGroup | null>(null);
  const locateGroupRef = useRef<import('leaflet').LayerGroup | null>(null);
  const radiusGroupRef = useRef<import('leaflet').LayerGroup | null>(null);
  const radiusCircleRef = useRef<import('leaflet').Circle | null>(null);
  const radiusHandleRef = useRef<import('leaflet').Marker | null>(null);
  const radiusDraggingRef = useRef(false);
  const satRef = useRef<import('leaflet').TileLayer | null>(null);
  const streetRef = useRef<import('leaflet').TileLayer | null>(null);
  const LRef = useRef<typeof import('leaflet') | null>(null);
  const reportsRef = useRef<StormReport[]>(reports);
  const selectedIdRef = useRef<string | null>(selectedReportId);
  const onSelectReportRef = useRef(onSelectReport);
  const userLocationRef = useRef<LatLngPoint | null | undefined>(userLocation);
  const clustersRef = useRef<StormCluster[]>(clusters ?? []);
  const showDamageZonesRef = useRef<boolean>(showDamageZones ?? false);
  const nearRadiusMilesRef = useRef<number | null>(nearRadiusMiles ?? null);
  const onNearRadiusChangeRef = useRef(onNearRadiusChange);
  const radarLayersRef = useRef<Map<string, import('leaflet').TileLayer>>(new Map());
  const radarFramesRef = useRef<RadarFrame[]>(radarFrames);
  const radarHostRef = useRef(radarHost);
  const showWeatherOverlayRef = useRef(showWeatherOverlay);
  const initGen = useRef(0);

  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  // Street is the default basemap here (unlike CanvassMap) — city/road labels
  // matter more than roof-level satellite detail when scanning a wide storm area.
  const [basemap, setBasemap] = useState<BasemapMode>('street');
  const [tileHint, setTileHint] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [radarFrameIndex, setRadarFrameIndex] = useState(0);

  useEffect(() => {
    reportsRef.current = reports;
    selectedIdRef.current = selectedReportId;
    onSelectReportRef.current = onSelectReport;
    userLocationRef.current = userLocation;
    clustersRef.current = clusters ?? [];
    showDamageZonesRef.current = showDamageZones ?? false;
    nearRadiusMilesRef.current = nearRadiusMiles ?? null;
    onNearRadiusChangeRef.current = onNearRadiusChange;
    radarFramesRef.current = radarFrames;
    radarHostRef.current = radarHost;
    showWeatherOverlayRef.current = showWeatherOverlay;
  }, [
    reports,
    selectedReportId,
    onSelectReport,
    userLocation,
    clusters,
    showDamageZones,
    nearRadiusMiles,
    onNearRadiusChange,
    radarFrames,
    radarHost,
    showWeatherOverlay,
  ]);

  const safeInvalidate = useCallback((map: import('leaflet').Map | null) => {
    if (!map) return;
    try {
      map.invalidateSize({ animate: false, pan: false });
    } catch {
      /* mid-destroy */
    }
  }, []);

  const redrawLocate = useCallback(() => {
    const group = locateGroupRef.current;
    const L = LRef.current;
    if (!group || !L) return;
    group.clearLayers();
    const loc = userLocationRef.current;
    if (!loc) return;
    const icon = L.divIcon({
      className: '',
      html: '<div class="locate-marker"><div class="locate-marker__pulse"></div><div class="locate-marker__dot"></div></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
    L.marker([loc.lat, loc.lng], { icon, zIndexOffset: 1000, interactive: false })
      .bindTooltip('You are here', { permanent: false, direction: 'top' })
      .addTo(group);
  }, []);

  const fitToRadiusCircle = useCallback(() => {
    const map = mapRef.current;
    const circle = radiusCircleRef.current;
    if (!map || !circle) return;
    try {
      const bounds = circle.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.14), { maxZoom: 12, animate: true });
    } catch {
      /* circle not ready */
    }
  }, []);

  const redrawRadius = useCallback(() => {
    const group = radiusGroupRef.current;
    const L = LRef.current;
    if (!group || !L) return;
    group.clearLayers();
    radiusCircleRef.current = null;
    radiusHandleRef.current = null;
    if (radiusDraggingRef.current) return;
    const loc = userLocationRef.current;
    const miles = nearRadiusMilesRef.current;
    if (!loc || miles == null) return;

    const circle = L.circle([loc.lat, loc.lng], {
      radius: miles * MILES_TO_METERS,
      color: '#6ba6ff',
      weight: 2.5,
      opacity: 0.9,
      fillColor: '#6ba6ff',
      fillOpacity: 0.08,
      interactive: false,
    }).addTo(group);
    radiusCircleRef.current = circle;

    const handlePos = destinationPoint(loc, miles, 90);
    const handle = L.marker([handlePos.lat, handlePos.lng], {
      draggable: true,
      autoPan: false,
      zIndexOffset: 1200,
      icon: L.divIcon({
        className: '',
        html: '<div class="radius-handle" aria-label="Drag to resize search radius"><span class="radius-handle__knob"></span></div>',
        iconSize: [36, 36],
        iconAnchor: [18, 18],
      }),
    });
    handle.bindTooltip(`${miles} mi`, {
      permanent: true,
      direction: 'right',
      offset: [18, 0],
      className: 'radius-handle-tip',
      opacity: 1,
    });

    const applyMiles = (nextMiles: number, handleLatLng: { lat: number; lng: number }, snap: boolean) => {
      const clamped = clampNearRadiusMiles(nextMiles);
      circle.setRadius(clamped * MILES_TO_METERS);
      if (snap) {
        const bearing = bearingDegrees(loc, handleLatLng);
        const snapped = destinationPoint(loc, clamped, Number.isFinite(bearing) ? bearing : 90);
        handle.setLatLng([snapped.lat, snapped.lng]);
      }
      handle.setTooltipContent(`${clamped} mi`);
      return clamped;
    };

    handle.on('dragstart', () => {
      radiusDraggingRef.current = true;
    });
    handle.on('drag', () => {
      const ll = handle.getLatLng();
      applyMiles(haversineMiles(loc, { lat: ll.lat, lng: ll.lng }), {
        lat: ll.lat,
        lng: ll.lng,
      }, false);
    });
    handle.on('dragend', () => {
      const ll = handle.getLatLng();
      const clamped = applyMiles(haversineMiles(loc, { lat: ll.lat, lng: ll.lng }), {
        lat: ll.lat,
        lng: ll.lng,
      }, true);
      radiusDraggingRef.current = false;
      nearRadiusMilesRef.current = clamped;
      onNearRadiusChangeRef.current?.(clamped);
      fitToRadiusCircle();
    });
    handle.addTo(group);
    radiusHandleRef.current = handle;
  }, [fitToRadiusCircle]);

  const redrawZones = useCallback(() => {
    const group = zoneGroupRef.current;
    const L = LRef.current;
    if (!group || !L) return;
    group.clearLayers();
    if (!showDamageZonesRef.current) return;
    clustersRef.current.forEach((cluster) => {
      const style = CLUSTER_SEVERITY_STYLES[cluster.severity];
      const isWarning = cluster.kind === 'warning';
      const layer = L.geoJSON(cluster.polygon, {
        style: {
          color: zoneStrokeColor(cluster.category),
          weight: isWarning ? Math.max(style.weight, 2.5) : style.weight,
          opacity: isWarning ? 0.9 : 0.55,
          fillColor: zoneFillColor(cluster.category),
          fillOpacity: style.fillOpacity,
        },
      });
      const magText = cluster.maxMagnitudeLabel ? ` · ${cluster.maxMagnitudeLabel}` : '';
      const detail =
        cluster.kind === 'warning'
          ? `${style.label} ${eventStyle(cluster.category).label.toLowerCase()}${magText}`
          : `${style.label} ${eventStyle(cluster.category).label.toLowerCase()} zone · ${cluster.reportCount} reports${magText}`;
      layer.bindTooltip(detail, { sticky: true });
      layer.addTo(group);
    });
  }, []);

  const redraw = useCallback(() => {
    const group = groupRef.current;
    const L = LRef.current;
    if (!group || !L) return;
    group.clearLayers();
    const selectedId = selectedIdRef.current;
    reportsRef.current.forEach((report) => {
      const style = eventStyle(report.category);
      const isSelected = report.id === selectedId;
      const radius = markerRadiusFor(report.category, report.magnitude);
      const size = radius * 2 + (isSelected ? 6 : 0);
      const icon = L.divIcon({
        className: '',
        html: `<div class="storm-marker${isSelected ? ' storm-marker--selected' : ''}" style="width:${size}px;height:${size}px;background:${style.marker};border-color:${isSelected ? 'var(--graphite)' : style.markerStroke};font-size:${Math.max(9, size * 0.42)}px;">${style.shortLabel}</div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });
      const marker = L.marker([report.lat, report.lng], {
        icon,
        riseOnHover: true,
      });
      const magText = report.magnitude
        ? ` · ${report.magnitude}${report.units ? ` ${report.units}` : ''}`
        : '';
      marker.bindTooltip(`${style.label}${magText} — ${report.locDesc || report.state || ''}`, {
        permanent: false,
        direction: 'top',
      });
      marker.on('click', () => {
        onSelectReportRef.current(report.id);
      });
      marker.addTo(group);
    });
  }, []);

  useEffect(() => {
    redraw();
  }, [reports, selectedReportId, redraw]);

  useEffect(() => {
    redrawLocate();
  }, [userLocation, redrawLocate]);

  useEffect(() => {
    if (radiusDraggingRef.current) return;
    redrawRadius();
    if (ready && nearRadiusMiles != null && userLocation) {
      fitToRadiusCircle();
    }
  }, [userLocation, nearRadiusMiles, redrawRadius, ready, fitToRadiusCircle]);

  useEffect(() => {
    redrawZones();
  }, [clusters, showDamageZones, redrawZones]);

  const hideRadarLayers = useCallback(() => {
    radarLayersRef.current.forEach((ly) => {
      try {
        ly.setOpacity(0);
      } catch {
        /* ignore */
      }
    });
  }, []);

  const showRadarFrame = useCallback((index: number) => {
    const map = mapRef.current;
    const L = LRef.current;
    const list = radarFramesRef.current;
    const tileHost = radarHostRef.current;
    if (!map || !L || !tileHost || list.length === 0) return;
    if (!showWeatherOverlayRef.current) {
      hideRadarLayers();
      return;
    }
    const i = Math.max(0, Math.min(index, list.length - 1));
    const frame = list[i];
    if (!frame) return;

    let layer = radarLayersRef.current.get(frame.path);
    if (!layer) {
      layer = L.tileLayer(radarTileUrl(tileHost, frame.path), {
        pane: 'radarPane',
        opacity: 0.001,
        maxNativeZoom: RADAR_MAX_NATIVE_ZOOM,
        maxZoom: RADAR_MAX_ZOOM,
        tileSize: 256,
        className: 'radar-tiles',
        attribution: 'Radar &copy; RainViewer',
      });
      radarLayersRef.current.set(frame.path, layer);
      layer.addTo(map);
    } else if (!map.hasLayer(layer)) {
      layer.addTo(map);
    }

    radarLayersRef.current.forEach((ly, path) => {
      try {
        ly.setOpacity(path === frame.path ? RADAR_OPACITY : 0.001);
      } catch {
        /* ignore */
      }
    });

    const next = list[i + 1] ?? list[0];
    if (next && next.path !== frame.path && !radarLayersRef.current.has(next.path)) {
      const preload = L.tileLayer(radarTileUrl(tileHost, next.path), {
        pane: 'radarPane',
        opacity: 0.001,
        maxNativeZoom: RADAR_MAX_NATIVE_ZOOM,
        maxZoom: RADAR_MAX_ZOOM,
        tileSize: 256,
        className: 'radar-tiles',
      });
      radarLayersRef.current.set(next.path, preload);
      preload.addTo(map);
    }
  }, [hideRadarLayers]);

  const latestRadarTime = radarFrames[radarFrames.length - 1]?.time ?? 0;
  useEffect(() => {
    if (!ready || radarFrames.length === 0) return;
    setRadarFrameIndex(radarFrames.length - 1);
  }, [latestRadarTime, radarFrames.length, ready]);

  useEffect(() => {
    if (!ready) return;
    const keep = new Set(radarFrames.map((f) => f.path));
    radarLayersRef.current.forEach((ly, path) => {
      if (keep.has(path)) return;
      try {
        ly.remove();
      } catch {
        /* ignore */
      }
      radarLayersRef.current.delete(path);
    });
  }, [radarFrames, ready]);

  useEffect(() => {
    if (!ready) return;
    if (!showWeatherOverlay) {
      hideRadarLayers();
      return;
    }
    showRadarFrame(radarFrameIndex);
  }, [radarFrameIndex, ready, radarFrames, radarHost, showWeatherOverlay, showRadarFrame, hideRadarLayers]);

  useEffect(() => {
    if (!ready || !showWeatherOverlay || radarFrames.length < 2) return;
    const last = radarFrameIndex >= radarFrames.length - 1;
    const ms = last ? RADAR_HOLD_LAST_MS : RADAR_PLAY_MS;
    const id = window.setTimeout(() => {
      setRadarFrameIndex((n) => (n + 1) % radarFrames.length);
    }, ms);
    return () => window.clearTimeout(id);
  }, [ready, showWeatherOverlay, radarFrameIndex, radarFrames.length]);

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

      el.style.width = '100%';
      if (height != null) {
        el.style.height = `${height}px`;
        el.style.minHeight = `${height}px`;
      }

      try {
        await waitForSize(el, 50);
      } catch {
        if (height != null) {
          el.style.height = `${Math.max(height, 400)}px`;
          el.style.minHeight = `${Math.max(height, 400)}px`;
        }
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

      const startCenter = center || userLocation || reports[0] || null;
      const start = startCenter || DEFAULT_CENTER;
      const zoom = startCenter ? 10 : 6;

      let created: import('leaflet').Map;
      try {
        created = L.map(mapEl.current, {
          center: [start.lat, start.lng],
          zoom,
          minZoom: 3,
          maxZoom: 20,
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

      created.createPane('radarPane');
      const radarPane = created.getPane('radarPane');
      if (radarPane) {
        radarPane.style.zIndex = '350';
        radarPane.style.pointerEvents = 'none';
      }

      const googleSat = L.tileLayer(
        'https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
        {
          subdomains: ['0', '1', '2', '3'],
          maxZoom: 20,
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
          maxZoom: 20,
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
      street.addTo(created);

      L.control
        .layers(
          {
            Street: street,
            'Satellite (hi-res)': googleSat,
            'Satellite (Esri)': esriSat,
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

      const zoneGroup = L.featureGroup().addTo(created);
      const group = L.featureGroup().addTo(created);
      const locateGroup = L.layerGroup().addTo(created);
      const radiusGroup = L.layerGroup().addTo(created);
      zoneGroupRef.current = zoneGroup;
      groupRef.current = group;
      locateGroupRef.current = locateGroup;
      radiusGroupRef.current = radiusGroup;
      mapRef.current = created;

      created.whenReady(() => {
        if (cancelled || initGen.current !== gen || !mapRef.current) return;
        scheduleInvalidate(created);
        redrawZones();
        redraw();
        redrawLocate();
        redrawRadius();
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
        radarLayersRef.current.forEach((ly) => {
          try {
            ly.remove();
          } catch {
            /* ignore */
          }
        });
        radarLayersRef.current.clear();
        mapRef.current = null;
        groupRef.current = null;
        zoneGroupRef.current = null;
        locateGroupRef.current = null;
        radiusGroupRef.current = null;
        radiusCircleRef.current = null;
        radiusHandleRef.current = null;
        satRef.current = null;
        streetRef.current = null;
      }
      setReady(false);
    };
  }, [retryToken, height]);

  // Fly to a new center (report selected) without remounting.
  // Near-me radius uses its own fit so a 75-mile circle isn't clipped at zoom 11.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !center || !ready) return;
    if (!Number.isFinite(center.lat) || !Number.isFinite(center.lng)) return;
    const isUserCenter =
      !!userLocation &&
      Math.abs(center.lat - userLocation.lat) < 1e-5 &&
      Math.abs(center.lng - userLocation.lng) < 1e-5;
    if (isUserCenter && nearRadiusMiles != null) {
      fitToRadiusCircle();
      return;
    }
    try {
      map.setView([center.lat, center.lng], Math.max(map.getZoom(), 11), {
        animate: true,
      });
    } catch {
      /* not ready */
    }
  }, [center, ready, nearRadiusMiles, userLocation, fitToRadiusCircle]);

  // Fit to all currently plotted reports on demand.
  useEffect(() => {
    if (fitSignal == null) return;
    const map = mapRef.current;
    const group = groupRef.current;
    if (!map || !group || !ready) return;
    try {
      const bounds = group.getBounds();
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.15), { maxZoom: 12 });
    } catch {
      /* no reports yet */
    }
  }, [fitSignal, ready]);

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
        const pane = (layer as { options?: { pane?: string } }).options?.pane;
        if (pane === 'radarPane') return;
        if (
          layer !== groupRef.current &&
          layer !== locateGroupRef.current &&
          layer !== radiusGroupRef.current &&
          layer !== zoneGroupRef.current &&
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
        className="weather-map w-full rounded-3xl overflow-hidden bg-slate-100 relative z-0 ring-1 ring-slate-200/80"
        style={
          height != null
            ? { height, minHeight: height, width: '100%' }
            : { width: '100%' }
        }
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
            : `${reports.length} report${reports.length === 1 ? '' : 's'} plotted`}
          {tileHint ? ` · ${tileHint}` : ''}
        </span>
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
  );
}
