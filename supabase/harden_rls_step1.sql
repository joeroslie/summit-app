-- =============================================================================
-- Summit: RLS hardening STEP 1 — lock pricing read-only + document storage
-- =============================================================================
-- HOW TO RUN: Supabase → SQL Editor → paste ALL → Run
-- Safe to re-run. Supersedes the write-open half of enable_rls_pricing_open.sql.
--
-- WHAT THIS FIXES
--   * Pricing + cost tables become READ-ONLY to anon/authenticated. Nobody
--     holding the anon key can rewrite Joe's locked prices. Edits happen here
--     in the SQL editor (postgres role bypasses RLS), which is how they
--     already happen today — no app UI writes to these tables.
--   * lead-photos / lead-docs storage policies get written down in git instead
--     of living only in the Supabase dashboard where nobody can review them.
--   * Bucket size caps so the anon key can't be used to host arbitrary bulk
--     files on the Summit Supabase domain.
--
-- WHAT THIS DOES **NOT** FIX — read before assuming you are covered
--   1. leads / estimates / app_settings / canvass_* / material_orders are
--      STILL fully open to anon read+write. They have to be: the browser does
--      those writes with the anon key and there is no auth to scope them to.
--      Anyone with the anon key can still dump or delete every lead.
--   2. lead-photos and lead-docs are PUBLIC buckets. Every roof photo, signed
--      agreement, invoice, and estimate PDF is fetchable by URL with no key at
--      all, forever. Policies below do NOT change that — public buckets skip
--      RLS on read. See section 5 for the real fix (needs an app change).
--   Both are closed by real auth (Phase C), not by SQL.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 0) DIAGNOSTICS — run first, read the output, then run the rest
-- ---------------------------------------------------------------------------

-- Are the lead buckets public? (public = true means no-key read, forever)
SELECT id, name, public, file_size_limit, allowed_mime_types
FROM storage.buckets
ORDER BY name;

-- What storage policies exist today (dashboard-created ones show up here)
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects'
ORDER BY policyname;

-- Which public tables have RLS off entirely (would be invisible in the audit)
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relrowsecurity, c.relname;


BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Pricing + cost tables → READ-ONLY for anon/authenticated
-- ---------------------------------------------------------------------------
-- Verified against app code: every one of these is SELECT-only from the
-- browser. Company Pricing renders them; nothing writes them.
--   price_sheet             app/page.tsx:8274   select
--   mitigation_price_sheet  app/page.tsx:8417   select
--   mitigation_cost_sheet   app/page.tsx:8469   select
--   cost_sheet_labor        app/page.tsx:8358   select (via tryTable)
--   cost_sheet_material     app/page.tsx:8361   select (via tryTable)
-- Legacy fallback names the app also tries on miss are locked the same way.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'price_sheet',
    'cost_sheet_labor',
    'cost_sheet_material',
    'mitigation_price_sheet',
    'mitigation_cost_sheet',
    -- legacy fallback names read by tryTable() — lock if they still exist
    'labor_cost_sheet',
    'material_cost_sheet',
    'cost_sheet'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'skip missing %', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    -- Drop the FOR ALL write policy from enable_rls_pricing_open.sql
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_write_open', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_write', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_readonly', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_open', t);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO anon, authenticated USING (true)',
      t || '_readonly', t
    );

    -- Revoke at the grant layer too — RLS alone is not the only gate
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE ON public.%I FROM anon, authenticated',
      t
    );
    EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', t);

    RAISE NOTICE 'locked read-only: %', t;
  END LOOP;
END $$;


-- ---------------------------------------------------------------------------
-- 2) Storage: explicit policies for lead-photos / lead-docs
-- ---------------------------------------------------------------------------
-- These buckets were created in the dashboard and had no SQL in the repo.
-- Writing them down so they are reviewable. This is documentation of the
-- current open posture, NOT a tightening — the app uploads and deletes with
-- the anon key, so anon needs insert/delete until auth lands.
--
-- Dashboard-created policies have generated names like "Give anon access
-- 1a2b3c_0", so the DROPs below will not catch them and they will survive as
-- duplicates. They are no more permissive than these, so nothing gets worse —
-- but check the section 0 diagnostics and delete the leftovers by name so the
-- policy list stays readable.

