-- Summit Roofing OS — Company / user settings sync
-- Paste in Supabase → SQL Editor → Run once
--
-- Stores:
--   app_settings.key = 'company_settings'  (jsonb: company fields + logo URL/path)
--   app_settings.key = 'user_profile'      (jsonb: name, title, company, phone, email, photo URL/path)
-- Logo binary lives in Storage bucket `company-assets` (public), path logo/company-logo.png
-- Profile photo lives in the same bucket, path profile/user-photo.jpg
--
-- Safe to re-run (IF NOT EXISTS / ON CONFLICT).

-- 1) app_settings table (no-op if you already have it for job_number_prefix)
CREATE TABLE IF NOT EXISTS public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.app_settings IS
  'Org-wide key/value settings (job_number_prefix, company_settings, user_profile, summit_calendar_events, summit_tasks_bundle, …)';

-- Anon/authenticated read+write (matches current Summit single-tenant anon client usage).
-- Tighten when Auth is added.
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "app_settings_select_all" ON public.app_settings;
CREATE POLICY "app_settings_select_all"
  ON public.app_settings FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "app_settings_insert_all" ON public.app_settings;
CREATE POLICY "app_settings_insert_all"
  ON public.app_settings FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "app_settings_update_all" ON public.app_settings;
CREATE POLICY "app_settings_update_all"
  ON public.app_settings FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "app_settings_delete_all" ON public.app_settings;
CREATE POLICY "app_settings_delete_all"
  ON public.app_settings FOR DELETE
  TO anon, authenticated
  USING (true);

-- 2) Public bucket for company logo (same idea as lead-photos / lead-docs)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'company-assets',
  'company-assets',
  true,
  5242880,
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']::text[]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Storage policies for company-assets
DROP POLICY IF EXISTS "company_assets_select" ON storage.objects;
CREATE POLICY "company_assets_select"
  ON storage.objects FOR SELECT
  TO anon, authenticated
  USING (bucket_id = 'company-assets');

DROP POLICY IF EXISTS "company_assets_insert" ON storage.objects;
CREATE POLICY "company_assets_insert"
  ON storage.objects FOR INSERT
  TO anon, authenticated
  WITH CHECK (bucket_id = 'company-assets');

DROP POLICY IF EXISTS "company_assets_update" ON storage.objects;
CREATE POLICY "company_assets_update"
  ON storage.objects FOR UPDATE
  TO anon, authenticated
  USING (bucket_id = 'company-assets')
  WITH CHECK (bucket_id = 'company-assets');

DROP POLICY IF EXISTS "company_assets_delete" ON storage.objects;
CREATE POLICY "company_assets_delete"
  ON storage.objects FOR DELETE
  TO anon, authenticated
  USING (bucket_id = 'company-assets');

-- Optional sanity checks:
-- SELECT key FROM public.app_settings ORDER BY key;
-- SELECT id, public FROM storage.buckets WHERE id = 'company-assets';
