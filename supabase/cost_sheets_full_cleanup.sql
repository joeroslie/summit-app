-- =============================================================================
-- Summit FULL cost-sheet cleanup (ONE PASTE)
-- =============================================================================
-- HOW TO RUN:
--   Supabase → SQL Editor → New query → paste ALL → Run
--
-- END STATE (only these cost-related tables you edit):
--   price_sheet              — customer SELLS (untouched)
--   cost_sheet_labor         — labor costs
--   cost_sheet_material      — material costs
--   mitigation_price_sheet   — untouched
--   mitigation_cost_sheet    — untouched
--
-- REMOVED (merged first, then dropped):
--   cost_sheet (view or table)
--   cost_sheet_legacy
--   labor_cost_sheet
--   material_cost_sheet
--   _archive_cost_sheet_legacy (dropped if empty / fully migrated)
--
-- Also sets the 4 former "?" units on materials.
-- Safe to re-run.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0) Target tables (create if missing)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.cost_sheet_labor (
  id            bigserial PRIMARY KEY,
  item_key      text NOT NULL,
  label         text,
  unit          text,
  cost          numeric(12,2) NOT NULL,
  region        text NOT NULL DEFAULT 'all',
  crew          text,
  active        boolean NOT NULL DEFAULT true,
  notes         text,
  sort_order    integer NOT NULL DEFAULT 100,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cost_sheet_labor_item_region_uniq UNIQUE (item_key, region)
);

CREATE TABLE IF NOT EXISTS public.cost_sheet_material (
  id            bigserial PRIMARY KEY,
  item_key      text NOT NULL,
  label         text,
  unit          text,
  cost          numeric(12,2) NOT NULL,
  region        text NOT NULL DEFAULT 'all',
  supplier      text,
  active        boolean NOT NULL DEFAULT true,
  notes         text,
  sort_order    integer NOT NULL DEFAULT 100,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cost_sheet_material_item_region_uniq UNIQUE (item_key, region)
);

ALTER TABLE public.cost_sheet_labor ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE public.cost_sheet_labor ADD COLUMN IF NOT EXISTS unit text;
ALTER TABLE public.cost_sheet_labor ADD COLUMN IF NOT EXISTS crew text;
ALTER TABLE public.cost_sheet_labor ADD COLUMN IF NOT EXISTS active boolean DEFAULT true;
ALTER TABLE public.cost_sheet_labor ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.cost_sheet_labor ADD COLUMN IF NOT EXISTS sort_order integer DEFAULT 100;
ALTER TABLE public.cost_sheet_labor ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

ALTER TABLE public.cost_sheet_material ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE public.cost_sheet_material ADD COLUMN IF NOT EXISTS unit text;
ALTER TABLE public.cost_sheet_material ADD COLUMN IF NOT EXISTS supplier text;
ALTER TABLE public.cost_sheet_material ADD COLUMN IF NOT EXISTS active boolean DEFAULT true;
ALTER TABLE public.cost_sheet_material ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.cost_sheet_material ADD COLUMN IF NOT EXISTS sort_order integer DEFAULT 100;
ALTER TABLE public.cost_sheet_material ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

COMMENT ON TABLE public.cost_sheet_labor IS
  'Cost sheet — LABOR only. Edit crew/labor rates here.';
COMMENT ON TABLE public.cost_sheet_material IS
  'Cost sheet — MATERIAL only. Edit SRS/Miller book costs here.';

-- ---------------------------------------------------------------------------
-- 1) Drop confusing VIEW named cost_sheet (app uses split tables now)
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS public.cost_sheet CASCADE;

