-- Hip install = same sell rates as eave / rake install
-- Paste in Supabase → SQL Editor → Run

-- If hip already exists (from earlier ridge copy), update rates to match eave/rake:
UPDATE public.mitigation_price_sheet AS hip
SET
  insurance_rate = eave.insurance_rate,
  cash_retail = eave.cash_retail,
  label = 'Hip install',
  category = COALESCE(eave.category, 'Install'),
  unit = COALESCE(eave.unit, hip.unit),
  active = true
FROM public.mitigation_price_sheet AS eave
WHERE hip.item_key = 'hip_install'
  AND eave.item_key = 'eave_rake_install';

-- If hip does not exist yet, insert from eave/rake:
INSERT INTO public.mitigation_price_sheet (
  item_key, label, category, unit, insurance_rate, cash_retail, active, sort_order
)
SELECT
  'hip_install',
  'Hip install',
  COALESCE(category, 'Install'),
  COALESCE(unit, 'LF'),
  insurance_rate,
  cash_retail,
  true,
  COALESCE(sort_order, 50) + 1
FROM public.mitigation_price_sheet AS src
WHERE src.item_key = 'eave_rake_install'
  AND NOT EXISTS (
    SELECT 1 FROM public.mitigation_price_sheet AS x WHERE x.item_key = 'hip_install'
  );

-- Optional cost twin from eave/rake:
UPDATE public.mitigation_cost_sheet AS hip
SET
  cost = eave.cost,
  label = 'Hip install',
  category = COALESCE(eave.category, hip.category),
  unit = COALESCE(eave.unit, hip.unit)
FROM public.mitigation_cost_sheet AS eave
WHERE hip.item_key = 'hip_install'
  AND eave.item_key = 'eave_rake_install';

INSERT INTO public.mitigation_cost_sheet (
  item_key, label, category, unit, cost, notes, sort_order
)
SELECT
  'hip_install', 'Hip install', COALESCE(category, 'Install'), unit, cost, notes,
  COALESCE(sort_order, 50) + 1
FROM public.mitigation_cost_sheet AS src
WHERE src.item_key = 'eave_rake_install'
  AND NOT EXISTS (
    SELECT 1 FROM public.mitigation_cost_sheet AS x WHERE x.item_key = 'hip_install'
  );

-- Check:
-- SELECT item_key, insurance_rate, cash_retail FROM mitigation_price_sheet
-- WHERE item_key IN ('eave_rake_install', 'hip_install');
