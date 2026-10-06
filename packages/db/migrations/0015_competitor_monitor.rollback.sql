-- Stop Neo competitor-monitor producers/consumers and reconcile outstanding
-- claims before rollback. Historical rows remain; only the Neo link is removed.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DROP TABLE IF EXISTS public.competitor_monitor_notifications;
DROP TABLE IF EXISTS public.competitor_monitor_runs;
DROP INDEX IF EXISTS public.idx_competitor_monitor_history_task_country;
ALTER TABLE public.competitor_monitor_history DROP COLUMN IF EXISTS monitor_task_id;
COMMIT;
