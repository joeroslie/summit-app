/** Global header search — named objects only. No secrets, weather feed, price book, or trash. */

export type AppSearchKind =
  | 'lead'
  | 'estimate'
  | 'event'
  | 'task'
  | 'document'
  | 'photo'
  | 'invoice'
  | 'pin'
  | 'page';

export const SEARCH_KIND_LABEL: Record<AppSearchKind, string> = {
  lead: 'Lead',
  estimate: 'Estimate',
  event: 'Event',
  task: 'Task',
  document: 'Document',
  photo: 'Photo',
  invoice: 'Invoice',
  pin: 'Pin',
  page: 'Page',
};

export type AppSearchAction =
  | { type: 'lead'; leadId: number; profileTab?: string }
  | { type: 'estimate'; leadId: number; estimateId: number }
  | { type: 'event'; eventId: string; date: string }
  | { type: 'task'; taskId: string; listId: string }
  | { type: 'document'; leadId: number; docId: string; url: string }
  | { type: 'photo'; leadId: number; photoId: string }
  | { type: 'invoice'; invoiceId: string; url: string; leadId: number | null }
  | { type: 'pin'; pinId: number }
  | {
      type: 'page';
      tab: string;
      workspace?: 'pricing' | 'takeoff' | 'mitigation' | 'emergency';
      settingsSection?:
        | 'account'
        | 'google'
        | 'appearance'
        | 'profile'
        | 'company';
    };

export type AppSearchRecord = {
  id: string;
  kind: AppSearchKind;
  title: string;
  subtitle: string;
  haystack: string;
  action: AppSearchAction;
};

export type AppSearchHit = AppSearchRecord & {
  score: number;
  kindLabel: string;
};

const KIND_SCORE: Record<AppSearchKind, number> = {
  lead: 100,
  estimate: 88,
  event: 86,
  task: 86,
  invoice: 82,
  document: 80,
  pin: 78,
  photo: 70,
  page: 42,
};

const MAX_RESULTS = 12;

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const MONTHS_SHORT = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

export function searchHay(
  parts: Array<string | number | null | undefined | false>
): string {
  return parts
    .filter(
      (p): p is string | number =>
        p !== null && p !== undefined && p !== false && p !== ''
    )
    .map((p) => String(p).trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function dateSearchText(iso?: string | null): string {
  if (!iso) return '';
  const m = String(iso)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso);
  const y = m[1];
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!mo || !d || mo > 12) return String(iso);
  const month = MONTHS[mo - 1];
  const short = MONTHS_SHORT[mo - 1];
  return searchHay([
    `${y}-${m[2]}-${m[3]}`,
    `${mo}/${d}/${y}`,
    `${mo}/${d}`,
    `${month} ${d}`,
    `${short} ${d}`,
    `${month} ${d} ${y}`,
    `${short} ${d} ${y}`,
  ]);
}

function moneySearchText(n?: number | null): string {
  if (n == null || !Number.isFinite(n) || n === 0) return '';
  const rounded = Math.round(n);
  return `${rounded} $${rounded.toLocaleString()}`;
}

export function queryMatchesHay(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const h = haystack.toLowerCase();
  if (h.includes(q)) return true;
  const qd = q.replace(/\D/g, '');
  if (qd.length >= 3) {
    const hd = haystack.replace(/\D/g, '');
    if (hd.includes(qd)) return true;
  }
  return false;
}

function scoreRecord(record: AppSearchRecord, query: string): number {
  const q = query.trim().toLowerCase();
  const title = record.title.toLowerCase();
  let score = KIND_SCORE[record.kind];
  if (title === q) score += 80;
  else if (title.startsWith(q)) score += 50;
  else if (title.includes(q)) score += 24;
  if (record.kind === 'page' && title.includes(q) && q.length >= 3) {
    score += 36;
  }
  return score;
}

export function queryAppSearch(
  records: AppSearchRecord[],
  query: string
): AppSearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const hits: AppSearchHit[] = [];
  for (const record of records) {
    if (!queryMatchesHay(`${record.title} ${record.subtitle} ${record.haystack}`, q)) {
      continue;
    }
    hits.push({
      ...record,
      score: scoreRecord(record, q),
      kindLabel: SEARCH_KIND_LABEL[record.kind],
    });
  }
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.title.localeCompare(b.title);
  });
  return hits.slice(0, MAX_RESULTS);
}