-- ---------------------------------------------------------------------------
-- 2) Helper: merge any source table into labor + material, then drop source
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pg_temp.summit_merge_cost_source(p_src text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  is_rel boolean;
  is_view boolean;
  labor_keys text[] := ARRAY[
    'base_shingle','base_labor','shingle_labor','labor_base',
    'steep','steep_8_9','steep_8','steep_9','steep_10_11','steep_9_11',
    'steep_10','steep_11','steep_12','steep_11_12','steep_12_plus',
    'double_layer','additional_layer','layers','remove_layer',
    'cut_in','cut_in_vent','cutin','turbine_labor',
    'fascia_labor','fascia_mold_labor','mold_labor','shingle_mold_labor',
    'decking_labor','plywood_labor','osb_labor','cdx_labor',
    'hvac_dr','hvac_labor','hvac_disconnect',
    'skylight_labor','ridge_vent_labor','flashing_labor',
    'tile_labor','mb_labor','foam_labor','coating_labor'
  ];
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = p_src
  ) INTO is_rel;

  IF NOT is_rel THEN
    RETURN;
  END IF;

  -- Never merge the target tables into themselves
  IF p_src IN ('cost_sheet_labor', 'cost_sheet_material') THEN
    RETURN;
  END IF;

  SELECT c.relkind = 'v'
  INTO is_view
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = p_src;

  IF is_view THEN
    EXECUTE format('DROP VIEW public.%I CASCADE', p_src);
    RAISE NOTICE 'Dropped VIEW public.%', p_src;
    RETURN;
  END IF;

  -- Labor rows
  BEGIN
    EXECUTE format($sql$
      INSERT INTO public.cost_sheet_labor (item_key, label, unit, cost, region, active, notes, sort_order)
      SELECT
        c.item_key,
        COALESCE(c.label, c.item_key),
        NULLIF(c.unit::text, ''),
        c.cost::numeric(12,2),
        lower(coalesce(nullif(trim(c.region::text), ''), 'all')),
        coalesce(c.active, true),
        c.notes,
        coalesce(c.sort_order, 100)
      FROM public.%I c
      WHERE c.item_key IS NOT NULL
        AND c.cost IS NOT NULL
        AND (
          lower(c.item_key) = ANY (SELECT lower(k) FROM unnest($1) AS k)
          OR lower(c.item_key) LIKE '%%labor%%'
          OR lower(c.item_key) LIKE 'steep%%'
        )
      ON CONFLICT (item_key, region) DO UPDATE
        SET cost = EXCLUDED.cost,
            unit = COALESCE(EXCLUDED.unit, public.cost_sheet_labor.unit),
            label = COALESCE(EXCLUDED.label, public.cost_sheet_labor.label),
            active = EXCLUDED.active,
            updated_at = now()
    $sql$, p_src)
    USING labor_keys;
  EXCEPTION WHEN undefined_column THEN
    EXECUTE format($sql$
      INSERT INTO public.cost_sheet_labor (item_key, cost, region, active)
      SELECT
        c.item_key,
        c.cost::numeric(12,2),
        lower(coalesce(nullif(trim(c.region::text), ''), 'all')),
        coalesce(c.active, true)
      FROM public.%I c
      WHERE c.item_key IS NOT NULL
        AND c.cost IS NOT NULL
        AND (
          lower(c.item_key) = ANY (SELECT lower(k) FROM unnest($1) AS k)
          OR lower(c.item_key) LIKE '%%labor%%'
          OR lower(c.item_key) LIKE 'steep%%'
        )
      ON CONFLICT (item_key, region) DO UPDATE
        SET cost = EXCLUDED.cost, active = EXCLUDED.active, updated_at = now()
    $sql$, p_src)
    USING labor_keys;
  END;

  -- Material rows (everything not labor)
  BEGIN
    EXECUTE format($sql$
      INSERT INTO public.cost_sheet_material (item_key, label, unit, cost, region, active, notes, sort_order)
      SELECT
        c.item_key,
        COALESCE(c.label, c.item_key),
        NULLIF(c.unit::text, ''),
        c.cost::numeric(12,2),
        lower(coalesce(nullif(trim(c.region::text), ''), 'all')),
        coalesce(c.active, true),
        c.notes,
        coalesce(c.sort_order, 100)
      FROM public.%I c
      WHERE c.item_key IS NOT NULL
        AND c.cost IS NOT NULL
        AND NOT (
          lower(c.item_key) = ANY (SELECT lower(k) FROM unnest($1) AS k)
          OR lower(c.item_key) LIKE '%%labor%%'
          OR lower(c.item_key) LIKE 'steep%%'
        )
      ON CONFLICT (item_key, region) DO UPDATE
        SET cost = EXCLUDED.cost,
            unit = COALESCE(EXCLUDED.unit, public.cost_sheet_material.unit),
            label = COALESCE(EXCLUDED.label, public.cost_sheet_material.label),
            active = EXCLUDED.active,
            updated_at = now()
    $sql$, p_src)
    USING labor_keys;
  EXCEPTION WHEN undefined_column THEN
    EXECUTE format($sql$
      INSERT INTO public.cost_sheet_material (item_key, cost, region, active)
      SELECT
        c.item_key,
        c.cost::numeric(12,2),
        lower(coalesce(nullif(trim(c.region::text), ''), 'all')),
        coalesce(c.active, true)
      FROM public.%I c
      WHERE c.item_key IS NOT NULL
        AND c.cost IS NOT NULL
        AND NOT (
          lower(c.item_key) = ANY (SELECT lower(k) FROM unnest($1) AS k)
          OR lower(c.item_key) LIKE '%%labor%%'
          OR lower(c.item_key) LIKE 'steep%%'
        )
      ON CONFLICT (item_key, region) DO UPDATE
        SET cost = EXCLUDED.cost, active = EXCLUDED.active, updated_at = now()
    $sql$, p_src)
    USING labor_keys;
  END;

  EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', p_src);
  RAISE NOTICE 'Merged + dropped public.%', p_src;
