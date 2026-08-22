-- Instant Roofer Human Certified orders.
-- Vercel cannot persist .data/*.json; webhook + Measurements list need Postgres.
-- Instant Roofer POSTs with no user session — merge RPC is SECURITY DEFINER (update
-- existing rows; insert only when ids are present). Table is authenticated-only.

CREATE TABLE IF NOT EXISTS public.instant_roofer_human_orders (
  id text PRIMARY KEY,
  request_id text,
  human_report_id text,
  lead_id text,
  company_id uuid REFERENCES public.companies (id) ON DELETE CASCADE,
  lat double precision NOT NULL DEFAULT 0,
  lng double precision NOT NULL DEFAULT 0,
  address text,
  customer_name text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'completed', 'failed')),
  report_url text,
  report_type text,
  failure_reason text,
  raw_queued jsonb,
  raw_webhook jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.instant_roofer_human_orders IS
  'Instant Roofer Human Certified (~$10) orders. Webhook writes via merge_instant_roofer_human_order; Measurements lists by lead_id.';

CREATE UNIQUE INDEX IF NOT EXISTS instant_roofer_human_orders_request_id_uidx
  ON public.instant_roofer_human_orders (request_id)
  WHERE request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS instant_roofer_human_orders_human_report_id_uidx
  ON public.instant_roofer_human_orders (human_report_id)
  WHERE human_report_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS instant_roofer_human_orders_lead_id_idx
  ON public.instant_roofer_human_orders (lead_id);

CREATE INDEX IF NOT EXISTS instant_roofer_human_orders_company_id_idx
  ON public.instant_roofer_human_orders (company_id);

DROP TRIGGER IF EXISTS instant_roofer_human_orders_set_company_id
  ON public.instant_roofer_human_orders;
CREATE TRIGGER instant_roofer_human_orders_set_company_id
  BEFORE INSERT ON public.instant_roofer_human_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.set_row_company_id();

ALTER TABLE public.instant_roofer_human_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instant_roofer_human_orders FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instant_roofer_human_orders_select_member
  ON public.instant_roofer_human_orders;
CREATE POLICY instant_roofer_human_orders_select_member
  ON public.instant_roofer_human_orders FOR SELECT TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM public.company_members WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS instant_roofer_human_orders_insert_member
  ON public.instant_roofer_human_orders;
CREATE POLICY instant_roofer_human_orders_insert_member
  ON public.instant_roofer_human_orders FOR INSERT TO authenticated
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM public.company_members WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS instant_roofer_human_orders_update_member
  ON public.instant_roofer_human_orders;
CREATE POLICY instant_roofer_human_orders_update_member
  ON public.instant_roofer_human_orders FOR UPDATE TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM public.company_members WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM public.company_members WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS instant_roofer_human_orders_delete_member
  ON public.instant_roofer_human_orders;
CREATE POLICY instant_roofer_human_orders_delete_member
  ON public.instant_roofer_human_orders FOR DELETE TO authenticated
  USING (
    company_id IN (
      SELECT company_id FROM public.company_members WHERE user_id = auth.uid()
    )
  );

REVOKE ALL ON public.instant_roofer_human_orders FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instant_roofer_human_orders TO authenticated;

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

  RETURN to_jsonb(found);
END;
$$;

REVOKE ALL ON FUNCTION public.merge_instant_roofer_human_order(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_instant_roofer_human_order(jsonb) TO anon, authenticated;
