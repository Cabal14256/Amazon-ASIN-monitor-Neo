-- Stop/revert dependent ASIN writers first. No historical rows are rewritten.
SET search_path TO pg_catalog, public;
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.variant_groups, public.asins IN ACCESS EXCLUSIVE MODE;

DROP TRIGGER IF EXISTS trg_variant_groups_update_time ON public.variant_groups;
CREATE TRIGGER trg_variant_groups_update_time
BEFORE UPDATE ON public.variant_groups
FOR EACH ROW EXECUTE FUNCTION public.set_updated_timestamp_column('update_time');

DROP TRIGGER IF EXISTS trg_asins_update_time ON public.asins;
CREATE TRIGGER trg_asins_update_time
BEFORE UPDATE ON public.asins
FOR EACH ROW EXECUTE FUNCTION public.set_updated_timestamp_column('update_time');

DROP FUNCTION IF EXISTS public.set_asin_update_timestamp();
COMMIT;
