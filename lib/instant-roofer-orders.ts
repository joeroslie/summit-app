import { promises as fs } from 'fs';
import path from 'path';

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

const DATA_DIR = path.join(process.cwd(), '.data');
const ORDERS_FILE = path.join(DATA_DIR, 'instant-roofer-orders.json');

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(ORDERS_FILE);
  } catch {
    await fs.writeFile(ORDERS_FILE, '[]', 'utf8');
  }
}

export async function readHumanOrders(): Promise<HumanMeasureOrder[]> {
  await ensureStore();
  try {
    const raw = await fs.readFile(ORDERS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as HumanMeasureOrder[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function writeHumanOrders(orders: HumanMeasureOrder[]) {
  await ensureStore();
  await fs.writeFile(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf8');
}

export async function upsertHumanOrder(order: HumanMeasureOrder) {
  const orders = await readHumanOrders();
  const idx = orders.findIndex(
    (o) =>
      o.id === order.id ||
      (order.requestId && o.requestId === order.requestId) ||
      (order.humanReportId && o.humanReportId === order.humanReportId)
  );
  if (idx >= 0) orders[idx] = { ...orders[idx], ...order };
  else orders.unshift(order);
  await writeHumanOrders(orders.slice(0, 200));
  return order;
}

export async function findHumanOrder(opts: {
  requestId?: string | null;
  humanReportId?: string | null;
}): Promise<HumanMeasureOrder | null> {
  const orders = await readHumanOrders();
  return (
    orders.find(
      (o) =>
        (opts.requestId && o.requestId === opts.requestId) ||
        (opts.humanReportId && o.humanReportId === opts.humanReportId) ||
        (opts.requestId && o.id === opts.requestId) ||
        (opts.humanReportId && o.id === opts.humanReportId)
    ) || null
  );
}
