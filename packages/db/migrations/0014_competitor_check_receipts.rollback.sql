-- Stop Neo competitor check producers and consumers and account for in-flight jobs first.
-- Never replay their jobs after removing the deduplication evidence.
BEGIN;
SET LOCAL search_path TO pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TABLE IF EXISTS public.competitor_variant_check_receipts;
COMMIT;
