/** Shared Instant Roofer API helpers (AI + Human Certified). */

export function getInstantRooferApiKey(): string {
  let key = process.env.INSTANT_ROOFER_API_KEY?.trim() || '';
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }
  if (key.toLowerCase().startsWith('bearer ')) {
    key = key.slice(7).trim();
  }
  return key;
}

export type InstantRooferErrorBody = {
  error?: string;
  message?: string;
  status?: number;
};

export async function callInstantRooferV2(body: Record<string, unknown>) {
  const key = getInstantRooferApiKey();
  if (!key) {
    return {
      ok: false as const,
      status: 501,
      json: {
        error: 'instant_roofer_not_configured',
        message:
          'Add INSTANT_ROOFER_API_KEY to .env.local from the Instant Roofer API dashboard (api-dashboard.instantroofer.com).',
      },
    };
  }

  const res = await fetch('https://v5.instantroofer.com/v2', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });

  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }

  if (!res.ok) {
    const statusHint =
      res.status === 401
        ? 'Instant Roofer rejected this API key (401). Agreements/card may still need support to enable AI Measure v2 — email cs@instantroofer.com. Upload EagleView works in the meantime.'
        : res.status === 403
          ? 'This Instant Roofer key does not have AI Measure (v2) enabled — check API dashboard products or email cs@instantroofer.com.'
          : null;
    return {
      ok: false as const,
      status: res.status,
      json: {
        error: 'instant_roofer_upstream',
        message:
          statusHint ||
          (typeof json.message === 'string' && json.message) ||
          (typeof json.error === 'string' && json.error) ||
          `Instant Roofer ${res.status}`,
        status: res.status,
      },
    };
  }

  return { ok: true as const, status: res.status, json };
}
