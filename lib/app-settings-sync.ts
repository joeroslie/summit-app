/**
 * Company + user profile sync via app_settings + company-assets storage.
 * LocalStorage remains the cache; cloud is the durable source when configured.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export const APP_SETTINGS_COMPANY_KEY = 'company_settings';
export const APP_SETTINGS_USER_PROFILE_KEY = 'user_profile';
/** Summit calendar events JSON (local-first mirror for backup). */
export const APP_SETTINGS_CALENDAR_EVENTS_KEY = 'summit_calendar_events';
/** Summit tasks + task lists JSON bundle. */
export const APP_SETTINGS_TASKS_BUNDLE_KEY = 'summit_tasks_bundle';
export const COMPANY_ASSETS_BUCKET = 'company-assets';
export const COMPANY_LOGO_STORAGE_PATH = 'logo/company-logo.png';

export type SummitTasksCloudBundle = {
  tasks: unknown[];
  lists: unknown[];
  activeListId?: string;
};

export type UserProfileSettings = {
  name: string;
  title: string;
  company: string;
  phone: string;
  email: string;
};

export type CompanySettingsCloud = {
  company: string;
  projectManager: string;
  projectManagerPhone: string;
  /** Project manager email on docs (optional; blank unless filled). */
  projectManagerEmail: string;
  address: string;
  phone: string;
  fax: string;
  email: string;
  license: string;
  /** Public URL or data URL (local preview). Prefer URL after cloud upload. */
  logoDataUrl: string;
  /** Storage object path when logo lives in company-assets. */
  logoPath?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Parse app_settings.value (jsonb object, or JSON string). */
export function parseAppSettingValue(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

export function normalizeUserProfileSettings(
  raw: unknown
): UserProfileSettings | null {
  const r = asRecord(parseAppSettingValue(raw));
  if (!r) return null;
  return {
    name: typeof r.name === 'string' ? r.name : '',
    title: typeof r.title === 'string' ? r.title : '',
    company: typeof r.company === 'string' ? r.company : '',
    phone: typeof r.phone === 'string' ? r.phone : '',
    email: typeof r.email === 'string' ? r.email : '',
  };
}

export function companySettingsForCloud(
  settings: CompanySettingsCloud
): CompanySettingsCloud {
  const logo = (settings.logoDataUrl || '').trim();
  const isData = logo.startsWith('data:');
  return {
    company: settings.company || '',
    projectManager: settings.projectManager || '',
    projectManagerPhone: settings.projectManagerPhone || '',
    projectManagerEmail: settings.projectManagerEmail || '',
    address: settings.address || '',
    phone: settings.phone || '',
    fax: settings.fax || '',
    email: settings.email || '',
    license: settings.license || '',
    // Never push huge base64 into app_settings JSON.
    logoDataUrl: isData ? '' : logo,
    logoPath:
      typeof settings.logoPath === 'string' && settings.logoPath.trim()
        ? settings.logoPath.trim()
        : isData
          ? COMPANY_LOGO_STORAGE_PATH
          : logo
            ? COMPANY_LOGO_STORAGE_PATH
            : '',
  };
}

function dataUrlToBlob(dataUrl: string): { blob: Blob; contentType: string } {
  const m = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
  if (!m) throw new Error('Invalid data URL');
  const contentType = (m[1] || 'image/png').trim() || 'image/png';
  const isBase64 = Boolean(m[2]);
  const payload = m[3] || '';
  if (isBase64) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { blob: new Blob([bytes], { type: contentType }), contentType };
  }
  const decoded = decodeURIComponent(payload);
  return {
    blob: new Blob([decoded], { type: contentType }),
    contentType,
  };
}

export async function fetchAppSetting(
  supabase: SupabaseClient,
  key: string
): Promise<unknown | null> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) throw error;
  return data?.value ?? null;
}

export async function upsertAppSetting(
  supabase: SupabaseClient,
  key: string,
  value: unknown
): Promise<void> {
  const { error } = await supabase.from('app_settings').upsert(
    { key, value },
    { onConflict: 'key' }
  );
  if (error) throw error;
}

/**
 * Upload data-URL logo to company-assets (upsert). Returns public URL + path.
 * If logo is already http(s), returns it unchanged. Empty clears storage object.
 */
export async function syncCompanyLogoToStorage(
  supabase: SupabaseClient,
  logoDataUrl: string
): Promise<{ logoDataUrl: string; logoPath: string }> {
  const logo = (logoDataUrl || '').trim();
  if (!logo) {
    try {
      await supabase.storage
        .from(COMPANY_ASSETS_BUCKET)
        .remove([COMPANY_LOGO_STORAGE_PATH]);
    } catch {
      /* ignore missing */
    }
    return { logoDataUrl: '', logoPath: '' };
  }

  if (/^https?:\/\//i.test(logo)) {
    return { logoDataUrl: logo, logoPath: COMPANY_LOGO_STORAGE_PATH };
  }

  if (!logo.startsWith('data:')) {
    return { logoDataUrl: logo, logoPath: COMPANY_LOGO_STORAGE_PATH };
  }

  const { blob, contentType } = dataUrlToBlob(logo);
  const { error: upErr } = await supabase.storage
    .from(COMPANY_ASSETS_BUCKET)
    .upload(COMPANY_LOGO_STORAGE_PATH, blob, {
      cacheControl: '3600',
      upsert: true,
      contentType,
    });
  if (upErr) throw upErr;

  const { data: pub } = supabase.storage
    .from(COMPANY_ASSETS_BUCKET)
    .getPublicUrl(COMPANY_LOGO_STORAGE_PATH);

  const publicUrl = pub?.publicUrl || '';
  if (!publicUrl) throw new Error('No public URL for company logo');
  // Bust CDN/cache after replace
  const withBust = `${publicUrl}${publicUrl.includes('?') ? '&' : '?'}v=${Date.now()}`;
  return { logoDataUrl: withBust, logoPath: COMPANY_LOGO_STORAGE_PATH };
}