END;
$$;

-- Special case: labor_cost_sheet → all rows are labor (don't reclassify)
DO $$
BEGIN
  IF to_regclass('public.labor_cost_sheet') IS NOT NULL THEN
    BEGIN
      INSERT INTO public.cost_sheet_labor (item_key, label, unit, cost, region, active, notes, sort_order)
      SELECT
        c.item_key,
        COALESCE(c.label, c.item_key),
        NULLIF(c.unit::text, ''),
        c.cost::numeric(12,2),
        lower(coalesce(nullif(trim(c.region::text), ''), 'all')),
        coalesce(c.active, true),
        c.notes,
        coalesce(c.sort_order, 100)
      FROM public.labor_cost_sheet c
      WHERE c.item_key IS NOT NULL AND c.cost IS NOT NULL
      ON CONFLICT (item_key, region) DO UPDATE
        SET cost = EXCLUDED.cost,
            unit = COALESCE(EXCLUDED.unit, public.cost_sheet_labor.unit),
            label = COALESCE(EXCLUDED.label, public.cost_sheet_labor.label),
            active = EXCLUDED.active,
            updated_at = now();
    EXCEPTION WHEN undefined_column THEN
      INSERT INTO public.cost_sheet_labor (item_key, cost, region, active)
      SELECT
        c.item_key,
        c.cost::numeric(12,2),
        lower(coalesce(nullif(trim(c.region::text), ''), 'all')),
        coalesce(c.active, true)
      FROM public.labor_cost_sheet c
      WHERE c.item_key IS NOT NULL AND c.cost IS NOT NULL
      ON CONFLICT (item_key, region) DO UPDATE
        SET cost = EXCLUDED.cost, active = EXCLUDED.active, updated_at = now();
    END;
    DROP TABLE public.labor_cost_sheet CASCADE;
    RAISE NOTICE 'Merged + dropped labor_cost_sheet → cost_sheet_labor';
  END IF;
END $$;

-- Special case: material_cost_sheet → all rows are material
DO $$
BEGIN
  IF to_regclass('public.material_cost_sheet') IS NOT NULL THEN
    BEGIN
      INSERT INTO public.cost_sheet_material (item_key, label, unit, cost, region, active, notes, sort_order)
      SELECT
        c.item_key,
        COALESCE(c.label, c.item_key),
        NULLIF(c.unit::text, ''),
        c.cost::numeric(12,2),
        lower(coalesce(nullif(trim(c.region::text), ''), 'all')),
        coalesce(c.active, true),
        c.notes,
        coalesce(c.sort_order, 100)
      FROM public.material_cost_sheet c
      WHERE c.item_key IS NOT NULL AND c.cost IS NOT NULL
      ON CONFLICT (item_key, region) DO UPDATE
        SET cost = EXCLUDED.cost,
            unit = COALESCE(EXCLUDED.unit, public.cost_sheet_material.unit),
            label = COALESCE(EXCLUDED.label, public.cost_sheet_material.label),
            active = EXCLUDED.active,
            updated_at = now();
    EXCEPTION WHEN undefined_column THEN
      INSERT INTO public.cost_sheet_material (item_key, cost, region, active)
      SELECT
        c.item_key,
        c.cost::numeric(12,2),
        lower(coalesce(nullif(trim(c.region::text), ''), 'all')),
        coalesce(c.active, true)
      FROM public.material_cost_sheet c
      WHERE c.item_key IS NOT NULL AND c.cost IS NOT NULL
      ON CONFLICT (item_key, region) DO UPDATE
        SET cost = EXCLUDED.cost, active = EXCLUDED.active, updated_at = now();
    END;
    DROP TABLE public.material_cost_sheet CASCADE;
    RAISE NOTICE 'Merged + dropped material_cost_sheet → cost_sheet_material';
  END IF;
END $$;

-- Mixed/legacy sources: classify then drop
SELECT pg_temp.summit_merge_cost_source('cost_sheet');
SELECT pg_temp.summit_merge_cost_source('cost_sheet_legacy');
SELECT pg_temp.summit_merge_cost_source('_archive_cost_sheet_legacy');

-- ---------------------------------------------------------------------------
-- 3) Seed locked labor defaults (book 2026) if missing
-- ---------------------------------------------------------------------------

