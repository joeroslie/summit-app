-- Summit Roofing OS — Material orders persistence
--
-- HOW TO RUN (Joe):
-- 1. Open https://supabase.com/dashboard → your Summit project
-- 2. Left sidebar → SQL Editor → New query
-- 3. Paste this entire file → click Run
-- 4. You should see "Success" (no error)
-- 5. Tell Cursor: "SQL done"
--
-- Safe to run more than once (IF NOT EXISTS / ON CONFLICT / DROP POLICY IF EXISTS).

CREATE TABLE IF NOT EXISTS public.material_orders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  order_type text NOT NULL CHECK (order_type IN ('shingle', 'tile', 'low_slope')),
  -- Lead/job this order is tied to. Stored as text (not FK) since it may hold
  -- either a Supabase lead id or be left blank for orders not tied to a lead.
  lead_id text NULL,
  job_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  crew_id text NULL,
  crew_name text NULL,
  line_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_cost numeric(12, 2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'submitted',
  notes text NULL
);

COMMENT ON TABLE public.material_orders IS
  'Submitted material orders from Orders → Material → Labor → Submit order. job_snapshot is the job packet facts (system, pitch, squares, redeck, stories, layers, fascia, HVAC, underlayment, hip&ridge, ridge vent, region, address, job#, client name) at time of submission. line_items is an array of {item_key, label, unit, qty, cost}.';

CREATE INDEX IF NOT EXISTS material_orders_created_at_idx
  ON public.material_orders (created_at DESC);

CREATE INDEX IF NOT EXISTS material_orders_lead_id_idx
  ON public.material_orders (lead_id);

CREATE INDEX IF NOT EXISTS material_orders_order_type_idx
  ON public.material_orders (order_type);

-- Keep updated_at current on any edit.
CREATE OR REPLACE FUNCTION public.set_material_orders_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS material_orders_set_updated_at ON public.material_orders;
CREATE TRIGGER material_orders_set_updated_at
  BEFORE UPDATE ON public.material_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.set_material_orders_updated_at();

-- Anon/authenticated read+write (matches current Summit single-tenant anon client usage).
-- Tighten when Auth is added.
ALTER TABLE public.material_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "material_orders_select_all" ON public.material_orders;
CREATE POLICY "material_orders_select_all"
  ON public.material_orders FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "material_orders_insert_all" ON public.material_orders;
CREATE POLICY "material_orders_insert_all"
  ON public.material_orders FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "material_orders_update_all" ON public.material_orders;
CREATE POLICY "material_orders_update_all"
  ON public.material_orders FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "material_orders_delete_all" ON public.material_orders;
CREATE POLICY "material_orders_delete_all"
  ON public.material_orders FOR DELETE
  TO anon, authenticated
  USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.material_orders TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

-- =============================================================================
-- VERIFY
-- =============================================================================

SELECT c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'material_orders';

SELECT id, created_at, order_type, lead_id, crew_name, total_cost, status
FROM public.material_orders
ORDER BY created_at DESC
LIMIT 10;
