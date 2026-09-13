-- Roll API back to a version preceding the monitor-history query module first.
-- The shared collation belongs to 0005 and must remain for ASIN import.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP FUNCTION IF EXISTS public.neo_monitor_like(text, text);
DROP INDEX IF EXISTS public.idx_variant_groups_history_id_ci;
DROP INDEX IF EXISTS public.idx_asins_history_id_ci;
COMMIT;
