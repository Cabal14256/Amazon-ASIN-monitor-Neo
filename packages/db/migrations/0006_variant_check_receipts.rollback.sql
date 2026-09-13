-- Stop API check producers and variant-check/batch-check consumers first.
-- Do not replay old jobs after rollback: their deduplication evidence is removed.
-- Preserve any required completed task results before running this rollback.
BEGIN;
SET LOCAL search_path TO pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TABLE IF EXISTS public.variant_check_receipts;
COMMIT;
