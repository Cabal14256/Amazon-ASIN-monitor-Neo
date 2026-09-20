-- Stop/revert Neo competitor query consumers first. No row changes or CASCADE.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP FUNCTION IF EXISTS public.neo_competitor_query_like(text,text);
DROP INDEX IF EXISTS public.idx_neo_competitor_query_children;
DROP INDEX IF EXISTS public.idx_neo_competitor_query_asin_id;
DROP INDEX IF EXISTS public.idx_neo_competitor_query_group_id;
DROP COLLATION IF EXISTS public.neo_competitor_query_ci RESTRICT;
COMMIT;
