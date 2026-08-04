-- Mitigation price tune (Joe review pass)
-- Paste in Supabase SQL Editor → Run
--
-- Changes:
--   shingle_tuck ↑ 130 / 95
--   obst: pipejack keep 200/150 · t-top 175/135 · HVAC ↑ 275/210 · skylight ↓ 125/95
--   fascia eave+rake = mid rate 250/190 (not 2×)
--   steep / 2-story / extreme heat ↓ (adders were stacking too high)

UPDATE public.mitigation_price_sheet SET insurance_rate = 130, cash_retail = 95, active = true
WHERE item_key = 'shingle_tuck';

UPDATE public.mitigation_price_sheet SET insurance_rate = 200, cash_retail = 150, label = 'Obstruction — pipejack', active = true
WHERE item_key = 'obst_pipe_jack';

UPDATE public.mitigation_price_sheet SET insurance_rate = 175, cash_retail = 135, label = 'Obstruction — T-Top vent', active = true
WHERE item_key = 'obst_ttop_vent';

UPDATE public.mitigation_price_sheet SET insurance_rate = 275, cash_retail = 210, label = 'Obstruction — HVAC unit', active = true
WHERE item_key = 'obst_hvac';

UPDATE public.mitigation_price_sheet SET insurance_rate = 125, cash_retail = 95, label = 'Obstruction — skylight', active = true
WHERE item_key = 'obst_skylight';

UPDATE public.mitigation_price_sheet SET insurance_rate = 165, cash_retail = 125, label = 'Fascia wrap', active = true
WHERE item_key = 'fascia_wrap';

INSERT INTO public.mitigation_price_sheet (
  item_key, label, category, unit, insurance_rate, cash_retail, active, sort_order
)
SELECT
  'fascia_wrap_eave_rake', 'Fascia wrap on eave and rake', 'install', 'each',
  250, 190, true, 231
WHERE NOT EXISTS (
  SELECT 1 FROM public.mitigation_price_sheet x WHERE x.item_key = 'fascia_wrap_eave_rake'
);

UPDATE public.mitigation_price_sheet
SET
  insurance_rate = 250,
  cash_retail = 190,
  label = 'Fascia wrap on eave and rake',
  category = 'install',
  unit = 'each',
  active = true
WHERE item_key = 'fascia_wrap_eave_rake';

UPDATE public.mitigation_price_sheet SET insurance_rate = 125, cash_retail = 100, active = true
WHERE item_key = 'steep_7_12';

UPDATE public.mitigation_price_sheet SET insurance_rate = 150, cash_retail = 125, active = true
WHERE item_key = 'two_plus_story';

UPDATE public.mitigation_price_sheet SET insurance_rate = 150, cash_retail = 125, active = true
WHERE item_key = 'adder_extreme_heat';
