import { NextRequest, NextResponse } from 'next/server';
import {
  findHumanOrder,
  upsertHumanOrder,
  type HumanMeasureOrder,
} from '@/lib/instant-roofer-orders';

/**
 * Instant Roofer Human Certified webhook.
 *
 * Configure in Instant Roofer API dashboard (per report format PDF/HTML/CSV/XML):
 *   URL: https://YOUR-PUBLIC-HOST/api/instant-roofer/webhook
 *
 * Localhost won't receive webhooks — needs deployed URL or a tunnel (ngrok).
 *
 * Optional auth: set INSTANT_ROOFER_WEBHOOK_SECRET and configure the same
 * bearer token on Instant Roofer's webhook settings.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
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
    const requestId = pickString(body, [
      'requestId',
      'requestID',
      'request_id',
      'order.request_id',
    ]);
    const humanReportId = pickString(body, [
      'humanReportId',
      'human_report_id',
      'order.id',
    ]);
    const reportUrl = pickString(body, [
      'reportUrl',
      'report_url',
      'url',
      'report.url',
    ]);
    const reportType = pickString(body, ['reportType', 'report_type', 'report.type']);
    const statusRaw =
      pickString(body, ['status', 'order.status', 'order.status_code']) || '';
    const failureReason = pickString(body, [
      'failureReason',
      'failure_reason',
      'order.failure_reason',
    ]);

    const failed =
      /fail/i.test(statusRaw) ||
      body.event === 'human_report.failed' ||
      (!reportUrl && !!failureReason);

    const existing = await findHumanOrder({ requestId, humanReportId });
    const now = new Date().toISOString();

    const order: HumanMeasureOrder = {
      id:
        existing?.id ||
        humanReportId ||
        requestId ||
        `webhook-${Date.now()}`,
      requestId: requestId || existing?.requestId || null,
      humanReportId: humanReportId || existing?.humanReportId || null,
      leadId: existing?.leadId || null,
      lat: existing?.lat ?? (Number(body.latitude) || 0),
      lng: existing?.lng ?? (Number(body.longitude) || 0),
      address:
        existing?.address ||
        pickString(body, ['originalAddress', 'order.original_address']),
      customerName:
        existing?.customerName ||
        pickString(body, ['customerName', 'order.customer_name']),
      status: failed ? 'failed' : reportUrl ? 'completed' : 'queued',
      reportUrl: reportUrl || existing?.reportUrl || null,
      reportType: reportType || existing?.reportType || null,
      failureReason: failureReason || (failed ? statusRaw || 'failed' : null),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      rawQueued: existing?.rawQueued,
      rawWebhook: body,
    };

    await upsertHumanOrder(order);

    // Ready for future: email/SMS/push when reportUrl is set
    if (order.status === 'completed' && order.reportUrl) {
      console.log(
        '[instant-roofer webhook] Human report ready',
        order.humanReportId || order.requestId,
        order.reportUrl
      );
    }

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
    note: 'POST human report completion payloads here',
  });
}
