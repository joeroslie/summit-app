-- =============================================================================
-- Summit: cost sheet cleanup + rename (Table Editor clarity)
-- =============================================================================
-- HOW TO RUN (Joe):
-- 1. Supabase Dashboard → SQL Editor → New query
-- 2. Paste this entire file → Run
-- 3. Read the NOTICE / verify SELECT results at the bottom
-- 4. Tell Cursor: "SQL done"
--
-- End state (editable / clear names):
--   price_sheet              — customer SELLS (untouched)
--   cost_sheet_labor         — labor costs only
--   cost_sheet_material      — material costs only
--   mitigation_price_sheet   — unchanged
--   mitigation_cost_sheet    — unchanged
--
-- Removed / archived:
--   VIEW cost_sheet          — DROPPED (app no longer uses it)
--   labor_cost_sheet         — renamed → cost_sheet_labor
--   material_cost_sheet      — renamed → cost_sheet_material
--   cost_sheet_legacy        — DROPPED if data already in labor+material;
--                              else renamed → _archive_cost_sheet_legacy
--
-- Safe to re-run (idempotent). Does NOT touch mitigation_* or price_sheet.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Helpers: rename or merge-into when both old + new names exist
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pg_temp.summit_rename_or_merge_cost_table(
  p_old text,
  p_new text,
  p_comment text
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  old_exists boolean;
  new_exists boolean;
  old_is_view boolean;
  new_is_view boolean;
  migrated int;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = p_old
  ) INTO old_exists;

  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = p_new
  ) INTO new_exists;

  IF NOT old_exists AND NOT new_exists THEN
    RAISE NOTICE '%: neither "%" nor "%" exists — creating empty "%"',
      'cost sheets', p_old, p_new, p_new;
    EXECUTE format($sql$
      CREATE TABLE public.%I (
        id            bigserial PRIMARY KEY,
        item_key      text NOT NULL,
        label         text,
        unit          text,
        cost          numeric(12,2) NOT NULL,
        region        text NOT NULL DEFAULT 'all',
        active        boolean NOT NULL DEFAULT true,
        notes         text,
        sort_order    integer NOT NULL DEFAULT 100,
        updated_at    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT %I UNIQUE (item_key, region)
      )
    $sql$, p_new, p_new || '_item_region_uniq');
    EXECUTE format('COMMENT ON TABLE public.%I IS %L', p_new, p_comment);
    RETURN;
  END IF;

  IF old_exists THEN
    SELECT c.relkind = 'v'
    INTO old_is_view
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = p_old;
  END IF;

  IF new_exists THEN
    SELECT c.relkind = 'v'
    INTO new_is_view
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = p_new;
  END IF;

  -- Already at target name only
  IF new_exists AND NOT old_exists THEN
    RAISE NOTICE '% already exists; "%" absent — OK', p_new, p_old;
    EXECUTE format('COMMENT ON TABLE public.%I IS %L', p_new, p_comment);
    RETURN;
  END IF;

  -- Old exists, new does not → simple rename
  IF old_exists AND NOT new_exists THEN
    IF old_is_view THEN
      RAISE EXCEPTION 'Cannot rename VIEW public.% to table % — unexpected', p_old, p_new;
    END IF;
    EXECUTE format('ALTER TABLE public.%I RENAME TO %I', p_old, p_new);
    RAISE NOTICE 'Renamed public.% → public.%', p_old, p_new;
    EXECUTE format('COMMENT ON TABLE public.%I IS %L', p_new, p_comment);
    RETURN;
  END IF;

  -- Both exist: merge old → new, then drop old
  IF old_exists AND new_exists THEN
    IF old_is_view THEN
      EXECUTE format('DROP VIEW public.%I', p_old);
      RAISE NOTICE 'Dropped leftover VIEW public.%', p_old;
      EXECUTE format('COMMENT ON TABLE public.%I IS %L', p_new, p_comment);
      RETURN;
    END IF;
    IF new_is_view THEN
      RAISE EXCEPTION 'Target public.% is a VIEW — fix manually before re-run', p_new;
    END IF;

    EXECUTE format($sql$
      INSERT INTO public.%I (item_key, label, unit, cost, region, active, notes, sort_order)
      SELECT
        o.item_key,
        COALESCE(o.label, o.item_key),
        NULLIF(o.unit, ''),
        o.cost::numeric(12,2),
        lower(coalesce(nullif(trim(o.region::text), ''), 'all')),
        coalesce(o.active, true),
        o.notes,
        coalesce(o.sort_order, 100)
      FROM public.%I o
      WHERE o.item_key IS NOT NULL
        AND o.cost IS NOT NULL
      ON CONFLICT (item_key, region) DO UPDATE
        SET cost = EXCLUDED.cost,
            label = COALESCE(EXCLUDED.label, public.%I.label),
            unit = COALESCE(EXCLUDED.unit, public.%I.unit),
            active = EXCLUDED.active,
            notes = COALESCE(EXCLUDED.notes, public.%I.notes),
            updated_at = now()
    $sql$, p_new, p_old, p_new, p_new, p_new);

    GET DIAGNOSTICS migrated = ROW_COUNT;
    RAISE NOTICE 'Merged % rows from public.% into public.%', migrated, p_old, p_new;

    EXECUTE format('DROP TABLE public.%I', p_old);
    RAISE NOTICE 'Dropped public.% after merge', p_old;
    EXECUTE format('COMMENT ON TABLE public.%I IS %L', p_new, p_comment);
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1) Drop confusing VIEW named cost_sheet FIRST (so renames never fight the view)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_views
    WHERE schemaname = 'public' AND viewname = 'cost_sheet'
  ) THEN
    DROP VIEW public.cost_sheet;
    RAISE NOTICE 'Dropped VIEW public.cost_sheet';
  ELSIF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'cost_sheet' AND c.relkind = 'r'
  ) THEN
    -- Still a TABLE (pre-split). Migrate later, then archive.
    RAISE NOTICE 'public.cost_sheet is still a TABLE (not a view) — will archive after migrate';
  ELSE
    RAISE NOTICE 'public.cost_sheet already gone — OK';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Rename labor / material tables to sort-together names
