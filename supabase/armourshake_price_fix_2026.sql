-- SUPERSEDED by supabase/migrations/20260813030201_armourshake_hvac_sell_joe.sql
-- Joe confirmed 2026-08-12: armourshake sell = $900 PHX / $925 TUC / $950 NORTH.
-- Kept so an old paste in the SQL editor does not revert live prices.

UPDATE public.price_sheet
SET price = 900
WHERE item_key = 'armourshake'
  AND lower(trim(region)) IN ('central', 'phx', 'phoenix', 'valley');

UPDATE public.price_sheet
SET price = 925
WHERE item_key = 'armourshake'
  AND lower(trim(region)) IN ('southern', 'tuc', 'tucson');

UPDATE public.price_sheet
SET price = 950
WHERE item_key = 'armourshake'
  AND lower(trim(region)) IN ('northern', 'north');
