import { NextRequest, NextResponse } from 'next/server';
import { callInstantRooferV2 } from '@/lib/instant-roofer';
import {
  readHumanOrders,
  upsertHumanOrder,
  type HumanMeasureOrder,
} from '@/lib/instant-roofer-orders';

/**
 * Order Instant Roofer Human Certified report (~$10, ~1 hour).
 * POST { lat, lng, leadId?, address?, customerName?, contractorName? }
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      lat?: number;
      lng?: number;
      leadId?: number | string;
      address?: string;
      customerName?: string;
      contractorName?: string;
    };
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return NextResponse.json(
        { error: 'bad_request', message: 'lat and lng are required' },
        { status: 400 }
      );
    }

    const payload: Record<string, unknown> = {
      latitude: lat,
      longitude: lng,
      reportType: 'human',
    };
    if (body.contractorName?.trim())
      payload.contractorName = body.contractorName.trim().slice(0, 255);
    if (body.customerName?.trim())
      payload.customerName = body.customerName.trim().slice(0, 255);
    if (body.address?.trim())
      payload.originalAddress = body.address.trim().slice(0, 1000);

    const result = await callInstantRooferV2(payload);
    if (!result.ok) {
      return NextResponse.json(result.json, {
        status:
          result.status >= 400 && result.status < 600 ? result.status : 502,
      });
    }

    const raw = result.json as {
      ok?: boolean;
      code?: string;
      message?: string;
      requestId?: string;
      humanReportId?: string;
      companyId?: string;
      companyName?: string;
    };

    const order: HumanMeasureOrder = {
      id: raw.humanReportId || raw.requestId || `human-${Date.now()}`,
      requestId: raw.requestId || null,
      humanReportId: raw.humanReportId || null,
      leadId: body.leadId != null ? String(body.leadId) : null,
      lat,
      lng,
      address: body.address || null,
      customerName: body.customerName || null,
      status: 'queued',
      reportUrl: null,
      reportType: null,
      failureReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rawQueued: raw,
    };

    await upsertHumanOrder(order);

    return NextResponse.json({
      ok: true,
      code: raw.code || 'HUMAN_QUEUED',
      message:
        raw.message ||
        'Human Certified report queued (~1 hour). We’ll notify when ready.',
      order,
    });
  } catch (err) {
    console.error('instant-roofer human', err);
    return NextResponse.json(
      { error: 'order_failed', message: 'Could not order Human Certified report' },
      { status: 502 }
    );
  }
}

/** List pending/completed human orders (optional ?leadId=). */
export async function GET(req: NextRequest) {
  const leadId = req.nextUrl.searchParams.get('leadId');
  const orders = await readHumanOrders();
  const filtered = leadId
    ? orders.filter((o) => o.leadId === String(leadId))
    : orders;
  return NextResponse.json({ ok: true, orders: filtered });
}
