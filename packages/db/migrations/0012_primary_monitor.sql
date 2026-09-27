-- Neo manual primary monitor. Receipts and history commit in one primary DB transaction.
ALTER TABLE public.monitor_history
  ADD COLUMN IF NOT EXISTS monitor_task_id varchar(36);
CREATE INDEX IF NOT EXISTS idx_monitor_history_monitor_task_country
  ON public.monitor_history (monitor_task_id, country, notification_sent);

CREATE TABLE IF NOT EXISTS public.primary_monitor_runs (
  task_id varchar(36) PRIMARY KEY,
  user_id varchar(200) NOT NULL,
  task_created_at varchar(40) NOT NULL,
  countries jsonb NOT NULL,
  groups jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT ck_primary_monitor_runs_countries CHECK (jsonb_typeof(countries) = 'array'),
  CONSTRAINT ck_primary_monitor_runs_groups CHECK (jsonb_typeof(groups) = 'array')
);

CREATE TABLE IF NOT EXISTS public.primary_monitor_notifications (
  task_id varchar(36) NOT NULL REFERENCES public.primary_monitor_runs(task_id) ON DELETE CASCADE,
  country varchar(10) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'claimed',
  claimed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (task_id, country),
  CONSTRAINT ck_primary_monitor_notification_state
    CHECK (state IN ('claimed', 'sent', 'failed'))
);
