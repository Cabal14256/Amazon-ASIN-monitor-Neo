-- Primary database only, after the final Legacy import and 0003.
SET search_path TO pg_catalog, public;
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.variant_groups, public.asins IN ACCESS EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.set_asin_update_timestamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog
AS $$
DECLARE
  timestamp_mode text := current_setting('asin_monitor.timestamp_mode', true);
BEGIN
  IF timestamp_mode = 'explicit' THEN
    RETURN NEW;
  ELSIF COALESCE(timestamp_mode, '') <> '' THEN
    RAISE EXCEPTION 'Unsupported ASIN timestamp mode' USING ERRCODE = '22023';
  END IF;
  IF NEW.update_time IS NOT DISTINCT FROM OLD.update_time
     AND NEW IS DISTINCT FROM OLD THEN
    -- A statement can start before waiting for a row lock. Read the clock here,
    -- after that lock, rather than using transaction/statement start time.
    NEW.update_time := clock_timestamp() AT TIME ZONE 'Asia/Shanghai';
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.set_asin_update_timestamp() IS 'asin-update-timestamp-policy-v1';

DROP TRIGGER IF EXISTS trg_variant_groups_update_time ON public.variant_groups;
CREATE TRIGGER trg_variant_groups_update_time
BEFORE UPDATE ON public.variant_groups
FOR EACH ROW EXECUTE FUNCTION public.set_asin_update_timestamp();

DROP TRIGGER IF EXISTS trg_asins_update_time ON public.asins;
CREATE TRIGGER trg_asins_update_time
BEFORE UPDATE ON public.asins
FOR EACH ROW EXECUTE FUNCTION public.set_asin_update_timestamp();
COMMIT;
