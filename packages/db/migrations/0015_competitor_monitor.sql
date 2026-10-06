-- Competitor database only; apply before enabling the Neo monitor consumer.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.competitor_monitor_history ADD COLUMN IF NOT EXISTS monitor_task_id varchar(36);
CREATE INDEX IF NOT EXISTS idx_competitor_monitor_history_task_country
  ON public.competitor_monitor_history (monitor_task_id,country,notification_sent);
CREATE TABLE IF NOT EXISTS public.competitor_monitor_runs (
  task_id varchar(36) PRIMARY KEY,
  user_id varchar(200) NOT NULL,
  task_created_at varchar(40) NOT NULL,
  countries jsonb NOT NULL,
  groups jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT ck_competitor_monitor_runs_countries CHECK (jsonb_typeof(countries)='array' AND jsonb_array_length(countries) BETWEEN 1 AND 6),
  CONSTRAINT ck_competitor_monitor_runs_groups CHECK (jsonb_typeof(groups)='array' AND jsonb_array_length(groups)<=1000 AND octet_length(groups::text)<=1048576)
);
CREATE INDEX IF NOT EXISTS idx_competitor_monitor_runs_expiry ON public.competitor_monitor_runs(expires_at);
CREATE TABLE IF NOT EXISTS public.competitor_monitor_notifications (
  task_id varchar(36) NOT NULL REFERENCES public.competitor_monitor_runs(task_id) ON DELETE CASCADE,
  country varchar(10) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'claimed',
  claimed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY(task_id,country),
  CONSTRAINT ck_competitor_monitor_notice_state CHECK(state IN ('claimed','sent','failed'))
);
COMMIT;
