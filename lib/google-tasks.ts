/**
 * Google Tasks helpers for Summit CRM.
 * Uses the same OAuth access token as Calendar (tasks scope required).
 */

export const GOOGLE_TASKS_SCOPE =
  'https://www.googleapis.com/auth/tasks';

export type GoogleTaskItem = {
  id: string;
  title?: string;
  notes?: string;
  status?: 'needsAction' | 'completed' | string;
  due?: string;
  updated?: string;
  completed?: string;
  selfLink?: string;
  parent?: string;
  deleted?: boolean;
  hidden?: boolean;
};

export type GoogleTaskList = {
  id: string;
  title?: string;
  updated?: string;
  selfLink?: string;
};

export type SummitTaskList = {
  id: string;
  title: string;
  /** Google Tasks list id when linked (`@default` or remote id) */
  googleListId?: string;
  updatedAt: string;
  createdAt: string;
};

export type SummitTask = {
  id: string;
  title: string;
  notes?: string;
  /** YYYY-MM-DD when set */
  dueDate?: string;
  completed: boolean;
  completedAt?: string;
  googleTaskId?: string;
  /**
   * Provenance for disconnect purge (twins calendar event `source`):
   * - local: created in Summit (kept when Google disconnects)
   * - google: imported from Google Tasks (cleared/hidden when disconnected)
   */
  source?: 'local' | 'google';
  /** Soft-delete timestamp — in Tasks Trash until permanently removed */
  deletedAt?: string;
  /** Local Summit list id */
  listId: string;
  updatedAt: string;
  createdAt: string;
};

/** True when this task must clear/hide on Google disconnect. */
export function isGoogleSourcedTask(t: SummitTask): boolean {
  if (!t) return false;
  if (t.source === 'local') return false;
  if (t.source === 'google') return true;
  // Legacy rows with a Google id and no source → treat as Google-imported
  return Boolean(t.googleTaskId);
}

/** Active (not soft-deleted) tasks. */
export function isActiveSummitTask(t: SummitTask): boolean {
  return Boolean(t) && !t.deletedAt;
}

export const DEFAULT_TASK_LIST_ID = 'default';
export const DEFAULT_TASK_LIST_TITLE = 'My Tasks';

const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';

export function newSummitTaskId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function newSummitTaskListId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `list_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function createDefaultTaskList(): SummitTaskList {
  const now = new Date().toISOString();
  return {
    id: DEFAULT_TASK_LIST_ID,
    title: DEFAULT_TASK_LIST_TITLE,
    googleListId: '@default',
    createdAt: now,
    updatedAt: now,
  };
}

/** Parse Google Tasks `due` (RFC3339) into local YYYY-MM-DD. */
export function googleDueToIsoDate(due?: string | null): string | undefined {
  if (!due) return undefined;
  const s = due.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Google Tasks expects RFC3339; midnight UTC for all-day due dates. */
export function isoDateToGoogleDue(iso?: string | null): string | undefined {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso.trim())) return undefined;
  return `${iso.trim()}T00:00:00.000Z`;
}

export function googleTaskToSummit(
  gt: GoogleTaskItem,
  listId: string
): SummitTask {
  const now = new Date().toISOString();
  const completed = gt.status === 'completed';
  return {
    id: newSummitTaskId(),
    title: (gt.title || '').trim() || 'Untitled task',
    notes: gt.notes?.trim() || undefined,
    dueDate: googleDueToIsoDate(gt.due),
    completed,
    completedAt: completed ? gt.completed || gt.updated || now : undefined,
    googleTaskId: gt.id,
    source: 'google',
    listId,
    updatedAt: gt.updated || now,
    createdAt: gt.updated || now,
  };
}

export function summitTaskToGoogleBody(task: SummitTask): {
  title: string;
  notes?: string;
  status: 'needsAction' | 'completed';
  due?: string;
} {
  const body: {
    title: string;
    notes?: string;
    status: 'needsAction' | 'completed';
    due?: string;
  } = {
    title: task.title.trim() || 'Untitled task',
    status: task.completed ? 'completed' : 'needsAction',
  };
  if (task.notes?.trim()) body.notes = task.notes.trim();
  const due = isoDateToGoogleDue(task.dueDate);
  if (due) body.due = due;
  return body;
}

function tasksAuthError(status: number, body: string): Error {
  if (status === 401) {
    return new Error('Session expired — reconnect Google');
  }
  if (
    status === 403 &&
    /accessNotConfigured|has not been used|DISABLED|API has not been|accessNotEnabled|SERVICE_DISABLED/i.test(
      body
    )
  ) {
    return new Error(
      'Enable Google Tasks API in Cloud Console → APIs & Services → Library, wait a minute, then Reconnect for Tasks'
    );
  }
  if (
    status === 403 &&
    /insufficient|ACCESS_TOKEN_SCOPE|PERMISSION|Required '\S*tasks/i.test(body)
  ) {
    return new Error(
      'Google Tasks permission missing — reconnect Google to grant Tasks access'
    );
  }
  if (status === 403) {
    // Ambiguous 403: prefer Tasks API guidance (most common when Calendar works)
    return new Error(
      `Google Tasks blocked (403). Enable Google Tasks API in Cloud Console → APIs & Services → Library, then Reconnect for Tasks. Details: ${body.slice(0, 120)}`
    );
  }
  return new Error(
    `Google Tasks failed (${status}): ${body.slice(0, 160)}`
  );
}

function encodeListId(listId: string): string {
  return encodeURIComponent(listId || '@default');
}

export async function listGoogleTaskLists(
  accessToken: string
): Promise<GoogleTaskList[]> {
  const res = await fetch(`${TASKS_API}/users/@me/lists?maxResults=100`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw tasksAuthError(res.status, await res.text());
  }
  const data = (await res.json()) as { items?: GoogleTaskList[] };
  return (data.items || []).filter((l) => l.id);
}

export async function createGoogleTaskList(
  accessToken: string,
  title: string
): Promise<GoogleTaskList> {
  const res = await fetch(`${TASKS_API}/users/@me/lists`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ title: title.trim() || 'Untitled list' }),
  });
  if (!res.ok) {
    throw tasksAuthError(res.status, await res.text());
  }
  return (await res.json()) as GoogleTaskList;
}

export async function renameGoogleTaskList(
  accessToken: string,
  googleListId: string,
  title: string
): Promise<GoogleTaskList> {
  const res = await fetch(
    `${TASKS_API}/users/@me/lists/${encodeListId(googleListId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ title: title.trim() || 'Untitled list' }),
    }
  );
  if (!res.ok) {
    throw tasksAuthError(res.status, await res.text());
  }
  return (await res.json()) as GoogleTaskList;
}