export async function loadCloudCompanySettings(
  supabase: SupabaseClient
): Promise<CompanySettingsCloud | null> {
  const raw = await fetchAppSetting(supabase, APP_SETTINGS_COMPANY_KEY);
  const parsed = asRecord(parseAppSettingValue(raw));
  if (!parsed) return null;

  let logoDataUrl =
    typeof parsed.logoDataUrl === 'string' ? parsed.logoDataUrl : '';
  const logoPath =
    typeof parsed.logoPath === 'string' ? parsed.logoPath.trim() : '';

  // Prefer stored public URL; else resolve from storage path.
  if (!logoDataUrl && logoPath) {
    const { data: pub } = supabase.storage
      .from(COMPANY_ASSETS_BUCKET)
      .getPublicUrl(logoPath);
    logoDataUrl = pub?.publicUrl || '';
  }

  return {
    company: typeof parsed.company === 'string' ? parsed.company : '',
    projectManager:
      typeof parsed.projectManager === 'string' ? parsed.projectManager : '',
    projectManagerPhone:
      typeof parsed.projectManagerPhone === 'string'
        ? parsed.projectManagerPhone
        : '',
    projectManagerEmail:
      typeof parsed.projectManagerEmail === 'string'
        ? parsed.projectManagerEmail
        : '',
    address: typeof parsed.address === 'string' ? parsed.address : '',
    phone: typeof parsed.phone === 'string' ? parsed.phone : '',
    fax: typeof parsed.fax === 'string' ? parsed.fax : '',
    email: typeof parsed.email === 'string' ? parsed.email : '',
    license: typeof parsed.license === 'string' ? parsed.license : '',
    logoDataUrl,
    logoPath: logoPath || (logoDataUrl ? COMPANY_LOGO_STORAGE_PATH : ''),
  };
}

export async function loadCloudUserProfile(
  supabase: SupabaseClient
): Promise<UserProfileSettings | null> {
  const raw = await fetchAppSetting(supabase, APP_SETTINGS_USER_PROFILE_KEY);
  return normalizeUserProfileSettings(raw);
}

export async function saveCloudUserProfile(
  supabase: SupabaseClient,
  profile: UserProfileSettings
): Promise<void> {
  await upsertAppSetting(supabase, APP_SETTINGS_USER_PROFILE_KEY, {
    name: profile.name || '',
    title: profile.title || '',
    company: profile.company || '',
    phone: profile.phone || '',
    email: profile.email || '',
  });
}

export async function saveCloudCompanySettings(
  supabase: SupabaseClient,
  settings: CompanySettingsCloud
): Promise<CompanySettingsCloud> {
  const syncedLogo = await syncCompanyLogoToStorage(
    supabase,
    settings.logoDataUrl || ''
  );
  const payload = companySettingsForCloud({
    ...settings,
    logoDataUrl: syncedLogo.logoDataUrl,
    logoPath: syncedLogo.logoPath,
  });
  // Persist public URL (not base64) in app_settings.
  payload.logoDataUrl = syncedLogo.logoDataUrl;
  payload.logoPath = syncedLogo.logoPath;
  await upsertAppSetting(supabase, APP_SETTINGS_COMPANY_KEY, payload);
  return payload;
}

/** Load Summit calendar events array from app_settings (or null if empty). */
export async function loadCloudCalendarEvents(
  supabase: SupabaseClient
): Promise<unknown[] | null> {
  const raw = await fetchAppSetting(supabase, APP_SETTINGS_CALENDAR_EVENTS_KEY);
  const parsed = parseAppSettingValue(raw);
  if (Array.isArray(parsed)) return parsed;
  const rec = asRecord(parsed);
  if (rec && Array.isArray(rec.events)) return rec.events;
  return null;
}

export async function saveCloudCalendarEvents(
  supabase: SupabaseClient,
  events: unknown[]
): Promise<void> {
  await upsertAppSetting(supabase, APP_SETTINGS_CALENDAR_EVENTS_KEY, {
    events: Array.isArray(events) ? events : [],
    updatedAt: new Date().toISOString(),
  });
}

/** Load tasks + lists bundle from app_settings. */
export async function loadCloudTasksBundle(
  supabase: SupabaseClient
): Promise<SummitTasksCloudBundle | null> {
  const raw = await fetchAppSetting(supabase, APP_SETTINGS_TASKS_BUNDLE_KEY);
  const parsed = asRecord(parseAppSettingValue(raw));
  if (!parsed) return null;
  return {
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    lists: Array.isArray(parsed.lists) ? parsed.lists : [],
    activeListId:
      typeof parsed.activeListId === 'string'
        ? parsed.activeListId
        : undefined,
  };
}

export async function saveCloudTasksBundle(
  supabase: SupabaseClient,
  bundle: SummitTasksCloudBundle
): Promise<void> {
  await upsertAppSetting(supabase, APP_SETTINGS_TASKS_BUNDLE_KEY, {
    tasks: Array.isArray(bundle.tasks) ? bundle.tasks : [],
    lists: Array.isArray(bundle.lists) ? bundle.lists : [],
    activeListId: bundle.activeListId || '',
    updatedAt: new Date().toISOString(),
  });
}