-- ---------------------------------------------------------------------------

SELECT pg_temp.summit_rename_or_merge_cost_table(
  'labor_cost_sheet',
  'cost_sheet_labor',
  'Cost sheet — LABOR only (crew $/sq, steep base, fascia, HVAC labor, etc.). Edit here. Feeds Internal labor. Not used by Material Orders.'
);

SELECT pg_temp.summit_rename_or_merge_cost_table(
  'material_cost_sheet',
  'cost_sheet_material',
  'Cost sheet — MATERIAL only (SRS / Miller book costs). Edit here. Feeds Orders + Internal material.'
);

-- Extra columns that may exist from the original split (keep if present)
DO $$
BEGIN
  IF to_regclass('public.cost_sheet_labor') IS NOT NULL THEN
    ALTER TABLE public.cost_sheet_labor ADD COLUMN IF NOT EXISTS crew text;
  END IF;
  IF to_regclass('public.cost_sheet_material') IS NOT NULL THEN
    ALTER TABLE public.cost_sheet_material ADD COLUMN IF NOT EXISTS supplier text;
  END IF;
END $$;

-- Indexes (new names)
CREATE INDEX IF NOT EXISTS cost_sheet_labor_active_idx
  ON public.cost_sheet_labor (active, region, item_key);

CREATE INDEX IF NOT EXISTS cost_sheet_material_active_idx
  ON public.cost_sheet_material (active, region, item_key);

