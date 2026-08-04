-- Obstruction type options + sandbag adder
-- Paste in Supabase → SQL Editor → Run once
--
-- Home Depot cost reference (approx, pre-tax):
--   Play sand ~$6.90 / 50 lb  → ~$3.45 per 25 lb fill
--   DURASACK white woven sandbags w/ ties (25-pack) ≈ $15.67 → ~$0.63/bag
--   Material cost ≈ $4.08 per 25 lb sandbag placed (add sales tax later)
-- Sell: $35 insurance / $25 cash per sandbag (labor + placement)

-- 1) Obstruction types (same sell as legacy obstruction $200 / $150)
--    Pipejack is one option (not pipe + jack separately)
INSERT INTO public.mitigation_price_sheet (
  item_key, label, category, unit, insurance_rate, cash_retail, active, sort_order
)
SELECT v.item_key, v.label, 'install', 'each', 200, 150, true, v.sort_order
FROM (VALUES
  ('obst_pipe_jack', 'Obstruction — pipejack', 60),
  ('obst_ttop_vent', 'Obstruction — T-Top vent', 62),
  ('obst_hvac', 'Obstruction — HVAC unit', 63),
  ('obst_skylight', 'Obstruction — skylight', 64)
) AS v(item_key, label, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM public.mitigation_price_sheet x WHERE x.item_key = v.item_key
);

UPDATE public.mitigation_price_sheet AS t
SET
  insurance_rate = 200,
  cash_retail = 150,
  label = v.label,
  category = 'install',
  unit = 'each',
  active = true
FROM (VALUES
  ('obst_pipe_jack', 'Obstruction — pipejack'),
  ('obst_ttop_vent', 'Obstruction — T-Top vent'),
  ('obst_hvac', 'Obstruction — HVAC unit'),
  ('obst_skylight', 'Obstruction — skylight')
) AS v(item_key, label)
WHERE t.item_key = v.item_key;

-- Soft-retire generic obstruction (keep for old invoices; UI uses typed options)
UPDATE public.mitigation_price_sheet
SET active = false
WHERE item_key = 'obstruction';

-- 2) Sandbag 25 lb adder
INSERT INTO public.mitigation_price_sheet (
  item_key, label, category, unit, insurance_rate, cash_retail, active, sort_order
)
SELECT
  'sandbag_25lb', 'Sandbag (25 lb)', 'adder', 'each', 35, 25, true, 70
WHERE NOT EXISTS (
  SELECT 1 FROM public.mitigation_price_sheet x WHERE x.item_key = 'sandbag_25lb'
);

UPDATE public.mitigation_price_sheet
SET
  insurance_rate = 35,
  cash_retail = 25,
  label = 'Sandbag (25 lb)',
  category = 'adder',
  unit = 'each',
  active = true
WHERE item_key = 'sandbag_25lb';

-- Cost twin (~HD material: $6.90/50lb sand + DURASACK 25-pack $15.67)
INSERT INTO public.mitigation_cost_sheet (
  item_key, label, category, unit, cost, notes, sort_order
)
SELECT
  'sandbag_25lb',
  'Sandbag (25 lb)',
  'adders',
  'each',
  4.08,
  'HD ~$6.90/50lb play sand + DURASACK ~$0.63/bag (25-pack $15.67) · pre-tax',
  70
WHERE NOT EXISTS (
  SELECT 1 FROM public.mitigation_cost_sheet x WHERE x.item_key = 'sandbag_25lb'
);

UPDATE public.mitigation_cost_sheet
SET
  cost = 4.08,
  label = 'Sandbag (25 lb)',
  notes = 'HD ~$6.90/50lb play sand + DURASACK ~$0.63/bag (25-pack $15.67) · pre-tax'
WHERE item_key = 'sandbag_25lb';

-- Verify:
-- SELECT item_key, label, insurance_rate, cash_retail, active
-- FROM mitigation_price_sheet
-- WHERE item_key LIKE 'obst_%' OR item_key IN ('obstruction','sandbag_25lb')
-- ORDER BY item_key;
