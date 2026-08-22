import { promises as fs } from 'fs';
import path from 'path';
import { createClient as createSupabaseJs } from '@supabase/supabase-js';
import { createClient as createCookieClient } from '@/lib/supabase/server';

export type HumanMeasureOrder = {
  id: string;
  requestId: string | null;
  humanReportId: string | null;
  leadId: string | null;
  lat: number;
  lng: number;
  address: string | null;
  customerName: string | null;
  status: 'queued' | 'completed' | 'failed';
  reportUrl: string | null;
  reportType: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  rawQueued?: unknown;
  rawWebhook?: unknown;
};

type OrderRow = {
  id: string;
  request_id: string | null;
  human_report_id: string | null;
  lead_id: string | null;
  lat: number;
  lng: number;
  address: string | null;
  customer_name: string | null;
  status: HumanMeasureOrder['status'];
  report_url: string | null;
  report_type: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  raw_queued?: unknown;
  raw_webhook?: unknown;
};

const DATA_DIR = path.join(process.cwd(), '.data');
const ORDERS_FILE = path.join(DATA_DIR, 'instant-roofer-orders.json');

function supabaseUrlAndAnon(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || '';
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ||
    '';
  if (!url || url.includes('YOUR_') || !key || key.startsWith('YOUR_')) {
    return null;
  }
  return { url, key };
}

function anonClient() {
  const cfg = supabaseUrlAndAnon();
  if (!cfg) return null;
  return createSupabaseJs(cfg.url, cfg.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function rowToOrder(row: OrderRow): HumanMeasureOrder {
  return {
    id: row.id,
    requestId: row.request_id,
    humanReportId: row.human_report_id,
    leadId: row.lead_id,
    lat: Number(row.lat) || 0,
    lng: Number(row.lng) || 0,
    address: row.address,
    customerName: row.customer_name,
    status: row.status,
    reportUrl: row.report_url,
    reportType: row.report_type,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rawQueued: row.raw_queued,
    rawWebhook: row.raw_webhook,
  };
}

function orderToMergeJson(order: HumanMeasureOrder) {
  return {
    id: order.id,
    request_id: order.requestId,
    human_report_id: order.humanReportId,
    lead_id: order.leadId,
    lat: order.lat,
    lng: order.lng,
    address: order.address,
    customer_name: order.customerName,
    status: order.status,
    report_url: order.reportUrl,
    report_type: order.reportType,
    failure_reason: order.failureReason,
    raw_queued: order.rawQueued ?? null,
    raw_webhook: order.rawWebhook ?? null,
  };
}

async function ensureStore() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.access(ORDERS_FILE);
  } catch {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(ORDERS_FILE, '[]', 'utf8');
    } catch {
      /* read-only host */
    }
  }
}

