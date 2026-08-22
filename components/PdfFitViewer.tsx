'use client';

import { useEffect, useRef, useState } from 'react';

type PdfFitViewerProps = {
  src: string;
  title?: string;
};

type PdfPage = {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (opts: {
    canvas: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }) => { promise: Promise<void> };
};

type PdfDoc = {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
  destroy: () => Promise<void> | void;
};

let unpdfReady: Promise<{
  getDocumentProxy: (data: Uint8Array) => Promise<PdfDoc>;
}> | null = null;

function loadUnpdf() {
  if (!unpdfReady) {
    unpdfReady = import('unpdf').then(async (mod) => {
      await mod.definePDFJSModule(() => import('unpdf/pdfjs'));
      return {
        getDocumentProxy: (data: Uint8Array) =>
          mod.getDocumentProxy(data) as unknown as Promise<PdfDoc>,
      };
    });
  }
  return unpdfReady;
}

function isRemoteHttp(src: string) {
  return src.startsWith('http://') || src.startsWith('https://');
}

async function readPdfBytes(src: string): Promise<Uint8Array> {
  const tryFetch = async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`pdf ${res.status}`);
    return new Uint8Array((await res.arrayBuffer()).slice(0));
  };
  try {
    return await tryFetch(src);
  } catch (err) {
    if (!isRemoteHttp(src)) throw err;
    return await tryFetch(`/api/pdf-bytes?url=${encodeURIComponent(src)}`);
  }
}

const PAGE_GAP = 12;
const PAGE_INSET = 12;
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;

