-- Per signed-in Summit user Google Calendar + Tasks OAuth.
-- Refresh token is encrypted at rest by the app (GOOGLE_TOKEN_ENCRYPTION_KEY).
-- Not app_settings (anon RLS). Authenticated RLS only: own row.

CREATE TABLE public.user_google_oauth (
  user_id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  company_id uuid REFERENCES public.companies (id) ON DELETE CASCADE,
  encrypted_refresh_token text NOT NULL,
  encrypted_access_token text,
  access_token_expires_at timestamptz,
  google_email text,
  google_name text,
  scopes text,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.user_google_oauth IS
  'Per signed-in user Google Calendar+Tasks OAuth. Refresh token encrypted in the app. Dedicated table — not app_settings.';

CREATE INDEX user_google_oauth_company_id_idx
  ON public.user_google_oauth (company_id);

ALTER TABLE public.user_google_oauth ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_google_oauth FORCE ROW LEVEL SECURITY;

CREATE POLICY user_google_oauth_select_own
  ON public.user_google_oauth FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY user_google_oauth_insert_own
  ON public.user_google_oauth FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY user_google_oauth_update_own
  ON public.user_google_oauth FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY user_google_oauth_delete_own
  ON public.user_google_oauth FOR DELETE TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON public.user_google_oauth FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_google_oauth TO authenticated;
