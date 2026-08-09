-- =============================================================================
-- Summit: ENABLE RLS on pricing/cost + critical tables (open anon policies)
-- =============================================================================
-- ⚠️ PARTLY SUPERSEDED by harden_rls_step1.sql, which makes the pricing/cost
-- tables read-only to anon. Re-running THIS file will re-open anon writes to
-- pricing and undo that lock. If you re-run it, run harden_rls_step1.sql after.
--
-- HOW TO RUN: Supabase → SQL Editor → paste ALL → Run
--
-- Keeps app working with NEXT_PUBLIC_SUPABASE_ANON_KEY (USING true).
-- Also fixes labor Joe-locks + material units for existing thin material sheet.
-- Safe to re-run.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Labor fixes (Joe lock: fascia/mold $4/LF; units)
-- ---------------------------------------------------------------------------

UPDATE public.cost_sheet_labor
SET cost = 4.00,
    unit = '/LF',
    notes = COALESCE(NULLIF(notes, ''), 'Joe lock — $4/LF'),
    updated_at = now()
WHERE item_key = 'fascia_labor';

UPDATE public.cost_sheet_labor
SET cost = 4.00,
    unit = '/LF',
    notes = COALESCE(NULLIF(notes, ''), 'Joe lock — $4/LF'),
    updated_at = now()
WHERE item_key = 'shingle_mold_labor';

UPDATE public.cost_sheet_labor
SET unit = '/sq', updated_at = now()
WHERE item_key = 'base_shingle' AND (unit IS NULL OR unit = '');

UPDATE public.cost_sheet_labor
SET unit = '/sheet', updated_at = now()
WHERE item_key IN ('decking_labor', 'decking_osb_labor')
  AND (unit IS NULL OR unit = '');

UPDATE public.cost_sheet_labor
SET unit = '/LF', updated_at = now()
WHERE item_key = 'fascia_mold_labor' AND (unit IS NULL OR unit = '');

-- ---------------------------------------------------------------------------
-- 2) Material units for rows that exist (no ? research — fill nulls only)
-- ---------------------------------------------------------------------------

UPDATE public.cost_sheet_material SET unit = '/sq', updated_at = now()
WHERE item_key IN (
  'cambridge','dynasty','armourshake','mb_base_ply','mb_cap_sheet','extra_layer','two_story'
) AND (unit IS NULL OR unit = '');

UPDATE public.cost_sheet_material SET unit = '/LF', updated_at = now()
WHERE item_key IN ('ridge_vent','gutters_dr') AND (unit IS NULL OR unit = '');

-- Seed critical missing material costs from book (ON CONFLICT keep existing cost)
INSERT INTO public.cost_sheet_material (item_key, label, unit, cost, region, supplier, active, sort_order)
VALUES
  ('cambridge', 'IKO Cambridge', '/sq', 89.00, 'all', 'SRS', true, 10),
  ('dynasty', 'IKO Dynasty', '/sq', 94.00, 'all', 'SRS', true, 11),
  ('armourshake', 'IKO Armourshake', '/sq', 230.00, 'all', 'SRS', true, 12),
  ('gaf_hdz', 'GAF Timberline HDZ', '/sq', 130.00, 'all', 'SRS', true, 13),
  ('gaf_natural_shadow', 'GAF Natural Shadow', '/sq', 129.00, 'all', 'SRS', true, 14),
  ('owens_oakridge', 'Owens Corning Oakridge', '/sq', 110.00, 'all', 'SRS', true, 15),
  ('owens_duration', 'Owens Corning Duration', '/sq', 118.00, 'all', 'SRS', true, 16),
  ('owens_duration_designer', 'Owens Corning Duration Designer', '/sq', 118.00, 'all', 'SRS', true, 17),
  ('certainteed_landmark', 'CertainTeed Landmark', '/sq', 117.00, 'all', 'SRS', true, 18),
  ('certainteed_patriot_xl', 'CertainTeed Patriot XL', '/sq', 103.00, 'all', 'SRS', true, 19),
  ('malarkey_highlander', 'Malarkey Highlander', '/sq', 154.00, 'all', 'SRS', true, 20),
  ('malarkey_vista', 'Malarkey Vista', '/sq', 160.00, 'all', 'SRS', true, 21),
  ('osb', 'OSB 4×8 7/16"', '/sheet', 11.00, 'all', 'Miller', true, 30),
  ('cdx', 'CDX 4×8 7/16"', '/sheet', 20.50, 'all', 'Miller', true, 31),
  ('osb_1_2', 'OSB 4×8 1/2"', '/sheet', 11.50, 'all', 'Miller', true, 32),
  ('cdx_1_2', 'CDX 4×8 1/2"', '/sheet', 31.00, 'all', 'Miller', true, 33),
  ('mold_1x2_16', 'Shingle mold 1×2 × 16''', '/pair', 10.50, 'all', 'Miller', true, 40),
  ('mb_cap_sheet', 'TopShield SA Cap Sheet', '/sq', 123.00, 'all', 'SRS', true, 50),
  ('mb_base_ply', 'TopShield SA Base Sheet', '/sq', 126.00, 'all', 'SRS', true, 51),
  ('ridge_vent', 'Ridge vent material', '/LF', 6.00, 'all', 'SRS', true, 60),
  ('eagle_tile', 'Eagle Concrete Tile', '/sq', 116.67, 'all', 'SRS', true, 70),
  ('westlake_tile', 'Westlake Concrete Tile', '/sq', 114.35, 'all', 'SRS', true, 71),
  ('prowest_synthetic', 'Prowest One Solutions Synthetic (~10 sq)', '/roll', 71.00, 'all', 'SRS', true, 80),
  ('topshield_100ht', 'TopShield 100HT (~10 sq HT)', '/roll', 108.00, 'all', 'SRS', true, 81),
  ('step_flash_4x4x8', '4"×4"×8" Step Flashing', '/box', 54.50, 'all', 'SRS', true, 82),
  ('furring_1x2x4', 'Furring Strips 1"×2"×4''', '/bundle', 13.50, 'all', 'SRS', true, 83)
