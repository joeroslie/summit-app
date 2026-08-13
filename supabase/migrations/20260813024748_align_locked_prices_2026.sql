-- =============================================================================
-- Align live prices to locked 2026 book (Joe confirmed 2026-08-12).
-- Updates only. No new rows. No invented prices.
--
-- Cambridge PHX 475 → 450
-- Armourshake material cost 240 → 230
-- HVAC PHX 1250 → 1300
-- Steep RFQ leftovers 100/175/250 → 25/75/150
-- Silicone TBD quoted rows → 0 (Set when quoted)
-- =============================================================================

-- IKO Cambridge PHX (central). TUC $475 / NORTH $500 already match the book.
UPDATE public.price_sheet
SET price = 450
WHERE item_key = 'cambridge'
  AND lower(trim(region)) IN ('central', 'phx', 'phoenix', 'valley');

-- IKO Armourshake material cost (book $230/sq).
UPDATE public.cost_sheet_material
SET cost = 230
WHERE item_key = 'armourshake';

-- HVAC D&R PHX. TUC/NORTH already $1600.
UPDATE public.price_sheet
SET price = 1300
WHERE item_key = 'hvac'
  AND lower(trim(region)) IN ('central', 'phx', 'phoenix', 'valley');

-- Steep customer sell = cover only (all regions).
UPDATE public.price_sheet
SET price = 25
WHERE item_key = 'steep_8_9';

UPDATE public.price_sheet
SET price = 75
WHERE item_key = 'steep_9_11';

UPDATE public.price_sheet
SET price = 150
WHERE item_key = 'steep_11_12';

-- Silicone coating is TBD in the book — do not quote.
UPDATE public.price_sheet
SET price = 0,
    notes = 'Set when quoted'
WHERE item_key = 'silicone';
