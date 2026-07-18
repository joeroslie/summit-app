import { NextResponse } from 'next/server';
import { clearGcalTokens } from '@/lib/gcal-cookie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  await clearGcalTokens();
  return NextResponse.json({ ok: true });
}
