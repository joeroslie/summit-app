-- =============================================================================
-- Drop table-level privileges that bypass RLS (TRUNCATE) and leftover ALL grants.
-- Policies stay the same. No price or row data changes.
-- =============================================================================

REVOKE ALL ON public.companies FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON public.companies TO authenticated;

REVOKE ALL ON public.company_members FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.company_members TO authenticated;

DO $$
DECLARE
  t text;
  ops text[] := ARRAY[
    'leads', 'estimates', 'app_settings',
    'canvass_pins', 'canvass_tallies', 'material_orders'
  ];
  prices text[] := ARRAY[
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
  FOREACH t IN ARRAY ops LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated',
      t
    );
  END LOOP;

  FOREACH t IN ARRAY prices LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon;

-- Storage default grants are owned by supabase_storage_admin. The postgres
-- role cannot revoke those. These statements still drop leftover postgres
-- grants and re-grant DML. RLS already blocks anon DML on objects; buckets
-- stay public so existing photo/doc URLs keep working (signed URLs first
-- if we ever flip private).
REVOKE ALL ON storage.objects FROM PUBLIC, anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON storage.objects FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;

REVOKE ALL ON storage.buckets FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON storage.buckets FROM authenticated;
GRANT SELECT ON storage.buckets TO authenticated;