export async function listGoogleTasks(
  accessToken: string,
  opts?: { showCompleted?: boolean; listId?: string }
): Promise<GoogleTaskItem[]> {
  const listId = opts?.listId || '@default';
  const qs = new URLSearchParams({
    showCompleted: String(opts?.showCompleted !== false),
    showHidden: 'true',
    maxResults: '100',
  });
  const res = await fetch(
    `${TASKS_API}/lists/${encodeListId(listId)}/tasks?${qs.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    }
  );
  if (!res.ok) {
    throw tasksAuthError(res.status, await res.text());
  }
  const data = (await res.json()) as { items?: GoogleTaskItem[] };
  return (data.items || []).filter((t) => t.id && !t.deleted);
}

export async function createGoogleTask(
  accessToken: string,
  task: SummitTask,
  googleListId = '@default'
): Promise<GoogleTaskItem> {
  const res = await fetch(
    `${TASKS_API}/lists/${encodeListId(googleListId)}/tasks`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(summitTaskToGoogleBody(task)),
    }
  );
  if (!res.ok) {
    throw tasksAuthError(res.status, await res.text());
  }
  return (await res.json()) as GoogleTaskItem;
}

export async function updateGoogleTask(
  accessToken: string,
  googleTaskId: string,
  task: SummitTask,
  googleListId = '@default'
): Promise<GoogleTaskItem> {
  const res = await fetch(
    `${TASKS_API}/lists/${encodeListId(googleListId)}/tasks/${encodeURIComponent(googleTaskId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(summitTaskToGoogleBody(task)),
    }
  );
  if (!res.ok) {
    throw tasksAuthError(res.status, await res.text());
  }
  return (await res.json()) as GoogleTaskItem;
}

export async function deleteGoogleTask(
  accessToken: string,
  googleTaskId: string,
  googleListId = '@default'
): Promise<void> {
  const res = await fetch(
    `${TASKS_API}/lists/${encodeListId(googleListId)}/tasks/${encodeURIComponent(googleTaskId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  if (!res.ok && res.status !== 404) {
    throw tasksAuthError(res.status, await res.text());
  }
}

/**
 * Merge Google Tasks into local Summit tasks for one list (bi-directional on refresh):
 * - Update locals that already map to a Google id
 * - Import Google-only tasks
 * - Leave Summit-only locals alone (caller should push those)
 * - Google delete (id absent from successful pull) → remove from Summit
 * - Soft-deleted locals are kept (not resurrected from Google)
 */
export function mergeGoogleTasksIntoLocal(
  local: SummitTask[],
  remote: GoogleTaskItem[],
  listId: string
): { tasks: SummitTask[]; imported: number; updated: number; removed: number } {
  const localSafe = Array.isArray(local) ? local : [];
  const remoteSafe = Array.isArray(remote) ? remote : [];
  const byGoogle = new Map<string, SummitTask>();
  for (const t of localSafe) {
    if (t?.googleTaskId && t.listId === listId) byGoogle.set(t.googleTaskId, t);
  }

  let imported = 0;
  let updated = 0;
  let removed = 0;
  const touchedGoogleIds = new Set<string>();
  const next: SummitTask[] = [];

  // Keep tasks from other lists + Summit-only on this list (incl. soft-deleted)
  for (const t of localSafe) {
    if (!t) continue;
    if (t.listId !== listId) {
      next.push(t);
      continue;
    }
    if (!t.googleTaskId) next.push(t);
  }

  for (const gt of remoteSafe) {
    if (!gt?.id || gt.deleted) continue;
    touchedGoogleIds.add(gt.id);
    const existing = byGoogle.get(gt.id);
    // Soft-deleted locally — do not resurrect from Google pull
    if (existing?.deletedAt) {
      next.push(existing);
      continue;
    }
    const mapped = googleTaskToSummit(gt, listId);
    if (existing) {
      const merged: SummitTask = {
        ...existing,
        title: mapped.title,
        notes: mapped.notes,
        dueDate: mapped.dueDate,
        completed: mapped.completed,
        completedAt: mapped.completedAt,
        googleTaskId: gt.id,
        source: existing.source === 'local' ? 'local' : 'google',
        listId,
        updatedAt: mapped.updatedAt,
        deletedAt: undefined,
      };
      next.push(merged);
      updated += 1;
    } else {
      next.push(mapped);
      imported += 1;
    }
  }

  // Locals linked to Google ids no longer on the remote list → gone (Google delete)
  for (const t of localSafe) {
    if (
      t &&
      t.listId === listId &&
      t.googleTaskId &&
      !touchedGoogleIds.has(t.googleTaskId)
    ) {
      // Soft-deleted local with stale Google id — drop permanently on pull
      removed += 1;
    }
  }

  // Stable-ish: incomplete with due date first, then incomplete, then completed
  next.sort((a, b) => {
    if (Boolean(a.deletedAt) !== Boolean(b.deletedAt)) {
      return a.deletedAt ? 1 : -1;
    }
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    const ad = a.dueDate || '9999';
    const bd = b.dueDate || '9999';
    if (ad !== bd) return ad.localeCompare(bd);
    return a.title.localeCompare(b.title);
  });

  return { tasks: next, imported, updated, removed };
}

/**
 * Merge Google task lists into local Summit lists.
 * Matches by googleListId; imports unmatched Google lists.
 */
export function mergeGoogleListsIntoLocal(
  local: SummitTaskList[],
  remote: GoogleTaskList[]
): { lists: SummitTaskList[]; imported: number; updated: number } {
  const localSafe = Array.isArray(local) ? local : [];
  const remoteSafe = Array.isArray(remote) ? remote : [];
  const byGoogle = new Map<string, SummitTaskList>();
  for (const l of localSafe) {
    if (l?.googleListId) byGoogle.set(l.googleListId, l);
  }

  let imported = 0;
  let updated = 0;
  const touched = new Set<string>();
  const next: SummitTaskList[] = [];

  for (const l of localSafe) {
    if (l && !l.googleListId) next.push(l);
  }

  for (const gl of remoteSafe) {
    if (!gl?.id) continue;
    touched.add(gl.id);
    const existing = byGoogle.get(gl.id);
    const title = (gl.title || '').trim() || 'Untitled list';
    const now = gl.updated || new Date().toISOString();
    if (existing) {
      next.push({
        ...existing,
        title,
        googleListId: gl.id,
        updatedAt: now,
      });
      updated += 1;
    } else {
      // Prefer mapping Google default list onto our default slot
      const isDefault =
        gl.id === '@default' ||
        /^my tasks$/i.test(title);
      const defaultSlot = localSafe.find((l) => l.id === DEFAULT_TASK_LIST_ID);
      if (isDefault && defaultSlot && !touched.has(defaultSlot.googleListId || '')) {
        const already = next.find((l) => l.id === DEFAULT_TASK_LIST_ID);
        if (!already) {
          next.push({
            ...defaultSlot,
            title: title || DEFAULT_TASK_LIST_TITLE,
            googleListId: gl.id,
            updatedAt: now,
          });
          updated += 1;
          continue;
        }
      }
      next.push({
        id: newSummitTaskListId(),
        title,
        googleListId: gl.id,
        createdAt: now,
        updatedAt: now,
      });
      imported += 1;
    }
  }

  for (const l of localSafe) {
    if (l?.googleListId && !touched.has(l.googleListId)) {
      // Keep local list; drop stale google link if remote list vanished
      if (!next.some((x) => x.id === l.id)) {
        next.push({ ...l, googleListId: undefined });
      }
    }
  }

  // Ensure at least one list
  if (next.length === 0) {
    next.push(createDefaultTaskList());
  }

  // Keep default first when present
  next.sort((a, b) => {
    if (a.id === DEFAULT_TASK_LIST_ID) return -1;
    if (b.id === DEFAULT_TASK_LIST_ID) return 1;
    return a.title.localeCompare(b.title);
  });

  return { lists: next, imported, updated };
}
