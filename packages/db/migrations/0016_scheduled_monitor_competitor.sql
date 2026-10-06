-- Private competitor system monitor ledger; no application user/session identity.
-- Install only in the corresponding logical database after its manual monitor upgrade.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $prerequisites$
BEGIN
  IF to_regclass('public.competitor_variant_groups') IS NULL
     OR to_regclass('public.competitor_monitor_history') IS NULL
     OR to_regclass('public.competitor_monitor_runs') IS NULL
     OR to_regclass('public.variant_groups') IS NOT NULL THEN
    RAISE EXCEPTION 'scheduled monitor target prerequisite mismatch';
  END IF;
END
$prerequisites$;
-- Only this migration may establish its version marker on new tables. Existing
-- unmarked or drifted tables require investigation; never stamp them as valid.
DO $ledger_preflight$
DECLARE
  table_name text;
  relation regclass;
  marker text;
  expected_prefix text;
  fingerprint text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('amazon-asin-monitor:scheduled-ledger:competitor',0));
  FOREACH table_name IN ARRAY ARRAY['competitor_scheduled_monitor_runs','competitor_scheduled_monitor_notifications','competitor_scheduled_monitor_group_receipts'] LOOP
    relation := to_regclass('public.' || table_name);
    expected_prefix := 'amazon-asin-monitor:scheduled-ledger:v1:competitor:' || table_name || ':';
    IF relation IS NULL THEN CONTINUE; END IF;
    EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE',relation);
    marker := obj_description(relation,'pg_class');
    IF marker IS NULL OR marker !~ ('^' || expected_prefix || '[a-f0-9]{32}$') THEN
      RAISE EXCEPTION 'scheduled ledger version marker mismatch';
    END IF;
    SELECT md5(jsonb_build_object(
      'table', jsonb_build_array(c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.reloptions),
      'columns', (SELECT coalesce(jsonb_agg(jsonb_build_array(a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,a.attisdropped,a.attcollation::regcollation::text,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum),'[]'::jsonb) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0),
      'constraints', (SELECT coalesce(jsonb_agg(jsonb_build_array(k.conname,k.contype,k.convalidated,pg_get_constraintdef(k.oid)) ORDER BY k.conname),'[]'::jsonb) FROM pg_constraint k WHERE k.conrelid=c.oid),
      'indexes', (SELECT coalesce(jsonb_agg(jsonb_build_array(i.indexrelid::regclass::text,i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid::regclass::text),'[]'::jsonb) FROM pg_index i WHERE i.indrelid=c.oid),
      'triggers', (SELECT coalesce(jsonb_agg(jsonb_build_array(t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgname),'[]'::jsonb) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
      'rules', (SELECT coalesce(jsonb_agg(pg_get_ruledef(r.oid) ORDER BY r.rulename),'[]'::jsonb) FROM pg_rewrite r WHERE r.ev_class=c.oid)
    )::text) INTO fingerprint FROM pg_class c WHERE c.oid=relation;
    IF marker <> expected_prefix || fingerprint THEN
      RAISE EXCEPTION 'scheduled ledger catalog drift';
    END IF;
  END LOOP;
END
$ledger_preflight$;
CREATE TABLE IF NOT EXISTS public.competitor_scheduled_monitor_runs (
  task_id uuid PRIMARY KEY,
  job_id varchar(200) NOT NULL,
  job_digest varchar(64) NOT NULL,
  job jsonb NOT NULL,
  domain varchar(16) NOT NULL,
  actor_kind varchar(16) NOT NULL DEFAULT 'system',
  actor_purpose varchar(32) NOT NULL DEFAULT 'scheduled-monitor',
  country varchar(2) NOT NULL,
  planned_slot timestamptz NOT NULL,
  requested_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  interval_minutes integer NOT NULL,
  batch_index integer NOT NULL,
  total_batches integer NOT NULL,
  groups jsonb NOT NULL,
  snapshot_digest varchar(64) NOT NULL,
  total_members integer NOT NULL,
  state varchar(24) NOT NULL DEFAULT 'pending',
  business_completed_at timestamptz,
  completed_at timestamptz,
  cancel_requested_at timestamptz,
  result jsonb,
  follow_up_job jsonb,
  follow_up_digest varchar(64),
  follow_up_requested_at timestamptz,
  CONSTRAINT uq_competitor_scheduled_monitor_job UNIQUE (job_id),
  CONSTRAINT uq_competitor_scheduled_monitor_identity UNIQUE (task_id,job_digest,country),
  CONSTRAINT ck_competitor_scheduled_monitor_actor CHECK (domain='competitor' AND actor_kind='system' AND actor_purpose='scheduled-monitor'),
  CONSTRAINT ck_competitor_scheduled_monitor_country CHECK (country IN ('US','UK','DE','FR','ES','IT')),
  CONSTRAINT ck_competitor_scheduled_monitor_digest CHECK (job_digest ~ '^[a-f0-9]{64}$' AND snapshot_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT ck_competitor_scheduled_monitor_job CHECK (jsonb_typeof(job)='object' AND octet_length(job::text)<=16384 AND NOT (job ? 'userId') AND job @> jsonb_build_object('version',1,'source','scheduled','taskType','scheduled-monitor','actor',jsonb_build_object('kind','system','purpose','scheduled-monitor'),'domain',domain,'country',country,'taskId',task_id::text,'jobId',job_id,'intervalMinutes',interval_minutes,'batchConfig',jsonb_build_object('batchIndex',batch_index,'totalBatches',total_batches)) AND job->>'plannedSlot' IS NOT NULL AND (job->>'plannedSlot')::timestamptz=planned_slot AND job->>'requestedAt' IS NOT NULL AND (job->>'requestedAt')::timestamptz=requested_at AND job->>'createdAt' IS NOT NULL AND (job->>'createdAt')::timestamptz=created_at AND job->>'expiresAt' IS NOT NULL AND (job->>'expiresAt')::timestamptz=expires_at),
  CONSTRAINT ck_competitor_scheduled_monitor_time CHECK (planned_slot=(date_trunc('minute',planned_slot AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AND requested_at>=planned_slot AND created_at>=requested_at AND expires_at>created_at),
  CONSTRAINT ck_competitor_scheduled_monitor_batch CHECK (interval_minutes IN (15,30,60) AND total_batches BETWEEN 1 AND 1000 AND batch_index>=0 AND batch_index<total_batches AND batch_index=mod(mod(floor(extract(epoch FROM planned_slot)/(interval_minutes*60))::bigint,total_batches)+total_batches,total_batches)),
  CONSTRAINT ck_competitor_scheduled_monitor_snapshot CHECK (jsonb_typeof(groups)='array' AND jsonb_array_length(groups)<=1000 AND octet_length(groups::text)<=16777216 AND total_members BETWEEN 0 AND 20000),
  CONSTRAINT ck_competitor_scheduled_monitor_state CHECK (state IN ('pending','running','business-completed','completed','skipped-expired','cancelled','failed')),
  CONSTRAINT ck_competitor_scheduled_monitor_completion CHECK (((state IN ('completed','skipped-expired','cancelled','failed') AND completed_at IS NOT NULL) OR (state IN ('pending','running','business-completed') AND completed_at IS NULL)) AND (state NOT IN ('business-completed','completed') OR business_completed_at IS NOT NULL) AND (business_completed_at IS NULL OR (business_completed_at>=created_at AND state IN ('business-completed','completed','cancelled','failed'))) AND (completed_at IS NULL OR (completed_at>=created_at AND (business_completed_at IS NULL OR completed_at>=business_completed_at)))),
  CONSTRAINT ck_competitor_scheduled_monitor_result CHECK (result IS NULL OR octet_length(result::text) BETWEEN 1 AND 33554432),
  CONSTRAINT ck_competitor_scheduled_monitor_follow_up CHECK ((follow_up_job IS NULL AND follow_up_digest IS NULL AND follow_up_requested_at IS NULL) OR (domain='primary' AND country='US' AND business_completed_at IS NOT NULL AND follow_up_job IS NOT NULL AND jsonb_typeof(follow_up_job)='object' AND octet_length(follow_up_job::text)<=16384 AND NOT (follow_up_job ? 'userId') AND follow_up_job @> '{"version":1,"source":"scheduled","taskType":"scheduled-monitor","actor":{"kind":"system","purpose":"scheduled-monitor"},"domain":"competitor","country":"US"}'::jsonb AND follow_up_job @> jsonb_build_object('plannedSlot',job->>'plannedSlot','intervalMinutes',interval_minutes,'batchConfig',jsonb_build_object('batchIndex',batch_index,'totalBatches',total_batches)) AND follow_up_digest IS NOT NULL AND follow_up_digest ~ '^[a-f0-9]{64}$' AND follow_up_requested_at IS NOT NULL AND follow_up_job->>'requestedAt' IS NOT NULL AND (follow_up_job->>'requestedAt')::timestamptz=follow_up_requested_at AND follow_up_requested_at>=business_completed_at))
);
CREATE INDEX IF NOT EXISTS idx_competitor_scheduled_monitor_expiry ON public.competitor_scheduled_monitor_runs(expires_at,task_id);
CREATE TABLE IF NOT EXISTS public.competitor_scheduled_monitor_notifications (
  task_id uuid NOT NULL,
  job_digest varchar(64) NOT NULL,
  country varchar(2) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'claimed',
  claimed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT competitor_scheduled_monitor_notifications_pkey PRIMARY KEY(task_id,country),
  CONSTRAINT fk_competitor_scheduled_monitor_notice_run FOREIGN KEY(task_id,job_digest,country) REFERENCES public.competitor_scheduled_monitor_runs(task_id,job_digest,country) ON DELETE CASCADE,
  CONSTRAINT ck_competitor_scheduled_monitor_notice_state CHECK ((state='claimed' AND completed_at IS NULL) OR (state IN ('sent','failed') AND completed_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS public.competitor_scheduled_monitor_group_receipts (
  operation_key varchar(64) PRIMARY KEY,
  request_hash varchar(64) NOT NULL,
  task_id uuid NOT NULL,
  job_digest varchar(64) NOT NULL,
  country varchar(2) NOT NULL,
  group_id varchar(50) NOT NULL,
  ordinal integer NOT NULL,
  snapshot_digest varchar(64) NOT NULL,
  result_kind varchar(16) NOT NULL,
  result jsonb NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_competitor_scheduled_monitor_group_ordinal UNIQUE(task_id,ordinal),
  CONSTRAINT uq_competitor_scheduled_monitor_group_id UNIQUE(task_id,group_id),
  CONSTRAINT fk_competitor_scheduled_monitor_group_run FOREIGN KEY(task_id,job_digest,country) REFERENCES public.competitor_scheduled_monitor_runs(task_id,job_digest,country) ON DELETE CASCADE,
  CONSTRAINT ck_competitor_scheduled_monitor_group_digest CHECK (operation_key ~ '^[a-f0-9]{64}$' AND request_hash ~ '^[a-f0-9]{64}$' AND snapshot_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT ck_competitor_scheduled_monitor_group_ordinal CHECK (ordinal BETWEEN 0 AND 999),
  CONSTRAINT ck_competitor_scheduled_monitor_group_kind CHECK (result_kind='competitor-group'),
  CONSTRAINT ck_competitor_scheduled_monitor_group_size CHECK (octet_length(result::text) BETWEEN 1 AND 33554432)
);
-- Fingerprint columns (including defaults/collation), validated constraints,
-- indexes, non-internal triggers, rules and RLS. ACL/ownership changes do not
-- change the schema contract. Repeated upgrades verify before and after DDL.
DO $ledger_postflight$
DECLARE
  table_name text;
  relation regclass;
  marker text;
  expected_prefix text;
  fingerprint text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['competitor_scheduled_monitor_runs','competitor_scheduled_monitor_notifications','competitor_scheduled_monitor_group_receipts'] LOOP
    relation := to_regclass('public.' || table_name);
    expected_prefix := 'amazon-asin-monitor:scheduled-ledger:v1:competitor:' || table_name || ':';
    IF relation IS NULL THEN RAISE EXCEPTION 'scheduled ledger missing'; END IF;
    SELECT md5(jsonb_build_object(
      'table', jsonb_build_array(c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.reloptions),
      'columns', (SELECT coalesce(jsonb_agg(jsonb_build_array(a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,a.attisdropped,a.attcollation::regcollation::text,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum),'[]'::jsonb) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0),
      'constraints', (SELECT coalesce(jsonb_agg(jsonb_build_array(k.conname,k.contype,k.convalidated,pg_get_constraintdef(k.oid)) ORDER BY k.conname),'[]'::jsonb) FROM pg_constraint k WHERE k.conrelid=c.oid),
      'indexes', (SELECT coalesce(jsonb_agg(jsonb_build_array(i.indexrelid::regclass::text,i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid::regclass::text),'[]'::jsonb) FROM pg_index i WHERE i.indrelid=c.oid),
      'triggers', (SELECT coalesce(jsonb_agg(jsonb_build_array(t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgname),'[]'::jsonb) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
      'rules', (SELECT coalesce(jsonb_agg(pg_get_ruledef(r.oid) ORDER BY r.rulename),'[]'::jsonb) FROM pg_rewrite r WHERE r.ev_class=c.oid)
    )::text) INTO fingerprint FROM pg_class c WHERE c.oid=relation;
    marker := obj_description(relation,'pg_class');
    IF marker IS NULL THEN
      EXECUTE format('COMMENT ON TABLE %s IS %L',relation,expected_prefix || fingerprint);
    ELSIF marker <> expected_prefix || fingerprint THEN
      RAISE EXCEPTION 'scheduled ledger catalog drift';
    END IF;
  END LOOP;
END
$ledger_postflight$;
COMMIT;
