-- =============================================================================
-- Joe confirmed 2026-08-12: Armourshake + HVAC sell.
-- Updates only. Material cost unchanged ($230/sq).
--
-- Armourshake all-in package sell: $900 PHX / $925 TUC / $950 NORTH
-- HVAC D&R sell: $1350 PHX / $1600 TUC / $1600 NORTH
-- =============================================================================

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

UPDATE public.price_sheet
SET price = 1350
WHERE item_key = 'hvac'
  AND lower(trim(region)) IN ('central', 'phx', 'phoenix', 'valley');

UPDATE public.price_sheet
SET price = 1600
WHERE item_key = 'hvac'
  AND lower(trim(region)) IN (
    'southern', 'tuc', 'tucson',
    'northern', 'north'
  );
