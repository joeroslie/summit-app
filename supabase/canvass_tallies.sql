-- Summit Roofing OS — Canvassing daily tally log (tap-to-count dashboard cards)
--
-- HOW TO RUN (Joe):
-- 1. Open https://supabase.com/dashboard → your Summit project
-- 2. Left sidebar → SQL Editor → New query
-- 3. Paste this entire file → click Run
-- 4. You should see "Success" (no error)
-- 5. Tell Cursor: "SQL done"
--
-- Safe to run more than once (IF NOT EXISTS / DROP POLICY IF EXISTS).

CREATE TABLE IF NOT EXISTS public.canvass_tallies (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One row per tap. Kept as a timestamped event log (not a mutable counter)
  -- so historical days stay correct and daily totals can be recomputed anytime.
  type text NOT NULL CHECK (type IN ('door', 'conversation', 'signed'))
);

COMMENT ON TABLE public.canvass_tallies IS
  'One row per manual tap on a Canvassing daily-dashboard card (Tools → Canvassing). Lets Joe log a knock/conversation/sign in the moment without dropping a pin. Daily totals shown on screen = these rows + activity already derivable from canvass_pins timestamps.';

CREATE INDEX IF NOT EXISTS canvass_tallies_created_at_idx
  ON public.canvass_tallies (created_at DESC);

CREATE INDEX IF NOT EXISTS canvass_tallies_type_idx
  ON public.canvass_tallies (type);

-- Anon/authenticated read+write (matches current Summit single-tenant anon client usage).
-- Tighten when Auth is added.
ALTER TABLE public.canvass_tallies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "canvass_tallies_select_all" ON public.canvass_tallies;
CREATE POLICY "canvass_tallies_select_all"
  ON public.canvass_tallies FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "canvass_tallies_insert_all" ON public.canvass_tallies;
CREATE POLICY "canvass_tallies_insert_all"
  ON public.canvass_tallies FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "canvass_tallies_delete_all" ON public.canvass_tallies;
CREATE POLICY "canvass_tallies_delete_all"
  ON public.canvass_tallies FOR DELETE
  TO anon, authenticated
  USING (true);

GRANT SELECT, INSERT, DELETE ON public.canvass_tallies TO anon, authenticated;
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
  AND c.relname = 'canvass_tallies';

SELECT id, created_at, type
FROM public.canvass_tallies
ORDER BY created_at DESC
LIMIT 10;