export default function PdfFitViewer({ src, title }: PdfFitViewerProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<PdfDoc | null>(null);
  const pageSizeRef = useRef({ width: 612, height: 792 });
  const fitRef = useRef(1);
  const zoomRef = useRef(1);
  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    zoomRef.current = zoom;
    const stack = stackRef.current;
    if (!stack) return;
    const { width, height } = pageSizeRef.current;
    const fit = fitRef.current;
    const displayW = width * fit * zoom;
    const displayH = height * fit * zoom;
    stack.querySelectorAll('canvas').forEach((canvas) => {
      canvas.style.width = `${displayW}px`;
      canvas.style.height = `${displayH}px`;
    });
  }, [zoom]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const stack = stackRef.current;
    if (!scroller || !stack || !src) return;

    let cancelled = false;
    let pinchStartDist = 0;
    let pinchStartZoom = 1;

    const setZoomClamped = (next: number) => {
      const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
      zoomRef.current = z;
      setZoom(z);
    };

    const touchDist = (a: Touch, b: Touch) =>
      Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      const a = e.touches[0];
      const b = e.touches[1];
      if (!a || !b) return;
      pinchStartDist = touchDist(a, b);
      pinchStartZoom = zoomRef.current;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || pinchStartDist <= 0) return;
      e.preventDefault();
      const a = e.touches[0];
      const b = e.touches[1];
      if (!a || !b) return;
      const next = pinchStartZoom * (touchDist(a, b) / pinchStartDist);
      const prev = zoomRef.current;
      setZoomClamped(next);
      const ratio = zoomRef.current / prev;
      if (ratio === 1) return;
      scroller.scrollLeft =
        (scroller.scrollLeft + scroller.clientWidth / 2) * ratio -
        scroller.clientWidth / 2;
      scroller.scrollTop =
        (scroller.scrollTop + scroller.clientHeight / 2) * ratio -
        scroller.clientHeight / 2;
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinchStartDist = 0;
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const prev = zoomRef.current;
      setZoomClamped(prev * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
      const ratio = zoomRef.current / prev;
      scroller.scrollLeft =
        (scroller.scrollLeft + scroller.clientWidth / 2) * ratio -
        scroller.clientWidth / 2;
      scroller.scrollTop =
        (scroller.scrollTop + scroller.clientHeight / 2) * ratio -
        scroller.clientHeight / 2;
    };

    scroller.addEventListener('touchstart', onTouchStart, { passive: false });
    scroller.addEventListener('touchmove', onTouchMove, { passive: false });
    scroller.addEventListener('touchend', onTouchEnd);
    scroller.addEventListener('touchcancel', onTouchEnd);
    scroller.addEventListener('wheel', onWheel, { passive: false });

    let renderGen = 0;
    let lastW = 0;
    let lastH = 0;

    const renderAll = async () => {
      const pdf = pdfRef.current;
      if (!pdf || cancelled) return;
      const gen = ++renderGen;
      const availW = Math.max(120, scroller.clientWidth - PAGE_INSET * 2);
      const availH = Math.max(160, scroller.clientHeight - PAGE_INSET * 2);
      const { width, height } = pageSizeRef.current;
      const fit = Math.min(availW / width, availH / height);
      fitRef.current = fit;
      lastW = scroller.clientWidth;
      lastH = scroller.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const renderScale = fit * dpr * 2;
      const displayW = width * fit * zoomRef.current;
      const displayH = height * fit * zoomRef.current;
      if (gen === renderGen) stack.replaceChildren();
      for (let n = 1; n <= pdf.numPages; n++) {
        if (cancelled || gen !== renderGen) return;
        const page = await pdf.getPage(n);
        const viewport = page.getViewport({ scale: renderScale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        canvas.style.width = `${displayW}px`;
        canvas.style.height = `${displayH}px`;
        canvas.style.display = 'block';
        canvas.style.background = '#fff';
        canvas.style.boxShadow = '0 10px 15px -3px rgb(0 0 0 / 0.18)';
        canvas.setAttribute('aria-label', `Page ${n} of ${pdf.numPages}`);
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        if (cancelled || gen !== renderGen) return;
        stack.appendChild(canvas);
        if (n === 1) setStatus('ready');
      }
    };

    const start = async () => {
      setStatus('loading');
      setZoom(1);
      zoomRef.current = 1;
      stack.replaceChildren();
      try {
        const { getDocumentProxy } = await loadUnpdf();
        if (cancelled) return;
        const bytes = await readPdfBytes(src);
        if (cancelled) return;
        const pdf = await getDocumentProxy(bytes);
        if (cancelled) {
          if (typeof pdf.destroy === 'function') void pdf.destroy();
          return;
        }
        pdfRef.current = pdf;
        const first = await pdf.getPage(1);
        const base = first.getViewport({ scale: 1 });
        pageSizeRef.current = { width: base.width, height: base.height };
        await renderAll();
        if (!cancelled) setStatus('ready');
      } catch (err) {
        console.error(err);
        if (!cancelled) setStatus('error');
      }
    };

    void start();

    const ro = new ResizeObserver(() => {
      if (!pdfRef.current || cancelled) return;
      const w = scroller.clientWidth;
      const h = scroller.clientHeight;
      if (w === lastW && h === lastH) return;
      void renderAll();
    });
    ro.observe(scroller);

    return () => {
      cancelled = true;
      ro.disconnect();
      scroller.removeEventListener('touchstart', onTouchStart);
      scroller.removeEventListener('touchmove', onTouchMove);
      scroller.removeEventListener('touchend', onTouchEnd);
      scroller.removeEventListener('touchcancel', onTouchEnd);
      scroller.removeEventListener('wheel', onWheel);
      const pdf = pdfRef.current;
      pdfRef.current = null;
      if (pdf && typeof pdf.destroy === 'function') void pdf.destroy();
    };
  }, [src]);

  return (
    <div className="relative flex-1 min-h-0 w-full bg-zinc-200">
      <div
        ref={scrollerRef}
        className="absolute inset-0 overflow-auto overscroll-contain"
        style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-x pan-y' }}
        role="document"
        aria-label={title || 'PDF'}
        aria-busy={status === 'loading'}
      >
        <div
          ref={stackRef}
          className="flex flex-col items-center py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          style={{ gap: PAGE_GAP }}
        />
      </div>
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-sm font-medium text-zinc-500">
          Opening…
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center text-sm font-medium text-zinc-700">
          Couldn’t open PDF
        </div>
      )}
    </div>
  );
}
