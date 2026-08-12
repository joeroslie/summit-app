-- =============================================================================
-- Summit: companies + members, authenticated RLS, pricing read-only
-- =============================================================================
-- Applied to the live project via migration. Safe-ish to re-run
-- (IF NOT EXISTS / DROP POLICY IF EXISTS). Does not insert or change prices.
--
-- First auth user becomes owner of the single company and existing rows
-- (leads, estimates, settings, canvass, orders) are attached to that company.
-- Later signups do NOT auto-join — add them in company_members.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO postgres, supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- Companies + members (Stripe columns reserved, unused)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'Company',
  stripe_customer_id text,
  stripe_subscription_id text,
  plan text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.companies IS
  'Tenant company. One row for Joe now; add rows later for SaaS. Stripe columns are unused until billing is built.';

CREATE TABLE IF NOT EXISTS public.company_members (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);

CREATE INDEX IF NOT EXISTS company_members_user_id_idx
  ON public.company_members (user_id);

COMMENT ON TABLE public.company_members IS
  'Users who can access a company. First signup becomes owner; later users must be inserted here.';

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id);
ALTER TABLE public.estimates
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id);
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id);
ALTER TABLE public.canvass_pins
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id);
ALTER TABLE public.canvass_tallies
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id);
ALTER TABLE public.material_orders
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id);

CREATE INDEX IF NOT EXISTS leads_company_id_idx ON public.leads (company_id);
CREATE INDEX IF NOT EXISTS estimates_company_id_idx ON public.estimates (company_id);
CREATE INDEX IF NOT EXISTS app_settings_company_id_idx ON public.app_settings (company_id);
CREATE INDEX IF NOT EXISTS canvass_pins_company_id_idx ON public.canvass_pins (company_id);
CREATE INDEX IF NOT EXISTS canvass_tallies_company_id_idx ON public.canvass_tallies (company_id);
CREATE INDEX IF NOT EXISTS material_orders_company_id_idx ON public.material_orders (company_id);

-- ---------------------------------------------------------------------------
-- Triggers: stamp company_id (and user_id on leads/estimates) on insert
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_row_company_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.company_id IS NULL THEN
    SELECT m.company_id INTO NEW.company_id
    FROM public.company_members m
    WHERE m.user_id = auth.uid()
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_row_company_and_user_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.company_id IS NULL THEN
    SELECT m.company_id INTO NEW.company_id
    FROM public.company_members m
    WHERE m.user_id = auth.uid()
    LIMIT 1;
  END IF;
  IF NEW.user_id IS NULL THEN
    NEW.user_id := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leads_set_company_id ON public.leads;
CREATE TRIGGER leads_set_company_id
  BEFORE INSERT ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.set_row_company_and_user_id();

DROP TRIGGER IF EXISTS estimates_set_company_id ON public.estimates;
CREATE TRIGGER estimates_set_company_id
  BEFORE INSERT ON public.estimates
  FOR EACH ROW
  EXECUTE FUNCTION public.set_row_company_and_user_id();

DROP TRIGGER IF EXISTS app_settings_set_company_id ON public.app_settings;
CREATE TRIGGER app_settings_set_company_id
  BEFORE INSERT ON public.app_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.set_row_company_id();

DROP TRIGGER IF EXISTS canvass_pins_set_company_id ON public.canvass_pins;
CREATE TRIGGER canvass_pins_set_company_id
  BEFORE INSERT ON public.canvass_pins
  FOR EACH ROW
  EXECUTE FUNCTION public.set_row_company_id();

DROP TRIGGER IF EXISTS canvass_tallies_set_company_id ON public.canvass_tallies;
CREATE TRIGGER canvass_tallies_set_company_id
  BEFORE INSERT ON public.canvass_tallies
  FOR EACH ROW
  EXECUTE FUNCTION public.set_row_company_id();

DROP TRIGGER IF EXISTS material_orders_set_company_id ON public.material_orders;
CREATE TRIGGER material_orders_set_company_id
  BEFORE INSERT ON public.material_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.set_row_company_id();

CREATE OR REPLACE FUNCTION public.set_material_orders_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_canvass_pins_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- First auth user owns the company and inherits existing field data.
-- Later users are not auto-added (locked down).
CREATE OR REPLACE FUNCTION private.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  cid uuid;
  cname text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('summit.bootstrap_company'));

  SELECT id INTO cid FROM public.companies LIMIT 1;
  IF cid IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT NULLIF(trim(value->>'company'), '')
    INTO cname
    FROM public.app_settings
    WHERE key = 'company_settings';

  INSERT INTO public.companies (name)
  VALUES (COALESCE(cname, 'Company'))
  RETURNING id INTO cid;

  INSERT INTO public.company_members (company_id, user_id, role)
  VALUES (cid, NEW.id, 'owner');

  UPDATE public.leads SET company_id = cid WHERE company_id IS NULL;
  UPDATE public.estimates SET company_id = cid WHERE company_id IS NULL;
  UPDATE public.app_settings SET company_id = cid WHERE company_id IS NULL;
  UPDATE public.canvass_pins SET company_id = cid WHERE company_id IS NULL;
  UPDATE public.canvass_tallies SET company_id = cid WHERE company_id IS NULL;
  UPDATE public.material_orders SET company_id = cid WHERE company_id IS NULL;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.handle_new_user() TO postgres, supabase_auth_admin;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION private.handle_new_user();

