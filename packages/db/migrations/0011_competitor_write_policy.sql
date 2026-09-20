-- Competitor database only, after 0010 and the final Legacy import.
BEGIN;
SET LOCAL search_path TO pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.competitor_variant_groups, public.competitor_asins IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_collation c
    WHERE c.oid='public.neo_competitor_query_ci'::regcollation
      AND c.collprovider='i' AND NOT c.collisdeterministic
      AND c.colliculocale='und-u-ks-level1'
      AND c.collversion=pg_catalog.pg_collation_actual_version(c.oid)
  ) THEN
    RAISE EXCEPTION 'Competitor matching upgrade is required';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.set_competitor_update_timestamp()
RETURNS trigger LANGUAGE plpgsql SET search_path TO pg_catalog
AS $$
DECLARE timestamp_mode text := current_setting('asin_monitor.competitor_timestamp_mode', true);
BEGIN
  IF timestamp_mode = 'explicit' THEN
    RETURN NEW;
  ELSIF COALESCE(timestamp_mode, '') <> '' THEN
    RAISE EXCEPTION 'Unsupported competitor timestamp mode' USING ERRCODE='22023';
  END IF;
  IF NEW.update_time IS NOT DISTINCT FROM OLD.update_time AND NEW IS DISTINCT FROM OLD THEN
    NEW.update_time := clock_timestamp() AT TIME ZONE 'Asia/Shanghai';
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION public.set_competitor_update_timestamp() IS 'competitor-update-timestamp-policy-v1';
DROP TRIGGER IF EXISTS trg_competitor_variant_groups_update_time ON public.competitor_variant_groups;
CREATE TRIGGER trg_competitor_variant_groups_update_time
BEFORE UPDATE ON public.competitor_variant_groups
FOR EACH ROW EXECUTE FUNCTION public.set_competitor_update_timestamp();
DROP TRIGGER IF EXISTS trg_competitor_asins_update_time ON public.competitor_asins;
CREATE TRIGGER trg_competitor_asins_update_time
BEFORE UPDATE ON public.competitor_asins
FOR EACH ROW EXECUTE FUNCTION public.set_competitor_update_timestamp();
-- The legacy composite unique key uses CI/accent/PADSPACE equality.
-- Refuse equivalent existing duplicates; never merge or delete business rows.
DROP INDEX IF EXISTS public.idx_neo_competitor_write_asin_country;
CREATE UNIQUE INDEX idx_neo_competitor_write_asin_country ON public.competitor_asins
  ((rtrim(asin) COLLATE public.neo_competitor_query_ci), (rtrim(country) COLLATE public.neo_competitor_query_ci));
COMMENT ON INDEX public.idx_neo_competitor_write_asin_country IS 'competitor-asin-country-policy-v1';
COMMIT;
