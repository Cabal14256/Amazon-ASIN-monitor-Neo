-- Stop interval maintenance and roll back the statistics API first. Interval
-- data remains intact; a later upgrade queues every key for reconciliation.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.monitor_history, public.monitor_history_status_interval IN SHARE ROW EXCLUSIVE MODE;
DROP TRIGGER IF EXISTS trg_monitor_interval_source_dirty ON public.monitor_history;
DROP TRIGGER IF EXISTS trg_monitor_interval_projection_dirty ON public.monitor_history_status_interval;
DROP TRIGGER IF EXISTS trg_monitor_interval_source_truncate ON public.monitor_history;
DROP TRIGGER IF EXISTS trg_monitor_interval_projection_truncate ON public.monitor_history_status_interval;
DROP FUNCTION IF EXISTS public.neo_queue_monitor_interval();
DROP FUNCTION IF EXISTS public.neo_queue_monitor_interval_truncate();
DROP INDEX IF EXISTS public.idx_monitor_history_interval_key;
DROP FUNCTION IF EXISTS public.neo_monitor_interval_key(text, text);
DROP TABLE IF EXISTS public.monitor_interval_dirty;
DROP TABLE IF EXISTS public.monitor_interval_projection;
-- Keep the compatible varchar(53) widening: narrowing would destroy valid
-- ID# identifiers or block recovery. No older query depends on the length.
COMMIT;