-- ---------------------------------------------------------------------------
-- Drop leftover open / unused policies, then lock down
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r record;
  t text;
  tables text[] := ARRAY[
    'leads', 'estimates', 'app_settings',
    'canvass_pins', 'canvass_tallies', 'material_orders',
    'companies', 'company_members',
    'price_sheet', 'cost_sheet_labor', 'cost_sheet_material',
    'mitigation_price_sheet', 'mitigation_cost_sheet',
    'labor_cost_sheet', 'material_cost_sheet', 'cost_sheet'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    FOR r IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, t);
    END LOOP;
  END LOOP;
END $$;

-- Operational tables: logged-in company members only
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'leads', 'estimates', 'app_settings',
    'canvass_pins', 'canvass_tallies', 'material_orders'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (company_id IN (SELECT company_id FROM public.company_members WHERE user_id = auth.uid()))',
      t || '_select_member', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (company_id IN (SELECT company_id FROM public.company_members WHERE user_id = auth.uid()))',
      t || '_insert_member', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (company_id IN (SELECT company_id FROM public.company_members WHERE user_id = auth.uid())) WITH CHECK (company_id IN (SELECT company_id FROM public.company_members WHERE user_id = auth.uid()))',
      t || '_update_member', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (company_id IN (SELECT company_id FROM public.company_members WHERE user_id = auth.uid()))',
      t || '_delete_member', t
    );

    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon', t);
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated',
      t
    );
  END LOOP;
END $$;

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY companies_select_member
  ON public.companies FOR SELECT TO authenticated
  USING (id IN (SELECT company_id FROM public.company_members WHERE user_id = auth.uid()));

CREATE POLICY companies_update_owner
  ON public.companies FOR UPDATE TO authenticated
  USING (id IN (
    SELECT company_id FROM public.company_members
    WHERE user_id = auth.uid() AND role = 'owner'
  ))
  WITH CHECK (id IN (
    SELECT company_id FROM public.company_members
    WHERE user_id = auth.uid() AND role = 'owner'
  ));

CREATE POLICY company_members_select_own
  ON public.company_members FOR SELECT TO authenticated
  USING (user_id = auth.uid());

REVOKE ALL ON public.companies FROM PUBLIC, anon;
REVOKE ALL ON public.company_members FROM PUBLIC, anon;
GRANT SELECT, UPDATE ON public.companies TO authenticated;
GRANT SELECT ON public.company_members TO authenticated;

-- Pricing / cost: read-only for signed-in users. Writes stay SQL-editor only.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'price_sheet',
    'cost_sheet_labor',
    'cost_sheet_material',
    'mitigation_price_sheet',
    'mitigation_cost_sheet',
    'labor_cost_sheet',
    'material_cost_sheet',
    'cost_sheet'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)',
      t || '_readonly', t
    );
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- ---------------------------------------------------------------------------
-- Storage: authenticated writes. Buckets stay public (URL fetch still works
-- without a key — flipping private needs signed URLs in the app first).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', r.policyname);
  END LOOP;
END $$;

CREATE POLICY lead_photos_select ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'lead-photos');
CREATE POLICY lead_photos_insert ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'lead-photos');
CREATE POLICY lead_photos_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'lead-photos') WITH CHECK (bucket_id = 'lead-photos');
CREATE POLICY lead_photos_delete ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'lead-photos');

CREATE POLICY lead_docs_select ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'lead-docs');
CREATE POLICY lead_docs_insert ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'lead-docs');
CREATE POLICY lead_docs_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'lead-docs') WITH CHECK (bucket_id = 'lead-docs');
CREATE POLICY lead_docs_delete ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'lead-docs');

CREATE POLICY company_assets_select ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'company-assets');
CREATE POLICY company_assets_insert ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'company-assets');
CREATE POLICY company_assets_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'company-assets') WITH CHECK (bucket_id = 'company-assets');
CREATE POLICY company_assets_delete ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'company-assets');

UPDATE storage.buckets SET file_size_limit = 26214400
WHERE id IN ('lead-photos', 'lead-docs');

UPDATE storage.buckets
SET file_size_limit = 5242880,
    allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']
WHERE id = 'company-assets';