ON CONFLICT (item_key, region) DO UPDATE
  SET unit = COALESCE(EXCLUDED.unit, public.cost_sheet_material.unit),
      label = COALESCE(EXCLUDED.label, public.cost_sheet_material.label),
      supplier = COALESCE(EXCLUDED.supplier, public.cost_sheet_material.supplier),
      updated_at = now();

-- ---------------------------------------------------------------------------
-- 3) ENABLE RLS + open policies (anon + authenticated)
-- ---------------------------------------------------------------------------

-- Helper: enable + open select/write for a table
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'price_sheet',
    'cost_sheet_labor',
    'cost_sheet_material',
    'mitigation_price_sheet',
    'mitigation_cost_sheet',
    'leads',
    'estimates',
    'app_settings'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'skip missing %', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_open', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_write_open', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_write', t);
    IF t = 'cost_sheet_labor' THEN
      EXECUTE 'DROP POLICY IF EXISTS cost_sheet_labor_select ON public.cost_sheet_labor';
      EXECUTE 'DROP POLICY IF EXISTS cost_sheet_labor_write ON public.cost_sheet_labor';
      EXECUTE 'DROP POLICY IF EXISTS labor_cost_sheet_select ON public.cost_sheet_labor';
      EXECUTE 'DROP POLICY IF EXISTS labor_cost_sheet_write ON public.cost_sheet_labor';
    ELSIF t = 'cost_sheet_material' THEN
      EXECUTE 'DROP POLICY IF EXISTS cost_sheet_material_select ON public.cost_sheet_material';
      EXECUTE 'DROP POLICY IF EXISTS cost_sheet_material_write ON public.cost_sheet_material';
      EXECUTE 'DROP POLICY IF EXISTS material_cost_sheet_select ON public.cost_sheet_material';
      EXECUTE 'DROP POLICY IF EXISTS material_cost_sheet_write ON public.cost_sheet_material';
    END IF;

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO anon, authenticated USING (true)',
      t || '_select_open', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)',
      t || '_write_open', t
    );

    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO anon, authenticated',
      t
    );
    RAISE NOTICE 'RLS enabled (open) on %', t;
  END LOOP;
END $$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

COMMIT;

-- =============================================================================
-- VERIFY
-- =============================================================================

SELECT c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'price_sheet','cost_sheet_labor','cost_sheet_material',
    'mitigation_price_sheet','mitigation_cost_sheet',
    'leads','estimates','app_settings'
  )
ORDER BY c.relname;

SELECT item_key, region, cost, unit
FROM public.cost_sheet_labor
WHERE item_key IN ('fascia_labor','shingle_mold_labor','base_shingle')
ORDER BY item_key, region;

SELECT count(*)::int AS material_rows FROM public.cost_sheet_material;
