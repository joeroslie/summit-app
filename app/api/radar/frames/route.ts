import { NextResponse } from 'next/server';
import type { RadarFrame, RadarFramesResponse } from '@/lib/radar';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const RAINVIEWER_URL = 'https://api.rainviewer.com/public/weather-maps.json';
const UA = 'SummitRoofCRM/1.0 (radar-frames; local-dev)';

type RainViewerPayload = {
  generated?: number;
  host?: string;
  radar?: {
    past?: Array<{ time?: number; path?: string }>;
    nowcast?: Array<{ time?: number; path?: string }>;
  };
};

function asFrame(raw: { time?: number; path?: string } | null | undefined): RadarFrame | null {
  if (!raw) return null;
  const time = Number(raw.time);
  const path = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (!Number.isFinite(time) || !path.startsWith('/')) return null;
  return { time, path };
}

/**
 * Proxies RainViewer's public frame catalog so the radar map can animate
 * the last ~2 hours of composite reflectivity. Tiles themselves load
 * from the `host` in the response (browser → RainViewer CDN).
 */
export async function GET() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(RAINVIEWER_URL, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
      signal: controller.signal,
      next: { revalidate: 0 },
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: 'Radar catalog is unavailable right now — try again shortly.' },
        { status: 502 }
      );
    }
    const data = (await res.json()) as RainViewerPayload;
    const host = typeof data.host === 'string' && data.host.startsWith('https://')
      ? data.host.replace(/\/$/, '')
      : 'https://tilecache.rainviewer.com';

    const past = (data.radar?.past ?? []).map(asFrame).filter((f): f is RadarFrame => f != null);
    const nowcast = (data.radar?.nowcast ?? [])
      .map(asFrame)
      .filter((f): f is RadarFrame => f != null);

    const seen = new Set<string>();
    const frames: RadarFrame[] = [];
    for (const frame of [...past, ...nowcast]) {
      if (seen.has(frame.path)) continue;
      seen.add(frame.path);
      frames.push(frame);
    }
    frames.sort((a, b) => a.time - b.time);

    if (frames.length === 0) {
      return NextResponse.json(
        { error: 'No radar frames in this catalog — try again shortly.' },
        { status: 502 }
      );
    }

    const body: RadarFramesResponse = {
      host,
      generated: typeof data.generated === 'number' ? data.generated : Math.floor(Date.now() / 1000),
      frames,
      fetchedAt: new Date().toISOString(),
    };
    return NextResponse.json(body);
  } catch {
    return NextResponse.json(
      { error: 'Could not reach the radar service — check your connection' },
      { status: 502 }
    );
  } finally {
    clearTimeout(timeout);
  }
}