DO $$
DECLARE
  b text;
  buckets text[] := ARRAY['lead-photos', 'lead-docs'];
BEGIN
  FOREACH b IN ARRAY buckets LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', b || '_anon_select');
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', b || '_anon_insert');
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', b || '_anon_update');
    EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', b || '_anon_delete');

    EXECUTE format(
      'CREATE POLICY %I ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = %L)',
      b || '_anon_select', b
    );
    EXECUTE format(
      'CREATE POLICY %I ON storage.objects FOR INSERT TO anon, authenticated WITH CHECK (bucket_id = %L)',
      b || '_anon_insert', b
    );
    EXECUTE format(
      'CREATE POLICY %I ON storage.objects FOR UPDATE TO anon, authenticated USING (bucket_id = %L) WITH CHECK (bucket_id = %L)',
      b || '_anon_update', b, b
    );
    EXECUTE format(
      'CREATE POLICY %I ON storage.objects FOR DELETE TO anon, authenticated USING (bucket_id = %L)',
      b || '_anon_delete', b
    );
  END LOOP;
END $$;


-- ---------------------------------------------------------------------------
-- 3) Bucket size caps — blocks bulk-upload abuse via the anon key
-- ---------------------------------------------------------------------------
-- No MIME allowlist on lead-docs: the app uploads with
-- `file.type || 'application/octet-stream'` (app/page.tsx:14858) and accepts
-- doc/xls/csv, so an allowlist would either reject real uploads or have to
-- include octet-stream, which allows anything. Size cap is the honest control.

UPDATE storage.buckets SET file_size_limit = 26214400  -- 25 MB
WHERE id IN ('lead-photos', 'lead-docs');

-- company-assets only ever receives the company logo, so it can be tight.
UPDATE storage.buckets
SET file_size_limit = 5242880,  -- 5 MB
    allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']
WHERE id = 'company-assets';

COMMIT;


-- ---------------------------------------------------------------------------
-- 4) VERIFY
-- ---------------------------------------------------------------------------

-- Pricing tables should show ONLY a *_readonly SELECT policy
SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'price_sheet','cost_sheet_labor','cost_sheet_material',
    'mitigation_price_sheet','mitigation_cost_sheet'
  )
ORDER BY tablename, policyname;

-- Grants should show ONLY SELECT for anon on pricing tables
SELECT table_name, grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated')
  AND table_name IN (
    'price_sheet','cost_sheet_labor','cost_sheet_material',
    'mitigation_price_sheet','mitigation_cost_sheet'
  )
ORDER BY table_name, grantee, privilege_type;

SELECT id, public, file_size_limit, allowed_mime_types
FROM storage.buckets ORDER BY id;


-- =============================================================================
-- 5) DO NOT RUN YET — private buckets (the real fix for public customer files)
-- =============================================================================
-- Flipping these to private is what actually stops anonymous internet access
-- to signed agreements and roof photos. It WILL break the app as written:
-- app/page.tsx stores the result of getPublicUrl() as the durable URL on the
-- lead record (lines 6180, 6944, 14138, 14455, 14629, 14869, 16476) and
-- renders it directly. Once the bucket is private those saved URLs 404.
--
-- Required app change first:
--   1. Store the storage PATH on the lead record, not the public URL.
--   2. Resolve to a short-lived createSignedUrl() at render/download time.
--   3. Backfill: convert already-saved public URLs to paths (the parsing
--      helper already exists — storagePathFromLeadDocUrl, page.tsx:3740;
--      lead-photos needs the same helper, it only handles /lead-docs/ today).
--   4. Anything emailed/handed to a homeowner needs a deliberate re-share
--      story, since signed URLs expire.
--
-- UPDATE storage.buckets SET public = false
-- WHERE id IN ('lead-photos', 'lead-docs');
-- =============================================================================
