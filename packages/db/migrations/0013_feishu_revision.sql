-- Apply after the final Legacy snapshot import. Existing credentials stay intact.
BEGIN;
SET LOCAL search_path TO pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.feishu_config IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.feishu_config ADD COLUMN IF NOT EXISTS revision uuid;
UPDATE public.feishu_config
  SET revision = pg_catalog.gen_random_uuid()
  WHERE revision IS NULL;
ALTER TABLE public.feishu_config
  ALTER COLUMN revision SET DEFAULT pg_catalog.gen_random_uuid(),
  ALTER COLUMN revision SET NOT NULL;
COMMIT;
