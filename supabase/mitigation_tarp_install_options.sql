-- Mitigation install options for tarp groups
-- Paste in Supabase → SQL Editor → Run once
--
-- Adds: eave_install, rake_install, hip_install, shingle_tuck
-- Updates: fascia_wrap label + category
-- Soft-retires: eave_rake_install (legacy; app still aliases to it)

-- Helper: copy sell rates from a source key into a new/updated key
-- 1) Eave install (from eave_rake_install)
UPDATE public.mitigation_price_sheet AS t
SET
  insurance_rate = src.insurance_rate,
  cash_retail = src.cash_retail,
  label = 'Eave install',
  category = 'install',
  unit = COALESCE(src.unit, 'each'),
  active = true
FROM public.mitigation_price_sheet AS src
WHERE t.item_key = 'eave_install'
  AND src.item_key = 'eave_rake_install';

INSERT INTO public.mitigation_price_sheet (
  item_key, label, category, unit, insurance_rate, cash_retail, active, sort_order
)
SELECT
  'eave_install', 'Eave install', 'install', COALESCE(unit, 'each'),
  insurance_rate, cash_retail, true, COALESCE(sort_order, 40)
FROM public.mitigation_price_sheet AS src
WHERE src.item_key = 'eave_rake_install'
  AND NOT EXISTS (
    SELECT 1 FROM public.mitigation_price_sheet x WHERE x.item_key = 'eave_install'
  );

-- 2) Rake install (same rates)
UPDATE public.mitigation_price_sheet AS t
SET
  insurance_rate = src.insurance_rate,
  cash_retail = src.cash_retail,
  label = 'Rake install',
  category = 'install',
  unit = COALESCE(src.unit, 'each'),
  active = true
FROM public.mitigation_price_sheet AS src
WHERE t.item_key = 'rake_install'
  AND src.item_key = 'eave_rake_install';

INSERT INTO public.mitigation_price_sheet (
  item_key, label, category, unit, insurance_rate, cash_retail, active, sort_order
)
SELECT
  'rake_install', 'Rake install', 'install', COALESCE(unit, 'each'),
  insurance_rate, cash_retail, true, COALESCE(sort_order, 41)
FROM public.mitigation_price_sheet AS src
WHERE src.item_key = 'eave_rake_install'
  AND NOT EXISTS (
    SELECT 1 FROM public.mitigation_price_sheet x WHERE x.item_key = 'rake_install'
  );

-- 3) Hip install (same rates as eave/rake)
UPDATE public.mitigation_price_sheet AS t
SET
  insurance_rate = src.insurance_rate,
  cash_retail = src.cash_retail,
  label = 'Hip install',
  category = 'install',
  unit = COALESCE(src.unit, 'each'),
  active = true
FROM public.mitigation_price_sheet AS src
WHERE t.item_key = 'hip_install'
  AND src.item_key = 'eave_rake_install';

INSERT INTO public.mitigation_price_sheet (
  item_key, label, category, unit, insurance_rate, cash_retail, active, sort_order
)
SELECT
  'hip_install', 'Hip install', 'install', COALESCE(unit, 'each'),
  insurance_rate, cash_retail, true, COALESCE(sort_order, 42)
FROM public.mitigation_price_sheet AS src
WHERE src.item_key = 'eave_rake_install'
  AND NOT EXISTS (
    SELECT 1 FROM public.mitigation_price_sheet x WHERE x.item_key = 'hip_install'
  );

-- 4) Shingle tuck — lower than fascia (more common / less work)
-- Fascia wrap = $165 / $125 · Shingle tuck = $100 / $75
UPDATE public.mitigation_price_sheet
SET
  insurance_rate = 100,
  cash_retail = 75,
  label = 'Shingle tuck',
  category = 'install',
  unit = 'each',
  active = true
WHERE item_key = 'shingle_tuck';

INSERT INTO public.mitigation_price_sheet (
  item_key, label, category, unit, insurance_rate, cash_retail, active, sort_order
)
SELECT
  'shingle_tuck', 'Shingle tuck', 'install', 'each',
  100, 75, true, 45
WHERE NOT EXISTS (
  SELECT 1 FROM public.mitigation_price_sheet x WHERE x.item_key = 'shingle_tuck'
);

-- 5) Fascia wrap — clearer label (stays priced as each; eave+rake = 2× in app)
UPDATE public.mitigation_price_sheet
SET
  label = 'Fascia wrap',
  category = 'install',
  active = true
WHERE item_key = 'fascia_wrap';

-- 6) Soft-retire combined eave/rake key
UPDATE public.mitigation_price_sheet
SET active = false
WHERE item_key = 'eave_rake_install';

-- Verify:
-- SELECT item_key, label, category, unit, insurance_rate, cash_retail, active
-- FROM public.mitigation_price_sheet
-- WHERE item_key IN (
--   'eave_install','rake_install','hip_install','shingle_tuck',
--   'fascia_wrap','ridge_install','valley_install','eave_rake_install'
-- )
-- ORDER BY item_key;
