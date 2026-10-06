-- Stop system monitor producers/consumers and reconcile unresolved claims first.
-- Removes only private system ledgers. Business and monitor history remain.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TABLE IF EXISTS public.competitor_scheduled_monitor_group_receipts;
DROP TABLE IF EXISTS public.competitor_scheduled_monitor_notifications;
DROP TABLE IF EXISTS public.competitor_scheduled_monitor_runs;
COMMIT;