async function readFileOrders(): Promise<HumanMeasureOrder[]> {
  await ensureStore();
  try {
    const raw = await fs.readFile(ORDERS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as HumanMeasureOrder[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeFileOrders(orders: HumanMeasureOrder[]) {
  try {
    await ensureStore();
    await fs.writeFile(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf8');
  } catch (err) {
    // Vercel’s function FS is read-only except /tmp — Postgres is the store.
    console.warn('instant-roofer file store skipped', err);
  }
}

function fileUpsert(orders: HumanMeasureOrder[], order: HumanMeasureOrder) {
  const idx = orders.findIndex(
    (o) =>
      o.id === order.id ||
      (order.requestId && o.requestId === order.requestId) ||
      (order.humanReportId && o.humanReportId === order.humanReportId)
  );
  if (idx >= 0) orders[idx] = { ...orders[idx], ...order };
  else orders.unshift(order);
  return orders.slice(0, 200);
}

async function mergeViaRpc(order: HumanMeasureOrder): Promise<HumanMeasureOrder | null> {
  const sb = anonClient();
  if (!sb) return null;
  const { data, error } = await sb.rpc('merge_instant_roofer_human_order', {
    order_json: orderToMergeJson(order),
  });
  if (error) {
    console.error('instant-roofer merge rpc', error.message);
    return null;
  }
  if (data && typeof data === 'object' && 'id' in (data as object)) {
    return rowToOrder(data as OrderRow);
  }
  return order;
}

export async function readHumanOrders(): Promise<HumanMeasureOrder[]> {
  try {
    const supabase = await createCookieClient();
    const { data, error } = await supabase
      .from('instant_roofer_human_orders')
      .select(
        'id, request_id, human_report_id, lead_id, lat, lng, address, customer_name, status, report_url, report_type, failure_reason, created_at, updated_at'
      )
      .order('created_at', { ascending: false })
      .limit(200);
    if (!error && Array.isArray(data)) {
      return (data as OrderRow[]).map(rowToOrder);
    }
  } catch {
    /* local / no cookies */
  }
  return readFileOrders();
}

export async function writeHumanOrders(orders: HumanMeasureOrder[]) {
  await writeFileOrders(orders);
}

export async function upsertHumanOrder(
  order: HumanMeasureOrder,
  opts?: { viaWebhook?: boolean }
) {
  if (opts?.viaWebhook) {
    const merged = await mergeViaRpc(order);
    const next = merged || order;
    const files = fileUpsert(await readFileOrders(), next);
    await writeFileOrders(files);
    return next;
  }

  try {
    const supabase = await createCookieClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    let companyId: string | null = null;
    if (user) {
      const { data: membership } = await supabase
        .from('company_members')
        .select('company_id')
        .eq('user_id', user.id)
        .maybeSingle();
      if (membership && typeof membership.company_id === 'string') {
        companyId = membership.company_id;
      }
    }
    const row = {
      id: order.id,
      request_id: order.requestId,
      human_report_id: order.humanReportId,
      lead_id: order.leadId,
      company_id: companyId,
      lat: order.lat,
      lng: order.lng,
      address: order.address,
      customer_name: order.customerName,
      status: order.status,
      report_url: order.reportUrl,
      report_type: order.reportType,
      failure_reason: order.failureReason,
      raw_queued: order.rawQueued ?? null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from('instant_roofer_human_orders')
      .upsert(row, { onConflict: 'id' });
    if (error) {
      const viaRpc = await mergeViaRpc(order);
      if (!viaRpc) console.error('instant-roofer order upsert', error.message);
    }
  } catch (err) {
    console.error('instant-roofer order persist', err);
    await mergeViaRpc(order);
  }

  const files = fileUpsert(await readFileOrders(), order);
  await writeFileOrders(files);
  return order;
}

function orderForLeadDetails(order: HumanMeasureOrder) {
  return {
    id: order.id,
    requestId: order.requestId,
    leadId: order.leadId,
    status: order.status,
    reportUrl: order.reportUrl,
    address: order.address,
    createdAt: order.createdAt,
    failureReason: order.failureReason,
  };
}

function mergeLeadOrderList(existing: unknown, incoming: HumanMeasureOrder) {
  const list = Array.isArray(existing) ? [...existing] : [];
  const key = incoming.id || incoming.requestId;
  const idx = list.findIndex((item) => {
    if (!item || typeof item !== 'object') return false;
    const r = item as Record<string, unknown>;
    return String(r.id || r.requestId || '') === key;
  });
  const row = orderForLeadDetails(incoming);
  if (idx >= 0) list[idx] = { ...(list[idx] as object), ...row };
  else list.unshift(row);
  return list.slice(0, 20);
}

/** Copy Human Certified status onto the lead row so every device sees it. */
export async function attachHumanOrderToLead(
  order: HumanMeasureOrder,
  cloudLeadId?: string | null
) {
  try {
    const supabase = await createCookieClient();
    let row: { id: string; details: unknown } | null = null;
    const uuid = cloudLeadId?.trim() || '';
    if (uuid && /^[0-9a-f-]{36}$/i.test(uuid)) {
      const { data } = await supabase
        .from('leads')
        .select('id, details')
        .eq('id', uuid)
        .maybeSingle();
      if (data?.id) row = data as { id: string; details: unknown };
    }
    if (!row && order.leadId) {
      const { data } = await supabase
        .from('leads')
        .select('id, details')
        .is('deleted_at', null)
        .limit(200);
      const wanted = String(order.leadId);
      const found = (data || []).find((r) => {
        const d =
          r.details && typeof r.details === 'object'
            ? (r.details as Record<string, unknown>)
            : {};
        return (
          String(r.id) === wanted ||
          String(d.clientNumericId ?? '') === wanted
        );
      });
      if (found?.id) row = found as { id: string; details: unknown };
    }
    if (!row) return;
    const details =
      row.details && typeof row.details === 'object'
        ? { ...(row.details as Record<string, unknown>) }
        : {};
    details.humanMeasureOrders = mergeLeadOrderList(
      details.humanMeasureOrders,
      order
    );
    const { error } = await supabase
      .from('leads')
      .update({ details, updated_at: new Date().toISOString() })
      .eq('id', row.id);
    if (error) console.error('instant-roofer attach lead', error.message);
  } catch (err) {
    console.error('instant-roofer attach lead', err);
  }
}

export async function findHumanOrder(opts: {
  requestId?: string | null;
  humanReportId?: string | null;
}): Promise<HumanMeasureOrder | null> {
  const orders = await readHumanOrders();
  const fromSession = orders.find(
    (o) =>
      (opts.requestId && o.requestId === opts.requestId) ||
      (opts.humanReportId && o.humanReportId === opts.humanReportId) ||
      (opts.requestId && o.id === opts.requestId) ||
      (opts.humanReportId && o.id === opts.humanReportId)
  );
  if (fromSession) return fromSession;

  const files = await readFileOrders();
  return (
    files.find(
      (o) =>
        (opts.requestId && o.requestId === opts.requestId) ||
        (opts.humanReportId && o.humanReportId === opts.humanReportId) ||
        (opts.requestId && o.id === opts.requestId) ||
        (opts.humanReportId && o.id === opts.humanReportId)
    ) || null
  );
}