export type LeadSearchLead = {
  id: number;
  clientFirstName: string;
  clientLastName: string;
  clientAddress: string;
  clientCity: string;
  clientState: string;
  clientZip: string;
  clientPhone: string;
  clientEmail: string;
  additionalEmails?: string[];
  additionalContacts?: Array<{
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
    relationship?: string;
  }>;
  company?: string;
  jobNumber: string;
  billingAddress?: string;
  billingCity?: string;
  billingState?: string;
  billingZip?: string;
  jobCategory?: string;
  hoaInfo?: string;
  leadSource?: string;
  referralName?: string;
  insuranceCompany?: string;
  damageLocation?: string;
  dateOfLoss?: string;
  claimNumber?: string;
  policyNumber?: string;
  adjusterName?: string;
  adjusterPhone?: string;
  adjusterEmail?: string;
  category: string;
  notes?: Array<{ text?: string }>;
  assignedCrewName?: string;
  assignedCrewContact?: string;
  assignedCrewPhone?: string;
  adjustmentDate?: string;
  financialNotes?: string;
  financialLabels?: string;
  takeoffNotes?: string;
  photoReportTitles?: string;
  approvedJobValue?: number;
  estimates?: Array<{
    id: number;
    date?: string;
    selectedShingle?: string;
    systemLabel?: string;
    notes?: string;
    total?: number;
    pdfName?: string;
  }>;
  documents?: Array<{
    id: string;
    name: string;
    url: string;
    folder?: string;
  }>;
  measurementReports?: Array<{
    id: string;
    name: string;
    url: string;
  }>;
  photos?: Array<{ id: string; name: string }>;
};

