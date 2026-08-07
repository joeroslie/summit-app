-- Summit Roofing OS — Canvassing / door-knocking pin tracker
--
-- HOW TO RUN (Joe):
-- 1. Open https://supabase.com/dashboard → your Summit project
-- 2. Left sidebar → SQL Editor → New query
-- 3. Paste this entire file → click Run
-- 4. You should see "Success" (no error)
-- 5. Tell Cursor: "SQL done"
--
-- Safe to run more than once (IF NOT EXISTS / ON CONFLICT / DROP POLICY IF EXISTS).

CREATE TABLE IF NOT EXISTS public.canvass_pins (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  -- Street address — may come from reverse geocoding on drop or manual entry. Nullable
  -- because a pin dropped on the map is still useful with no address filled in yet.
  address text NULL,
  -- Manual-entry owner name, or the name recovered from a free county-assessor lookup.
  owner_name text NULL,
  -- Raw + normalized property lookup payload (see app/api/property-lookup/route.ts).
  -- Shape: { source, ownerName, yearBuilt, assessedValue, siteAddress, parcelId, fetchedAt, raw }
  property_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  disposition text NOT NULL DEFAULT 'not_contacted'
    CHECK (disposition IN ('not_contacted', 'not_home', 'follow_up', 'not_interested', 'signed')),
  -- Set explicitly by the app whenever `disposition` changes (not on every edit) so the
  -- daily activity dashboard can count "today's" conversations/signs off real status changes.
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  notes text NULL,
  -- Set once "Create lead" is used from the pin detail view. Stored as text (not FK) since
  -- it may hold either a Supabase `leads.id` (uuid) or be left blank — same pattern as
  -- material_orders.lead_id. Lets a pin show it's already been converted without deleting it.
  lead_id text NULL
);

COMMENT ON TABLE public.canvass_pins IS
  'Door-to-door canvassing pins dropped on the map (Tools → Canvassing). A pin is just a marker to remember/track a house — it does NOT auto-create a Lead. property_data holds any free county-assessor lookup result (owner name, year built, assessed value). lead_id is set once a pin is converted via "Create lead".';

CREATE INDEX IF NOT EXISTS canvass_pins_created_at_idx
  ON public.canvass_pins (created_at DESC);

CREATE INDEX IF NOT EXISTS canvass_pins_disposition_idx
  ON public.canvass_pins (disposition);

CREATE INDEX IF NOT EXISTS canvass_pins_status_changed_at_idx
  ON public.canvass_pins (status_changed_at DESC);

CREATE INDEX IF NOT EXISTS canvass_pins_lead_id_idx
  ON public.canvass_pins (lead_id);

-- Keep updated_at current on any edit.
CREATE OR REPLACE FUNCTION public.set_canvass_pins_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS canvass_pins_set_updated_at ON public.canvass_pins;
CREATE TRIGGER canvass_pins_set_updated_at
  BEFORE UPDATE ON public.canvass_pins
  FOR EACH ROW
  EXECUTE FUNCTION public.set_canvass_pins_updated_at();

-- Anon/authenticated read+write (matches current Summit single-tenant anon client usage).
-- Tighten when Auth is added.
ALTER TABLE public.canvass_pins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "canvass_pins_select_all" ON public.canvass_pins;
CREATE POLICY "canvass_pins_select_all"
  ON public.canvass_pins FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "canvass_pins_insert_all" ON public.canvass_pins;
CREATE POLICY "canvass_pins_insert_all"
  ON public.canvass_pins FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "canvass_pins_update_all" ON public.canvass_pins;
CREATE POLICY "canvass_pins_update_all"
  ON public.canvass_pins FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "canvass_pins_delete_all" ON public.canvass_pins;
CREATE POLICY "canvass_pins_delete_all"
  ON public.canvass_pins FOR DELETE
  TO anon, authenticated
  USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.canvass_pins TO anon, authenticated;
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
  AND c.relname = 'canvass_pins';

SELECT id, created_at, lat, lng, address, disposition, lead_id
FROM public.canvass_pins
ORDER BY created_at DESC
LIMIT 10;
