DROP TABLE IF EXISTS public.primary_monitor_notifications;
DROP TABLE IF EXISTS public.primary_monitor_runs;
DROP INDEX IF EXISTS public.idx_monitor_history_monitor_task_country;
ALTER TABLE public.monitor_history DROP COLUMN IF EXISTS monitor_task_id;
