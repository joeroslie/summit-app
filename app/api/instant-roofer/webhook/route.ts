import { NextRequest, NextResponse } from 'next/server';
import {
  upsertHumanOrder,
  type HumanMeasureOrder,
} from '@/lib/instant-roofer-orders';

/**
 * Instant Roofer Human Certified webhook.
 *
 * Instant Roofer dashboard (PDF webhook URL — production, not localhost):
 *   https://summit-app-kappa.vercel.app/api/instant-roofer/webhook
 *
 * Localhost will not receive Instant Roofer callbacks.
 *
 * Optional auth: set INSTANT_ROOFER_WEBHOOK_SECRET and the same bearer token
 * in Instant Roofer webhook settings. Leave unset if the dashboard has no token.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    const rec = asRecord(cur);
    if (!rec) return undefined;
    cur = rec[p];
  }
  return cur;
}

function pickString(
  obj: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const k of keys) {
    const v = getPath(obj, k);
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

function flattenPayload(body: Record<string, unknown>): Record<string, unknown> {
  const order = asRecord(body.order);
  const report = asRecord(body.report);
  return {
    ...body,
    ...(order || {}),
    ...(report || {}),
  };
}

export async function POST(req: NextRequest) {
  try {
    const secret = process.env.INSTANT_ROOFER_WEBHOOK_SECRET?.trim();
    if (secret) {
      const auth = req.headers.get('authorization') || '';
      const token = auth.toLowerCase().startsWith('bearer ')
        ? auth.slice(7).trim()
        : auth.trim();
      if (token !== secret) {
        return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
      }
    }

    const body = (await req.json()) as Record<string, unknown>;
    const flat = flattenPayload(body);
    const requestId = pickString(flat, [
      'requestId',
      'requestID',
      'request_id',
      'order.request_id',
    ]);
    const humanReportId = pickString(flat, [
      'humanReportId',
      'human_report_id',
      'order.id',
      'id',
    ]);
    const reportUrl = pickString(flat, [
      'reportUrl',
      'report_url',
      'url',
      'report.url',
    ]);
    const reportType = pickString(flat, [
      'reportType',
      'report_type',
      'type',
      'report.type',
    ]);
    const statusRaw =
      pickString(flat, ['status', 'order.status', 'order.status_code', 'statusCode']) ||
      '';
    const failureReason = pickString(flat, [
      'failureReason',
      'failure_reason',
      'order.failure_reason',
    ]);

    const failed =
      /fail/i.test(statusRaw) ||
      body.event === 'human_report.failed' ||
      flat.event === 'human_report.failed' ||
      (!reportUrl && !!failureReason);

    const now = new Date().toISOString();
    const lat = Number(flat.latitude ?? body.latitude) || 0;
    const lng = Number(flat.longitude ?? body.longitude) || 0;

    const order: HumanMeasureOrder = {
      id: humanReportId || requestId || `webhook-${Date.now()}`,
      requestId,
      humanReportId,
      leadId: null,
      lat,
      lng,
      address: pickString(flat, [
        'originalAddress',
        'original_address',
        'order.original_address',
        'address',
      ]),
      customerName: pickString(flat, [
        'customerName',
        'customer_name',
        'order.customer_name',
      ]),
      status: failed ? 'failed' : reportUrl ? 'completed' : 'queued',
      reportUrl,
      reportType,
      failureReason: failureReason || (failed ? statusRaw || 'failed' : null),
      createdAt: now,
      updatedAt: now,
      rawWebhook: body,
    };

    await upsertHumanOrder(order, { viaWebhook: true });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('instant-roofer webhook', err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

/** Health check for Instant Roofer dashboard URL validation. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'instant-roofer-webhook',
    url: 'https://summit-app-kappa.vercel.app/api/instant-roofer/webhook',
    note: 'POST human report completion payloads here (public host, not localhost)',
  });
}
