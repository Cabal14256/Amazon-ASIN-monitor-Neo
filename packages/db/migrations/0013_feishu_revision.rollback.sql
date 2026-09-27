-- Stop Neo Feishu CAS clients before reverting. Webhook rows remain intact.
BEGIN;
SET LOCAL search_path TO pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.feishu_config IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.feishu_config DROP COLUMN IF EXISTS revision;
COMMIT;
