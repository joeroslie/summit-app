import { NextRequest, NextResponse } from 'next/server';
import {
  getGoogleClientConfig,
  upsertCalendarEvent,
  type LeadCalendarPayload,
  type SyncLeadResult,
} from '@/lib/google-calendar';
import { getValidGcalTokens } from '@/lib/gcal-cookie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const { configured } = getGoogleClientConfig();
  if (!configured) {
    return NextResponse.json(
      { error: 'Google Calendar is not configured on the server.' },
      { status: 503 }
    );
  }

  const tokens = await getValidGcalTokens();
  if (!tokens?.access_token) {
    return NextResponse.json(
      { error: 'Not connected. Connect Google Calendar in Settings first.' },
      { status: 401 }
    );
  }

  let body: { leads?: LeadCalendarPayload[]; skipClosed?: boolean };
  try {
    body = (await req.json()) as { leads?: LeadCalendarPayload[]; skipClosed?: boolean };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const leads = Array.isArray(body.leads) ? body.leads : [];
  if (leads.length === 0) {
    return NextResponse.json({ results: [] as SyncLeadResult[], synced: 0 });
  }

  const skipClosed = body.skipClosed !== false;
  const results: SyncLeadResult[] = [];

  for (const lead of leads) {
    if (skipClosed && lead.category === 'Closed') {
      results.push({ leadId: lead.id, error: 'skipped_closed' });
      continue;
    }
    try {
      const out = await upsertCalendarEvent(tokens.access_token, lead);
      results.push({
        leadId: lead.id,
        eventId: out.eventId,
        htmlLink: out.htmlLink,
        startDate: out.startDate,
      });
    } catch (e) {
      results.push({
        leadId: lead.id,
        error: e instanceof Error ? e.message : 'sync_failed',
      });
    }
  }

  const synced = results.filter((r) => r.eventId).length;
  return NextResponse.json({ results, synced, total: leads.length });
}
