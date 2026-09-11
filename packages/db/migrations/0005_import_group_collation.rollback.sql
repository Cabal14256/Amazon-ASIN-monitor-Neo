-- Stop import producers/consumers before rollback. Existing records are kept.
BEGIN;
SET LOCAL search_path TO pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.variant_groups IN SHARE ROW EXCLUSIVE MODE;
DROP INDEX IF EXISTS public.idx_variant_groups_import_match;
DROP COLLATION IF EXISTS public.neo_import_group_ci;
COMMIT;