-- Rename leftover indexes from old names if present
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'labor_cost_sheet_active_idx') THEN
    ALTER INDEX IF EXISTS public.labor_cost_sheet_active_idx
      RENAME TO cost_sheet_labor_active_idx_old;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'material_cost_sheet_active_idx') THEN
    ALTER INDEX IF EXISTS public.material_cost_sheet_active_idx
      RENAME TO cost_sheet_material_active_idx_old;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Index rename skipped: %', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- 3) If leftover TABLE cost_sheet still exists, migrate then archive
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  is_table boolean;
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
    WHERE n.nspname = 'public' AND c.relname = 'cost_sheet' AND c.relkind = 'r'
  ) INTO is_table;

  IF NOT is_table THEN
    RETURN;
  END IF;

  -- Labor
  BEGIN
    INSERT INTO public.cost_sheet_labor (item_key, label, unit, cost, region, active, notes, sort_order)
    SELECT
      c.item_key,
      COALESCE(c.label, c.item_key),
      NULLIF(c.unit, ''),
      c.cost::numeric(12,2),
      lower(coalesce(nullif(trim(c.region::text), ''), 'all')),
      coalesce(c.active, true),
      c.notes,
      coalesce(c.sort_order, 100)
    FROM public.cost_sheet c
    WHERE c.item_key IS NOT NULL AND c.cost IS NOT NULL
      AND (
        lower(c.item_key) = ANY (SELECT lower(k) FROM unnest(labor_keys) AS k)
        OR lower(c.item_key) LIKE '%labor%'
        OR lower(c.item_key) LIKE 'steep%'
      )
    ON CONFLICT (item_key, region) DO UPDATE
      SET cost = EXCLUDED.cost,
          active = EXCLUDED.active,
          updated_at = now();
  EXCEPTION WHEN undefined_column THEN
    INSERT INTO public.cost_sheet_labor (item_key, cost, region, active)
    SELECT
      c.item_key,
      c.cost::numeric(12,2),
      lower(coalesce(nullif(trim(c.region::text), ''), 'all')),
      coalesce(c.active, true)
    FROM public.cost_sheet c
    WHERE c.item_key IS NOT NULL AND c.cost IS NOT NULL
      AND (
        lower(c.item_key) = ANY (SELECT lower(k) FROM unnest(labor_keys) AS k)
        OR lower(c.item_key) LIKE '%labor%'
        OR lower(c.item_key) LIKE 'steep%'
      )
    ON CONFLICT (item_key, region) DO UPDATE
      SET cost = EXCLUDED.cost, active = EXCLUDED.active, updated_at = now();
  END;

  -- Material (everything not labor)
  BEGIN
    INSERT INTO public.cost_sheet_material (item_key, label, unit, cost, region, active, notes, sort_order)
    SELECT
      c.item_key,
      COALESCE(c.label, c.item_key),
      NULLIF(c.unit, ''),
      c.cost::numeric(12,2),
      lower(coalesce(nullif(trim(c.region::text), ''), 'all')),
      coalesce(c.active, true),
      c.notes,
      coalesce(c.sort_order, 100)
    FROM public.cost_sheet c
    WHERE c.item_key IS NOT NULL AND c.cost IS NOT NULL
      AND NOT (
        lower(c.item_key) = ANY (SELECT lower(k) FROM unnest(labor_keys) AS k)
        OR lower(c.item_key) LIKE '%labor%'
        OR lower(c.item_key) LIKE 'steep%'
      )
    ON CONFLICT (item_key, region) DO UPDATE
      SET cost = EXCLUDED.cost,
          active = EXCLUDED.active,
          updated_at = now();
  EXCEPTION WHEN undefined_column THEN
    INSERT INTO public.cost_sheet_material (item_key, cost, region, active)
    SELECT
      c.item_key,
      c.cost::numeric(12,2),
      lower(coalesce(nullif(trim(c.region::text), ''), 'all')),
      coalesce(c.active, true)
    FROM public.cost_sheet c
    WHERE c.item_key IS NOT NULL AND c.cost IS NOT NULL
      AND NOT (
        lower(c.item_key) = ANY (SELECT lower(k) FROM unnest(labor_keys) AS k)
        OR lower(c.item_key) LIKE '%labor%'
        OR lower(c.item_key) LIKE 'steep%'
      )
    ON CONFLICT (item_key, region) DO UPDATE
      SET cost = EXCLUDED.cost, active = EXCLUDED.active, updated_at = now();
  END;

  -- Rename leftover table so it is not a confusing peer of cost_sheet_*
  IF to_regclass('public._archive_cost_sheet_legacy') IS NULL THEN
    ALTER TABLE public.cost_sheet RENAME TO _archive_cost_sheet_legacy;
    COMMENT ON TABLE public._archive_cost_sheet_legacy IS
      'DO NOT EDIT — backup only. Migrated into cost_sheet_labor + cost_sheet_material. Safe to DROP after you verify counts.';
    RAISE NOTICE 'Renamed leftover TABLE cost_sheet → _archive_cost_sheet_legacy';
  ELSE
    RAISE NOTICE 'cost_sheet table still present but _archive already exists — leaving cost_sheet for manual review';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4) cost_sheet_legacy → DROP if migrated, else archive
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  legacy_count bigint := 0;
  labor_count bigint := 0;
  material_count bigint := 0;
  missing bigint := 0;
  legacy_name text := NULL;