INSERT INTO public.cost_sheet_labor (item_key, label, unit, cost, region, notes, sort_order)
VALUES
  ('base_shingle', 'Base shingle labor (Maldonado default)', '/sq', 100.00, 'central', 'Package labor — PHX/Central', 10),
  ('base_shingle', 'Base shingle labor (Maldonado default)', '/sq', 110.00, 'southern', 'Package labor — TUC/Southern', 10),
  ('base_shingle', 'Base shingle labor (Maldonado default)', '/sq', 110.00, 'northern', 'Package labor — Northern AZ', 10),
  ('steep_8_9', 'Steep labor 8/12–9/12 (replaces base)', '/sq', 125.00, 'all', 'Cover only — sell +$25', 20),
  ('steep_10_11', 'Steep labor 10/12–11/12 (replaces base)', '/sq', 175.00, 'all', 'Cover only — sell +$75', 21),
  ('steep_9_11', 'Steep labor 10/12–11/12 (alias)', '/sq', 175.00, 'all', 'Alias of steep_10_11', 21),
  ('steep_12', 'Steep labor 12/12 (replaces base)', '/sq', 250.00, 'all', 'Cover only — sell +$150', 22),
  ('steep_11_12', 'Steep labor 12/12 (alias)', '/sq', 250.00, 'all', 'Alias of steep_12', 22),
  ('double_layer', 'Additional layer labor', '/sq', 20.00, 'all', 'Adder', 30),
  ('cut_in_vent', 'Cut-in vent / turbine labor', '/ea', 20.00, 'all', 'Not ridge vent LF', 40),
  ('fascia_labor', 'Fascia labor', '/LF', 4.00, 'all', 'Joe lock', 50),
  ('shingle_mold_labor', 'Shingle mold labor', '/LF', 4.00, 'all', 'Joe lock', 51),
  ('decking_labor', 'Decking labor (after free sheets)', '/sheet', 20.00, 'all', 'Crown Royal / typical', 60),
  ('hvac_labor', 'HVAC disconnect & reconnect labor', '/ea', 900.00, 'all', 'Internal ~$900; sell on price_sheet', 70),
  ('hvac_dr', 'HVAC D&R labor (alias)', '/ea', 900.00, 'all', 'Alias of hvac_labor', 71)
