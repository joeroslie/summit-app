import { NextRequest, NextResponse } from 'next/server';
import { definePDFJSModule, extractText, getDocumentProxy } from 'unpdf';
import {
  isUsableParsedReport,
  parseRoofReportText,
} from '@/lib/eagleview-parse';

/**
 * Extract measurements from an uploaded EagleView / similar roof PDF.
 *
 * POST multipart/form-data field "file" (PDF)
 * or raw application/pdf body.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Prefer unpdf's inlined serverless PDF.js (avoids Turbopack pdf.worker.mjs misses). */
let pdfjsReady: Promise<void> | null = null;
function ensurePdfjs() {
  if (!pdfjsReady) {
    pdfjsReady = definePDFJSModule(() => import('unpdf/pdfjs'));
  }
  return pdfjsReady;
}

export async function POST(req: NextRequest) {
  try {
    await ensurePdfjs();
    const contentType = req.headers.get('content-type') || '';
    let bytes: Uint8Array | null = null;
    let fileName = 'report.pdf';

    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file');
      if (!file || !(file instanceof File)) {
        return NextResponse.json(
          { error: 'bad_request', message: 'Expected form field "file"' },
          { status: 400 }
        );
      }
      fileName = file.name || fileName;
      if (
        file.type &&
        file.type !== 'application/pdf' &&
        !file.name.toLowerCase().endsWith('.pdf')
      ) {
        return NextResponse.json(
          {
            error: 'not_pdf',
            message: 'Only PDF EagleView / Roofr reports can be parsed',
          },
          { status: 400 }
        );
      }
      bytes = new Uint8Array(await file.arrayBuffer());
    } else if (
      contentType.includes('application/pdf') ||
      contentType.includes('application/octet-stream')
    ) {
      bytes = new Uint8Array(await req.arrayBuffer());
    } else {
      return NextResponse.json(
        {
          error: 'bad_request',
          message: 'Send multipart file or application/pdf body',
        },
        { status: 400 }
      );
    }

    if (!bytes || bytes.length < 100) {
      return NextResponse.json(
        { error: 'empty', message: 'PDF was empty' },
        { status: 400 }
      );
    }

    if (bytes.length > 40 * 1024 * 1024) {
      return NextResponse.json(
        { error: 'too_large', message: 'PDF too large to parse' },
        { status: 413 }
      );
    }

    const pdf = await getDocumentProxy(bytes);
    const extracted = await extractText(pdf, { mergePages: true });
    const text = String(extracted.text || '');
    if (text.trim().length < 40) {
      return NextResponse.json(
        {
          error: 'no_text',
          message:
            'Could not read text from this PDF (scanned image?). Try a digital EagleView export.',
        },
        { status: 422 }
      );
    }

    const parsed = parseRoofReportText(text);
    if (!isUsableParsedReport(parsed)) {
      return NextResponse.json(
        {
          error: 'parse_failed',
          message:
            'Uploaded, but could not find roof area in this PDF. File is saved — enter numbers manually.',
          parsed,
        },
        { status: 422 }
      );
    }

    const drip =
      parsed.dripEdgeLF ??
      (parsed.eaveLF != null || parsed.rakeLF != null
        ? Math.round(((parsed.eaveLF || 0) + (parsed.rakeLF || 0)) * 10) / 10
        : null);

    const waste = parsed.waste ?? 0.15;
    const orderSquares =
      parsed.squares ??
      (parsed.measuredSquares != null
        ? Math.round(parsed.measuredSquares * (1 + waste) * 10) / 10
        : null);
    const measuredArea = parsed.totalAreaSqFt;
    const measuredSquares = parsed.measuredSquares;

    return NextResponse.json({
      ok: true,
      fileName,
      provider: parsed.provider,
      measurements: {
        footprintSqFt: measuredArea,
        surfaceSqFt: measuredArea,
        /** Order quantity — includes EagleView suggested waste */
        squares: orderSquares,
        measuredSquares,
        pitch: parsed.pitch || '6/12',
        secondaryPitch: parsed.secondaryPitch,
        secondaryFraction: parsed.secondaryFraction,
        areasPerPitch: parsed.areasPerPitch,
        hasLowSlope: parsed.hasLowSlope,
        lowSlopeFraction: parsed.lowSlopeFraction,
        ridgeLF: parsed.ridgeLF ?? 0,
        hipLF: parsed.hipLF ?? 0,
        valleyLF: parsed.valleyLF ?? 0,
        rakeLF: parsed.rakeLF ?? 0,
        eaveLF: parsed.eaveLF ?? 0,
        dripEdgeLF: drip ?? 0,
        perimeterLF: drip ?? 0,
        facets: parsed.facets,
        waste,
        edgesVerified: true,
        measureSource:
          parsed.provider === 'roofr' ? 'roofr' : 'eagleview',
      },
      confidence: parsed.confidence,
      rawHits: parsed.rawHits,
      note:
        measuredSquares != null && orderSquares != null
          ? `Measured ${measuredSquares} sq · ${Math.round(waste * 100)}% waste → ${orderSquares} sq for estimate${
              parsed.secondaryPitch
                ? ` · ${parsed.pitch}+${parsed.secondaryPitch}`
                : ''
            }${parsed.hasLowSlope ? ' · low-slope underlayment' : ''}`
          : 'Parsed from PDF — verify against the report, then review the estimate.',
    });
  } catch (err) {
    console.error('measurement parse', err);
    return NextResponse.json(
      {
        error: 'parse_error',
        message: 'Failed to parse PDF',
      },
      { status: 500 }
    );
  }
}
