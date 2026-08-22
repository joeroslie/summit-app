-- Human Certified status follows the lead on every device.
-- Webhook has no auth.uid() — stamp company_id from the lead and copy status
-- onto leads.details.humanMeasureOrders (cloud source of truth).

CREATE OR REPLACE FUNCTION public.merge_lead_human_orders_json(
  existing jsonb,
  incoming jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(elem), '[]'::jsonb)
  FROM (
    SELECT DISTINCT ON (coalesce(e->>'id', e->>'requestId')) e AS elem
    FROM (
      SELECT incoming AS e
      UNION ALL
      SELECT jsonb_array_elements(
        CASE WHEN jsonb_typeof(existing) = 'array' THEN existing ELSE '[]'::jsonb END
      )
    ) s
    WHERE coalesce(e->>'id', e->>'requestId', '') <> ''
    ORDER BY
      coalesce(e->>'id', e->>'requestId'),
      CASE e->>'status'
        WHEN 'completed' THEN 3
        WHEN 'failed' THEN 2
        WHEN 'queued' THEN 1
        ELSE 0
      END DESC
  ) t;
$$;

REVOKE ALL ON FUNCTION public.merge_lead_human_orders_json(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stamp_human_order_on_lead(public.instant_roofer_human_orders) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.stamp_human_order_on_lead(
  ord public.instant_roofer_human_orders
)
RETURNS public.instant_roofer_human_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lead_company uuid;
  lead_key text;
BEGIN
  lead_key := nullif(btrim(ord.lead_id), '');
  IF lead_key IS NULL THEN
    RETURN ord;
  END IF;

  SELECT l.company_id INTO lead_company
  FROM public.leads l
  WHERE l.deleted_at IS NULL
    AND (
      l.id::text = lead_key
      OR coalesce(l.details->>'clientNumericId', '') = lead_key
    )
  ORDER BY l.updated_at DESC NULLS LAST
  LIMIT 1;

  IF ord.company_id IS NULL AND lead_company IS NOT NULL THEN
    UPDATE public.instant_roofer_human_orders
    SET company_id = lead_company
    WHERE id = ord.id
    RETURNING * INTO ord;
  END IF;

  UPDATE public.leads l
  SET
    details = jsonb_set(
      coalesce(l.details, '{}'::jsonb),
      '{humanMeasureOrders}',
      public.merge_lead_human_orders_json(
        coalesce(l.details->'humanMeasureOrders', '[]'::jsonb),
        jsonb_build_object(
          'id', ord.id,
          'requestId', ord.request_id,
          'leadId', ord.lead_id,
          'status', ord.status,
          'reportUrl', ord.report_url,
          'address', ord.address,
          'createdAt', ord.created_at,
          'failureReason', ord.failure_reason
        )
      )
    ),
    updated_at = now()
  WHERE l.deleted_at IS NULL
    AND (
      l.id::text = lead_key
      OR coalesce(l.details->>'clientNumericId', '') = lead_key
    );

  RETURN ord;
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_human_order_on_lead(public.instant_roofer_human_orders) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.merge_instant_roofer_human_order(order_json jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  found public.instant_roofer_human_orders%ROWTYPE;
  incoming_id text;
  incoming_req text;
  incoming_hr text;
  incoming_lead text;
  incoming_type text;
  incoming_url text;
  incoming_status text;
  incoming_lat double precision;
  incoming_lng double precision;
  keep_url text;
  keep_type text;
  keep_status text;
  rank_new int;
  rank_old int;
BEGIN
  incoming_id := nullif(btrim(order_json->>'id'), '');
  incoming_req := nullif(btrim(order_json->>'request_id'), '');
  incoming_hr := nullif(btrim(order_json->>'human_report_id'), '');
  incoming_lead := nullif(btrim(order_json->>'lead_id'), '');
  incoming_type := nullif(lower(btrim(order_json->>'report_type')), '');
  incoming_url := nullif(btrim(order_json->>'report_url'), '');
  incoming_status := coalesce(nullif(btrim(order_json->>'status'), ''), 'queued');
  incoming_lat := coalesce((order_json->>'lat')::double precision, 0);
  incoming_lng := coalesce((order_json->>'lng')::double precision, 0);

  SELECT * INTO found
  FROM public.instant_roofer_human_orders o
  WHERE (incoming_id IS NOT NULL AND o.id = incoming_id)
     OR (incoming_req IS NOT NULL AND o.request_id = incoming_req)
     OR (incoming_hr IS NOT NULL AND o.human_report_id = incoming_hr)
     OR (
       incoming_lat <> 0 AND incoming_lng <> 0
       AND o.status = 'queued'
       AND abs(o.lat - incoming_lat) < 0.00015
       AND abs(o.lng - incoming_lng) < 0.00015
     )
  ORDER BY o.updated_at DESC NULLS LAST
  LIMIT 1;

  rank_new := CASE incoming_type
    WHEN 'pdf' THEN 3
    WHEN 'html' THEN 2
    WHEN 'xml' THEN 1
    WHEN 'csv' THEN 0
    ELSE 1
  END;
  rank_old := CASE lower(coalesce(found.report_type, ''))
    WHEN 'pdf' THEN 3
    WHEN 'html' THEN 2
    WHEN 'xml' THEN 1
    WHEN 'csv' THEN 0
    ELSE 1
  END;

  keep_url := found.report_url;
  keep_type := found.report_type;
  IF incoming_url IS NOT NULL THEN
    IF keep_url IS NULL OR rank_new >= rank_old THEN
      keep_url := incoming_url;
      keep_type := coalesce(incoming_type, keep_type);
    END IF;
  END IF;

  keep_status := incoming_status;
  IF keep_url IS NOT NULL AND keep_status = 'queued' THEN
    keep_status := 'completed';
  END IF;
  IF found.status = 'completed' AND keep_status = 'queued' THEN
    keep_status := 'completed';
  END IF;

  IF found.id IS NOT NULL THEN
    UPDATE public.instant_roofer_human_orders SET
      request_id = coalesce(incoming_req, found.request_id),
      human_report_id = coalesce(incoming_hr, found.human_report_id),
      lead_id = coalesce(found.lead_id, incoming_lead),
      lat = CASE WHEN incoming_lat <> 0 THEN incoming_lat ELSE found.lat END,
      lng = CASE WHEN incoming_lng <> 0 THEN incoming_lng ELSE found.lng END,
      address = coalesce(nullif(btrim(order_json->>'address'), ''), found.address),
      customer_name = coalesce(nullif(btrim(order_json->>'customer_name'), ''), found.customer_name),
      status = keep_status,
      report_url = keep_url,
      report_type = keep_type,
      failure_reason = CASE
        WHEN keep_status = 'failed' THEN coalesce(nullif(btrim(order_json->>'failure_reason'), ''), found.failure_reason)
        ELSE found.failure_reason
      END,
      raw_webhook = coalesce(order_json->'raw_webhook', found.raw_webhook),
      raw_queued = coalesce(found.raw_queued, order_json->'raw_queued'),
      updated_at = now()
    WHERE id = found.id
    RETURNING * INTO found;
    found := public.stamp_human_order_on_lead(found);
    RETURN to_jsonb(found);
  END IF;

  IF incoming_id IS NULL THEN
    incoming_id := coalesce(incoming_hr, incoming_req, 'webhook-' || extract(epoch from now())::bigint);
  END IF;

  INSERT INTO public.instant_roofer_human_orders (
    id, request_id, human_report_id, lead_id,
    lat, lng, address, customer_name,
    status, report_url, report_type, failure_reason,
    raw_queued, raw_webhook
  ) VALUES (
    incoming_id,
    incoming_req,
    incoming_hr,
    incoming_lead,
    incoming_lat,
    incoming_lng,
    nullif(btrim(order_json->>'address'), ''),
    nullif(btrim(order_json->>'customer_name'), ''),
    keep_status,
    keep_url,
    keep_type,
    CASE WHEN keep_status = 'failed' THEN nullif(btrim(order_json->>'failure_reason'), '') ELSE NULL END,
    order_json->'raw_queued',
    order_json->'raw_webhook'
  )
  RETURNING * INTO found;

  found := public.stamp_human_order_on_lead(found);
  RETURN to_jsonb(found);
END;
$$;

REVOKE ALL ON FUNCTION public.merge_instant_roofer_human_order(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_instant_roofer_human_order(jsonb) TO anon, authenticated;
