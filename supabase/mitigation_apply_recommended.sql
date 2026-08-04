-- Apply recommended mitigation sell rates (Joe approved)
-- Paste in Supabase SQL Editor → Run
--
-- Rules:
--   · No tax on sell or cost (tax later)
--   · Costs stay materials-only (HD pre-tax) — labor not on cost sheet
--   · Brown tarp 30×50 / 40×60 do not exist (blue only)

-- Trips
UPDATE public.mitigation_price_sheet SET insurance_rate = 150, cash_retail = 120, active = true WHERE item_key = 'trip_planned';
UPDATE public.mitigation_price_sheet SET insurance_rate = 275, cash_retail = 220, active = true WHERE item_key = 'trip_emergency';
UPDATE public.mitigation_price_sheet SET insurance_rate = 150, cash_retail = 120, active = true WHERE item_key = 'trip_additional';

-- Tarps (ins hold · cash nudge)
UPDATE public.mitigation_price_sheet SET insurance_rate = 375, cash_retail = 285, active = true WHERE item_key = 'tarp_6x8';
UPDATE public.mitigation_price_sheet SET insurance_rate = 525, cash_retail = 400, active = true WHERE item_key = 'tarp_8x10';
UPDATE public.mitigation_price_sheet SET insurance_rate = 675, cash_retail = 515, active = true WHERE item_key = 'tarp_10x12';
UPDATE public.mitigation_price_sheet SET insurance_rate = 875, cash_retail = 665, active = true WHERE item_key = 'tarp_12x16';
UPDATE public.mitigation_price_sheet SET insurance_rate = 1100, cash_retail = 840, active = true WHERE item_key = 'tarp_16x20';
UPDATE public.mitigation_price_sheet SET insurance_rate = 1375, cash_retail = 1050, active = true WHERE item_key = 'tarp_20x30';
UPDATE public.mitigation_price_sheet SET insurance_rate = 1995, cash_retail = 1520, active = true WHERE item_key = 'tarp_30x50';
UPDATE public.mitigation_price_sheet SET insurance_rate = 2595, cash_retail = 1980, active = true WHERE item_key = 'tarp_40x60';

-- Install
UPDATE public.mitigation_price_sheet SET insurance_rate = 175, cash_retail = 135, active = true WHERE item_key = 'ridge_install';
UPDATE public.mitigation_price_sheet SET insurance_rate = 225, cash_retail = 175, active = true WHERE item_key = 'valley_install';
UPDATE public.mitigation_price_sheet SET insurance_rate = 175, cash_retail = 135, active = true WHERE item_key = 'hip_install';
UPDATE public.mitigation_price_sheet SET insurance_rate = 175, cash_retail = 135, active = true WHERE item_key = 'eave_install';
UPDATE public.mitigation_price_sheet SET insurance_rate = 175, cash_retail = 135, active = true WHERE item_key = 'rake_install';
UPDATE public.mitigation_price_sheet SET insurance_rate = 140, cash_retail = 110, active = true WHERE item_key = 'shingle_tuck';
UPDATE public.mitigation_price_sheet SET insurance_rate = 175, cash_retail = 135, active = true WHERE item_key = 'fascia_wrap';
UPDATE public.mitigation_price_sheet SET insurance_rate = 260, cash_retail = 200, active = true WHERE item_key = 'fascia_wrap_eave_rake';

-- Obstruction (labor premium in sell · $0 material cost)
UPDATE public.mitigation_price_sheet SET insurance_rate = 200, cash_retail = 155, active = true WHERE item_key = 'obst_pipe_jack';
UPDATE public.mitigation_price_sheet SET insurance_rate = 185, cash_retail = 145, active = true WHERE item_key = 'obst_ttop_vent';
UPDATE public.mitigation_price_sheet SET insurance_rate = 300, cash_retail = 235, active = true WHERE item_key = 'obst_hvac';
UPDATE public.mitigation_price_sheet SET insurance_rate = 110, cash_retail = 85, active = true WHERE item_key = 'obst_skylight';

-- Adders
UPDATE public.mitigation_price_sheet SET insurance_rate = 40, cash_retail = 30, active = true WHERE item_key = 'sandbag_25lb';
UPDATE public.mitigation_price_sheet SET insurance_rate = 45, cash_retail = 30, active = true WHERE item_key = 'batten_furring_1x2x8';
UPDATE public.mitigation_price_sheet SET insurance_rate = 50, cash_retail = 35, active = true WHERE item_key = 'batten_pt_1x2x8';
UPDATE public.mitigation_price_sheet SET insurance_rate = 55, cash_retail = 40, active = true WHERE item_key = 'batten_select_1x2x8';
UPDATE public.mitigation_price_sheet SET insurance_rate = 135, cash_retail = 110, active = true WHERE item_key = 'steep_7_12';
UPDATE public.mitigation_price_sheet SET insurance_rate = 160, cash_retail = 130, active = true WHERE item_key = 'two_plus_story';
UPDATE public.mitigation_price_sheet SET insurance_rate = 150, cash_retail = 125, active = true WHERE item_key = 'adder_extreme_heat';

-- Material costs: keep HD shelf prices as-is (pre-tax). Soft-kill brown sizes that don't exist.
UPDATE public.mitigation_cost_sheet
SET active = false, notes = 'Not sold — brown only up to 20×30; use blue for 30×50 / 40×60'
WHERE item_key IN ('tarp_brown_30x50', 'tarp_brown_40x60');

-- Confirm
-- SELECT item_key, insurance_rate, cash_retail FROM mitigation_price_sheet WHERE active ORDER BY item_key;
