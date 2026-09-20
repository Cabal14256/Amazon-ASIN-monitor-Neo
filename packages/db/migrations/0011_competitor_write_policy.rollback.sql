-- Stop/revert competitor write consumers first. Keep business rows and 0010.
BEGIN;
SET LOCAL search_path TO pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.competitor_variant_groups, public.competitor_asins IN ACCESS EXCLUSIVE MODE;
DROP TRIGGER IF EXISTS trg_competitor_variant_groups_update_time ON public.competitor_variant_groups;
CREATE TRIGGER trg_competitor_variant_groups_update_time
BEFORE UPDATE ON public.competitor_variant_groups
FOR EACH ROW EXECUTE FUNCTION public.set_updated_timestamp_column('update_time');
DROP TRIGGER IF EXISTS trg_competitor_asins_update_time ON public.competitor_asins;
CREATE TRIGGER trg_competitor_asins_update_time
BEFORE UPDATE ON public.competitor_asins
FOR EACH ROW EXECUTE FUNCTION public.set_updated_timestamp_column('update_time');
DROP FUNCTION IF EXISTS public.set_competitor_update_timestamp() RESTRICT;
DROP INDEX IF EXISTS public.idx_neo_competitor_write_asin_country;
COMMIT;