BEGIN
  IF to_regclass('public.cost_sheet_legacy') IS NOT NULL THEN
    legacy_name := 'cost_sheet_legacy';
  ELSIF to_regclass('public._archive_cost_sheet_legacy') IS NOT NULL THEN
    legacy_name := '_archive_cost_sheet_legacy';
  END IF;

  IF legacy_name IS NULL THEN
    RAISE NOTICE 'No cost_sheet_legacy / _archive_cost_sheet_legacy — OK';
    RETURN;
  END IF;

  EXECUTE format('SELECT count(*) FROM public.%I', legacy_name) INTO legacy_count;
  SELECT count(*) INTO labor_count FROM public.cost_sheet_labor;
  SELECT count(*) INTO material_count FROM public.cost_sheet_material;

  -- Count legacy keys not present in either split table (same item_key + region)
  EXECUTE format($sql$
    SELECT count(*) FROM public.%I l
    WHERE l.item_key IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.cost_sheet_labor a
        WHERE lower(a.item_key) = lower(l.item_key)
          AND lower(coalesce(nullif(trim(a.region), ''), 'all'))
            = lower(coalesce(nullif(trim(l.region::text), ''), 'all'))
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.cost_sheet_material m
        WHERE lower(m.item_key) = lower(l.item_key)
          AND lower(coalesce(nullif(trim(m.region), ''), 'all'))
            = lower(coalesce(nullif(trim(l.region::text), ''), 'all'))
      )
  $sql$, legacy_name) INTO missing;

  RAISE NOTICE 'Legacy %: % rows · labor % · material % · missing-from-split %',
    legacy_name, legacy_count, labor_count, material_count, missing;

  IF missing = 0 AND (labor_count + material_count) > 0 THEN
    EXECUTE format('DROP TABLE public.%I', legacy_name);
    RAISE NOTICE 'Dropped % (fully migrated into cost_sheet_labor + cost_sheet_material)', legacy_name;
  ELSE
    IF legacy_name = 'cost_sheet_legacy'
       AND to_regclass('public._archive_cost_sheet_legacy') IS NULL
    THEN
      ALTER TABLE public.cost_sheet_legacy RENAME TO _archive_cost_sheet_legacy;
      COMMENT ON TABLE public._archive_cost_sheet_legacy IS
        'DO NOT EDIT — backup only. Some rows may not be in cost_sheet_labor/material yet. Review then DROP.';
      RAISE NOTICE 'Renamed cost_sheet_legacy → _archive_cost_sheet_legacy (missing rows: %)', missing;
    ELSE
      EXECUTE format(
        'COMMENT ON TABLE public.%I IS %L',
        legacy_name,
        'DO NOT EDIT — backup only. Review missing rows, then DROP when ready.'
      );
      RAISE NOTICE 'Kept % as archive (missing rows: %)', legacy_name, missing;
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5) Seed locked labor defaults if missing (book 2026)
-- ---------------------------------------------------------------------------