function isEstimatePdfDoc(doc: { id: string; name: string; url: string }): boolean {
  if (doc.id.startsWith('est-')) return true;
  if (/\/estimates\//i.test(doc.url || '')) return true;
  if (/_Estimate_/i.test(doc.name || '')) return true;
  return false;
}

export function recordsFromLead(lead: LeadSearchLead): AppSearchRecord[] {
  const name =
    searchHay([lead.clientFirstName, lead.clientLastName]) || 'Untitled lead';
  const addr = searchHay([
    lead.clientAddress,
    lead.clientCity,
    lead.clientState,
    lead.clientZip,
  ]);
  const contacts = (lead.additionalContacts || []).flatMap((c) => [
    c.firstName,
    c.lastName,
    c.phone,
    c.email,
    c.relationship,
  ]);
  const noteText = (lead.notes || []).map((n) => n.text).filter(Boolean);
  const leadRecord: AppSearchRecord = {
    id: `lead-${lead.id}`,
    kind: 'lead',
    title: name,
    subtitle: searchHay([addr, lead.jobNumber ? `#${lead.jobNumber}` : '', lead.category]),
    haystack: searchHay([
      name,
      addr,
      lead.clientPhone,
      lead.clientEmail,
      ...(lead.additionalEmails || []),
      ...contacts,
      lead.company,
      lead.jobNumber,
      lead.billingAddress,
      lead.billingCity,
      lead.billingState,
      lead.billingZip,
      lead.jobCategory,
      lead.hoaInfo,
      lead.leadSource,
      lead.referralName,
      lead.insuranceCompany,
      lead.damageLocation,
      dateSearchText(lead.dateOfLoss),
      lead.claimNumber,
      lead.policyNumber,
      lead.adjusterName,
      lead.adjusterPhone,
      lead.adjusterEmail,
      lead.category,
      ...noteText,
      lead.assignedCrewName,
      lead.assignedCrewContact,
      lead.assignedCrewPhone,
      dateSearchText(lead.adjustmentDate),
      lead.financialNotes,
      lead.financialLabels,
      lead.takeoffNotes,
      lead.photoReportTitles,
      moneySearchText(lead.approvedJobValue),
    ]),
    action: { type: 'lead', leadId: lead.id },
  };

  const out: AppSearchRecord[] = [leadRecord];

  for (const est of lead.estimates || []) {
    const total = moneySearchText(est.total);
    out.push({
      id: `estimate-${lead.id}-${est.id}`,
      kind: 'estimate',
      title: searchHay([est.systemLabel || est.selectedShingle, name]) || 'Estimate',
      subtitle: searchHay([est.date, total, lead.jobNumber ? `#${lead.jobNumber}` : '']),
      haystack: searchHay([
        name,
        addr,
        lead.jobNumber,
        est.date,
        dateSearchText(est.date),
        est.selectedShingle,
        est.systemLabel,
        est.notes,
        est.pdfName,
        total,
      ]),
      action: { type: 'estimate', leadId: lead.id, estimateId: est.id },
    });
  }

  const docs = [
    ...(lead.documents || []),
    ...(lead.measurementReports || []).map((d) => ({ ...d, folder: 'measurements' })),
  ];
  for (const doc of docs) {
    if (!doc?.name || isEstimatePdfDoc(doc)) continue;
    out.push({
      id: `doc-${lead.id}-${doc.id}`,
      kind: 'document',
      title: doc.name,
      subtitle: name,
      haystack: searchHay([doc.name, name, lead.jobNumber, doc.folder]),
      action: { type: 'document', leadId: lead.id, docId: doc.id, url: doc.url },
    });
  }

  for (const photo of lead.photos || []) {
    if (!photo?.name) continue;
    out.push({
      id: `photo-${lead.id}-${photo.id}`,
      kind: 'photo',
      title: photo.name,
      subtitle: name,
      haystack: searchHay([photo.name, name, lead.jobNumber]),
      action: { type: 'photo', leadId: lead.id, photoId: photo.id },
    });
  }

  return out;
}

export function recordsFromEvent(event: {
  id: string;
  title: string;
  notes?: string;
  startDate: string;
  leadName?: string;
}): AppSearchRecord {
  return {
    id: `event-${event.id}`,
    kind: 'event',
    title: event.title || 'Untitled event',
    subtitle: searchHay([dateSearchText(event.startDate), event.leadName]),
    haystack: searchHay([
      event.title,
      event.notes,
      event.leadName,
      event.startDate,
      dateSearchText(event.startDate),
    ]),
    action: { type: 'event', eventId: event.id, date: event.startDate },
  };
}

export function recordsFromTask(task: {
  id: string;
  title: string;
  notes?: string;
  dueDate?: string;
  listId: string;
  listTitle?: string;
}): AppSearchRecord {
  return {
    id: `task-${task.id}`,
    kind: 'task',
    title: task.title || 'Untitled task',
    subtitle: searchHay([task.listTitle, dateSearchText(task.dueDate)]),
    haystack: searchHay([
      task.title,
      task.notes,
      task.listTitle,
      task.dueDate,
      dateSearchText(task.dueDate),
    ]),
    action: { type: 'task', taskId: task.id, listId: task.listId },
  };
}

export function recordsFromInvoice(inv: {
  id: string;
  title: string;
  leadLabel?: string;
  job?: string;
  claimNumber?: string;
  fileName?: string;
  url: string;
  leadId: number | null;
  total?: number;
}): AppSearchRecord {
  return {
    id: `invoice-${inv.id}`,
    kind: 'invoice',
    title: inv.title || inv.fileName || 'Invoice',
    subtitle: searchHay([inv.leadLabel, inv.job, moneySearchText(inv.total)]),
    haystack: searchHay([
      inv.title,
      inv.leadLabel,
      inv.job,
      inv.claimNumber,
      inv.fileName,
      moneySearchText(inv.total),
    ]),
    action: {
      type: 'invoice',
      invoiceId: inv.id,
      url: inv.url,
      leadId: inv.leadId,
    },
  };
}

export function recordsFromPin(pin: {
  id: number;
  address?: string | null;
  owner_name?: string | null;
  notes?: string | null;
  disposition?: string;
  dispositionLabel?: string;
  parcelId?: string | null;
  siteAddress?: string | null;
}): AppSearchRecord {
  const title =
    pin.owner_name || pin.address || pin.siteAddress || 'Canvass pin';
  return {
    id: `pin-${pin.id}`,
    kind: 'pin',
    title,
    subtitle: searchHay([pin.address || pin.siteAddress, pin.dispositionLabel]),
    haystack: searchHay([
      pin.owner_name,
      pin.address,
      pin.siteAddress,
      pin.notes,
      pin.disposition,
      pin.dispositionLabel,
      pin.parcelId,
    ]),
    action: { type: 'pin', pinId: pin.id },
  };
}

export type PageSearchInput = {
  id: string;
  title: string;
  subtitle?: string;
  haystack?: string;
  action: Extract<AppSearchAction, { type: 'page' }>;
};

export function recordsFromPages(pages: PageSearchInput[]): AppSearchRecord[] {
  return pages.map((page) => ({
    id: `page-${page.id}`,
    kind: 'page',
    title: page.title,
    subtitle: page.subtitle || '',
    haystack: searchHay([page.title, page.subtitle, page.haystack]),
    action: page.action,
  }));
}
