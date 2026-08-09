-- Fix IKO Armourshake sell price — locked 2026-08-06 (Joe confirmed)
-- Paste in Supabase SQL Editor → Run
--
-- Confirmed truth: armourshake all-in package sell = $610 PHX / $635 TUC / $660 NORTH.
-- Live public.price_sheet has 785 for all three regions (stale). Every other price
-- source already matches the locked number — only this DB row is wrong:
--   lib/pricingGuide.ts:31
--   app/page.tsx:7163 (inline fallback)
--   docs/pricing/ProWest_Full_Price_Book_2026.md:13
--
-- Supabase wins over lib/pricingGuide.ts in getSellPrice() (app/page.tsx:6996), so
-- until this row is fixed, live estimates overquote armourshake by
-- +$175/sq PHX, +$150/sq TUC, +$125/sq NORTH.

-- STEP 0 — run this first and read the `region` column before running the UPDATEs
-- below. Confirms which literal style is actually stored ('central'/'southern'/
-- 'northern' vs legacy 'phx'/'tuc'/'north' vs something else entirely).
-- SELECT item_key, price, region, active FROM public.price_sheet WHERE item_key = 'armourshake' ORDER BY region;

-- STEP 1 — set the locked sell price by region (idempotent; safe to re-run).
-- WHERE clauses cover every region literal normalizePricingRegion() in
-- app/page.tsx recognizes, so this works regardless of which style Step 0 shows.
UPDATE public.price_sheet
SET price = 610
WHERE item_key = 'armourshake'
  AND lower(trim(region)) IN ('central', 'phx', 'phoenix', 'valley');

UPDATE public.price_sheet
SET price = 635
WHERE item_key = 'armourshake'
  AND lower(trim(region)) IN ('southern', 'tuc', 'tucson');

UPDATE public.price_sheet
SET price = 660
WHERE item_key = 'armourshake'
  AND lower(trim(region)) IN ('northern', 'north');

-- STEP 2 — confirm
-- SELECT item_key, price, region, active FROM public.price_sheet WHERE item_key = 'armourshake' ORDER BY region;