ON CONFLICT (item_key, region) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4) Fix the 4 former "?" material units (+ strip any leftover ?)
-- ---------------------------------------------------------------------------

INSERT INTO public.cost_sheet_material (item_key, label, unit, cost, region, active)
VALUES
  ('prowest_synthetic', 'Prowest One Solutions Synthetic (~10 sq)', '/roll', 71.00, 'all', true),
  ('topshield_100ht', 'TopShield 100HT (~10 sq HT)', '/roll', 108.00, 'all', true),
  ('step_flash_4x4x8', '4"×4"×8" Step Flashing', '/box', 54.50, 'all', true),
  ('furring_1x2x4', 'Furring Strips 1"×2"×4''', '/bundle', 13.50, 'all', true)
ON CONFLICT (item_key, region) DO UPDATE
  SET unit = EXCLUDED.unit,
      label = COALESCE(EXCLUDED.label, public.cost_sheet_material.label),
      updated_at = now();

UPDATE public.cost_sheet_material
SET unit = trim(both FROM regexp_replace(unit, '\s*\(\?\)|\?', '', 'g')),
    updated_at = now()
WHERE unit IS NOT NULL AND unit ~ '\?';

UPDATE public.cost_sheet_labor
SET unit = trim(both FROM regexp_replace(unit, '\s*\(\?\)|\?', '', 'g')),
    updated_at = now()
WHERE unit IS NOT NULL AND unit ~ '\?';

-- ---------------------------------------------------------------------------
-- 5) Indexes + RLS
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS cost_sheet_labor_active_idx
  ON public.cost_sheet_labor (active, region, item_key);
CREATE INDEX IF NOT EXISTS cost_sheet_material_active_idx
  ON public.cost_sheet_material (active, region, item_key);

ALTER TABLE public.cost_sheet_labor ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cost_sheet_material ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cost_sheet_labor_select ON public.cost_sheet_labor;
DROP POLICY IF EXISTS labor_cost_sheet_select ON public.cost_sheet_labor;
CREATE POLICY cost_sheet_labor_select ON public.cost_sheet_labor
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS cost_sheet_labor_write ON public.cost_sheet_labor;
DROP POLICY IF EXISTS labor_cost_sheet_write ON public.cost_sheet_labor;
CREATE POLICY cost_sheet_labor_write ON public.cost_sheet_labor
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS cost_sheet_material_select ON public.cost_sheet_material;
DROP POLICY IF EXISTS material_cost_sheet_select ON public.cost_sheet_material;
CREATE POLICY cost_sheet_material_select ON public.cost_sheet_material
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS cost_sheet_material_write ON public.cost_sheet_material;
DROP POLICY IF EXISTS material_cost_sheet_write ON public.cost_sheet_material;
CREATE POLICY cost_sheet_material_write ON public.cost_sheet_material
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.cost_sheet_labor TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cost_sheet_material TO anon, authenticated;

DO $$
BEGIN
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Sequence grants: %', SQLERRM;
END $$;

COMMIT;

-- =============================================================================
-- VERIFY — after Run, you should only see cost_sheet_labor + cost_sheet_material
-- =============================================================================

SELECT c.relkind AS kind, c.relname AS name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND (
    c.relname LIKE '%cost_sheet%'
    OR c.relname IN ('price_sheet', 'mitigation_price_sheet', 'mitigation_cost_sheet')
  )
  AND c.relkind IN ('r', 'v')
ORDER BY c.relname;

SELECT 'cost_sheet_labor' AS sheet, count(*)::int AS rows FROM public.cost_sheet_labor
UNION ALL
SELECT 'cost_sheet_material', count(*)::int FROM public.cost_sheet_material;

SELECT item_key, unit, cost
FROM public.cost_sheet_material
WHERE item_key IN (
  'prowest_synthetic',
  'topshield_100ht',
  'step_flash_4x4x8',
  'furring_1x2x4'
)
ORDER BY item_key;
