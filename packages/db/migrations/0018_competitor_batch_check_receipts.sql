-- Competitor database only; 0014 must be installed first.
BEGIN;
SET LOCAL search_path TO pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.competitor_variant_check_receipts
  DROP CONSTRAINT IF EXISTS ck_competitor_variant_check_receipts_kind;
ALTER TABLE public.competitor_variant_check_receipts
  ADD CONSTRAINT ck_competitor_variant_check_receipts_kind
  CHECK (result_kind IN ('competitor-asin','competitor-group','competitor-batch'));
COMMIT;
