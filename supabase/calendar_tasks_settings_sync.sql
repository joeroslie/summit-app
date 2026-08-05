-- Summit Roofing OS — Calendar events + Tasks backup via app_settings
-- Paste in Supabase → SQL Editor → Run once (safe if app_settings already exists)
--
-- Keys:
--   summit_calendar_events  → { events: [...], updatedAt }
--   summit_tasks_bundle     → { tasks: [...], lists: [...], activeListId, updatedAt }
--
-- Google OAuth tokens stay in browser localStorage (not stored here).

CREATE TABLE IF NOT EXISTS public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.app_settings IS
  'Org-wide key/value settings (company_settings, user_profile, summit_calendar_events, summit_tasks_bundle, …)';

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

-- Optional seed empty rows (upsert no-ops on re-run)
INSERT INTO public.app_settings (key, value)
VALUES
  ('summit_calendar_events', '{"events":[]}'::jsonb),
  ('summit_tasks_bundle', '{"tasks":[],"lists":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;
