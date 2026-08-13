/**
 * Live weather overlay for the Storm Tracker map.
 *
 * Reflectivity tiles come from RainViewer's public Weather Maps API
 * (no key; past ~2 hours at 10-minute steps). This is a map layer on
 * the storm-report map — not a separate tool and not MESH hail swaths.
 */

export type RadarFrame = {
  time: number;
  path: string;
};

export type RadarFramesResponse = {
  host: string;
  generated: number;
  frames: RadarFrame[];
  fetchedAt: string;
};

export const RADAR_TILE_SIZE = 256;
/** RainViewer personal-use color: Universal Blue. */
export const RADAR_COLOR_SCHEME = 2;
export const RADAR_TILE_OPTIONS = '1_1';
export const RADAR_OPACITY = 0.72;
export const RADAR_MAX_NATIVE_ZOOM = 7;
export const RADAR_MAX_ZOOM = 18;
export const RADAR_PLAY_MS = 480;
export const RADAR_HOLD_LAST_MS = 1200;
export const RADAR_FRAMES_REFRESH_MS = 5 * 60 * 1000;
export const WEATHER_OVERLAY_STORAGE_KEY = 'summitWeatherOverlay';

export function radarTileUrl(host: string, path: string): string {
  const base = host.replace(/\/$/, '');
  return `${base}${path}/${RADAR_TILE_SIZE}/{z}/{x}/{y}/${RADAR_COLOR_SCHEME}/${RADAR_TILE_OPTIONS}.png`;
}

export function readStoredWeatherOverlay(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(WEATHER_OVERLAY_STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

export function writeStoredWeatherOverlay(on: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WEATHER_OVERLAY_STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    /* ignore */
  }
}