INSERT INTO public.cost_sheet_labor (item_key, label, unit, cost, region, notes, sort_order)
VALUES
  ('base_shingle', 'Base shingle labor (Maldonado default)', '/sq', 100.00, 'central',  'Package labor — PHX/Central', 10),
  ('base_shingle', 'Base shingle labor (Maldonado default)', '/sq', 110.00, 'southern', 'Package labor — TUC/Southern', 10),
  ('base_shingle', 'Base shingle labor (Maldonado default)', '/sq', 110.00, 'northern', 'Package labor — Northern AZ', 10),
  ('steep_8_9',    'Steep labor 8/12–9/12 (replaces base)', '/sq', 125.00, 'all', 'Cover only — sell +$25', 20),
  ('steep_10_11',  'Steep labor 10/12–11/12 (replaces base)', '/sq', 175.00, 'all', 'Cover only — sell +$75', 21),
  ('steep_9_11',   'Steep labor 10/12–11/12 (alias)', '/sq', 175.00, 'all', 'Alias of steep_10_11', 21),
  ('steep_12',     'Steep labor 12/12 (replaces base)', '/sq', 250.00, 'all', 'Cover only — sell +$150', 22),
  ('steep_11_12',  'Steep labor 12/12 (alias)', '/sq', 250.00, 'all', 'Alias of steep_12', 22),
  ('double_layer', 'Additional layer labor', '/sq', 20.00, 'all', 'Adder', 30),
  ('cut_in_vent',  'Cut-in vent / turbine labor', '/ea', 20.00, 'all', 'Not ridge vent LF', 40),
  ('fascia_labor', 'Fascia labor', '/LF', 4.00, 'all', 'Joe lock', 50),
  ('shingle_mold_labor', 'Shingle mold labor', '/LF', 4.00, 'all', 'Joe lock', 51),
  ('decking_labor','Decking labor (after free sheets)', '/sheet', 20.00, 'all', 'Crown Royal / typical', 60),
  ('hvac_labor',   'HVAC disconnect & reconnect labor', '/ea', 900.00, 'all', 'Internal ~$900; sell on price_sheet', 70),
  ('hvac_dr',      'HVAC D&R labor (alias)', '/ea', 900.00, 'all', 'Alias of hvac_labor', 71)
ON CONFLICT (item_key, region) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6) RLS + grants (anon + authenticated — matches Summit single-tenant client)
-- ---------------------------------------------------------------------------

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
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'cost_sheet_labor_id_seq'
  ) THEN
    GRANT USAGE, SELECT ON SEQUENCE public.cost_sheet_labor_id_seq TO anon, authenticated;
  END IF;
  -- Sequence may still be named from old table
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'labor_cost_sheet_id_seq'
  ) THEN
    ALTER SEQUENCE public.labor_cost_sheet_id_seq RENAME TO cost_sheet_labor_id_seq;
    GRANT USAGE, SELECT ON SEQUENCE public.cost_sheet_labor_id_seq TO anon, authenticated;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Labor sequence grant/rename: %', SQLERRM;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'cost_sheet_material_id_seq'
  ) THEN
    GRANT USAGE, SELECT ON SEQUENCE public.cost_sheet_material_id_seq TO anon, authenticated;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'material_cost_sheet_id_seq'
  ) THEN
    ALTER SEQUENCE public.material_cost_sheet_id_seq RENAME TO cost_sheet_material_id_seq;
    GRANT USAGE, SELECT ON SEQUENCE public.cost_sheet_material_id_seq TO anon, authenticated;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Material sequence grant/rename: %', SQLERRM;
END $$;

-- Re-assert comments (Table Editor tooltip / docs)
COMMENT ON TABLE public.cost_sheet_labor IS
  'Cost sheet — LABOR only. Edit crew/labor rates here. Feeds Internal labor.';
COMMENT ON TABLE public.cost_sheet_material IS
  'Cost sheet — MATERIAL only. Edit SRS/Miller book costs here. Feeds Orders + Internal material.';

COMMIT;

-- =============================================================================
-- VERIFY (run these; expect clean names only)
-- =============================================================================

-- What pricing-related objects remain?
SELECT c.relkind AS kind, c.relname AS name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND (
    c.relname LIKE '%cost_sheet%'
    OR c.relname IN ('price_sheet', 'mitigation_price_sheet', 'mitigation_cost_sheet')
  )
ORDER BY c.relname;

-- Row counts
SELECT 'cost_sheet_labor' AS sheet, count(*) AS rows FROM public.cost_sheet_labor
UNION ALL
SELECT 'cost_sheet_material', count(*) FROM public.cost_sheet_material;

-- Spot-check labor
SELECT item_key, region, cost, unit
FROM public.cost_sheet_labor
WHERE item_key IN ('base_shingle', 'hvac_labor', 'steep_8_9', 'fascia_labor')
ORDER BY item_key, region;

-- Spot-check materials
SELECT item_key, region, cost, unit
FROM public.cost_sheet_material
WHERE item_key IN ('cambridge', 'dynasty', 'osb', 'mb_cap_sheet', 'ridge_vent')
ORDER BY item_key, region
LIMIT 20;
