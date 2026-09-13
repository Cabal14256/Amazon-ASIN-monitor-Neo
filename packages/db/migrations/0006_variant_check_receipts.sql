-- Primary database only, after the final Legacy import and 0004. Completion
-- records are written in the same transaction as ASIN status/history changes.
BEGIN;
SET LOCAL search_path TO pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE IF NOT EXISTS public.variant_check_receipts (
  operation_key varchar(64) PRIMARY KEY,
  request_hash varchar(64) NOT NULL,
  task_id varchar(200) NOT NULL,
  user_id varchar(200) NOT NULL,
  task_created_at varchar(40) NOT NULL,
  task_type varchar(100) NOT NULL,
  task_sub_type varchar(200) NOT NULL,
  step varchar(32) NOT NULL,
  result_kind varchar(16) NOT NULL,
  result jsonb NOT NULL,
  completed_at timestamp without time zone NOT NULL DEFAULT LOCALTIMESTAMP,
  expires_at timestamp without time zone NOT NULL,
  CONSTRAINT ck_variant_check_receipts_digest CHECK (operation_key ~ '^[a-f0-9]{64}$' AND request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT ck_variant_check_receipts_size CHECK (octet_length(result::text) BETWEEN 1 AND 33554432),
  CONSTRAINT ck_variant_check_receipts_kind CHECK (result_kind IN ('asin','group','parent','batch'))
);
CREATE INDEX IF NOT EXISTS idx_variant_check_receipts_task_owner ON public.variant_check_receipts(task_id,user_id,task_created_at);
CREATE INDEX IF NOT EXISTS idx_variant_check_receipts_expiry ON public.variant_check_receipts(expires_at);
COMMIT;
