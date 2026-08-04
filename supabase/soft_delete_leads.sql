-- Summit Roofing OS — Launch setup chunk 1
-- Soft-delete for leads (Trash matches cloud)
--
-- HOW TO RUN (Joe):
-- 1. Open https://supabase.com/dashboard → your Summit project
-- 2. Left sidebar → SQL Editor → New query
-- 3. Paste this entire file → click Run
-- 4. You should see "Success" (no error)
-- 5. Tell Cursor: "SQL done"
--
-- Safe to run more than once (IF NOT EXISTS).

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL;

COMMENT ON COLUMN public.leads.deleted_at IS
  'When set, lead is in Trash (soft-deleted). NULL = active. Permanent delete removes the row.';

CREATE INDEX IF NOT EXISTS leads_deleted_at_idx
  ON public.leads (deleted_at);

-- Optional check: should return column deleted_at
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'deleted_at';
