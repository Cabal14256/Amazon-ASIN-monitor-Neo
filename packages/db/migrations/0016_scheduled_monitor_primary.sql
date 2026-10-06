-- Private primary system monitor ledger; no application user/session identity.
-- Install only in the corresponding logical database after its manual monitor upgrade.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $prerequisites$
BEGIN
  IF to_regclass('public.variant_groups') IS NULL
     OR to_regclass('public.monitor_history') IS NULL
     OR to_regclass('public.primary_monitor_runs') IS NULL
     OR to_regclass('public.competitor_variant_groups') IS NOT NULL THEN
    RAISE EXCEPTION 'scheduled monitor target prerequisite mismatch';
  END IF;
END
$prerequisites$;
-- Only this migration may establish its version marker on new tables. Existing
-- unmarked or drifted tables require investigation; never stamp them as valid.
DO $ledger_upgrade$
DECLARE
  table_name text;
  relation regclass;
  marker text;
  expected_prefix text;
  fingerprint text;
  ordinal integer;
  preflight_relations regclass[] := ARRAY[]::regclass[];
  owned_relations regclass[] := ARRAY[]::regclass[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('amazon-asin-monitor:scheduled-ledger:primary',0));
  IF to_regclass('public.primary_scheduled_monitor_runs') IS NULL
     AND to_regclass('public.idx_primary_scheduled_monitor_expiry') IS NOT NULL THEN
    RAISE EXCEPTION 'scheduled ledger index namespace collision';
  END IF;
  FOREACH table_name IN ARRAY ARRAY['primary_scheduled_monitor_runs','primary_scheduled_monitor_notifications','primary_scheduled_monitor_group_receipts'] LOOP
    relation := to_regclass('public.' || table_name);
    preflight_relations := array_append(preflight_relations,relation);
    expected_prefix := 'amazon-asin-monitor:scheduled-ledger:v1:primary:' || table_name || ':';
    IF relation IS NULL THEN CONTINUE; END IF;
    IF (SELECT relkind FROM pg_class WHERE oid=relation) <> 'r' THEN RAISE EXCEPTION 'scheduled ledger ordinary table required'; END IF;
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
      'constraintTriggers', (SELECT coalesce(jsonb_agg(jsonb_build_array(k.conname,t.tgtype,t.tgenabled,t.tgdeferrable,t.tginitdeferred,t.tgfoid::regproc::text) ORDER BY k.conname,t.tgtype,t.tgfoid::regproc::text),'[]'::jsonb) FROM pg_trigger t LEFT JOIN pg_constraint k ON k.oid=t.tgconstraint WHERE t.tgrelid=c.oid AND t.tgisinternal),
      'rules', (SELECT coalesce(jsonb_agg(pg_get_ruledef(r.oid) ORDER BY r.rulename),'[]'::jsonb) FROM pg_rewrite r WHERE r.ev_class=c.oid)
    )::text) INTO fingerprint FROM pg_class c WHERE c.oid=relation;
    IF marker <> expected_prefix || fingerprint THEN
      RAISE EXCEPTION 'scheduled ledger catalog drift';
    END IF;
  END LOOP;
  -- preflight complete: only the recorded absence permits creation.
  IF preflight_relations[1] IS NULL THEN
CREATE TABLE public.primary_scheduled_monitor_runs (
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
  CONSTRAINT uq_primary_scheduled_monitor_job UNIQUE (job_id),
  CONSTRAINT uq_primary_scheduled_monitor_identity UNIQUE (task_id,job_digest,country),
  CONSTRAINT ck_primary_scheduled_monitor_actor CHECK (domain='primary' AND actor_kind='system' AND actor_purpose='scheduled-monitor'),
  CONSTRAINT ck_primary_scheduled_monitor_country CHECK (country IN ('US','UK','DE','FR','ES','IT')),
  CONSTRAINT ck_primary_scheduled_monitor_digest CHECK (job_digest ~ '^[a-f0-9]{64}$' AND snapshot_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT ck_primary_scheduled_monitor_job CHECK ((jsonb_typeof(job)='object' AND octet_length(job::text)<=16384 AND job ?& ARRAY['version','source','taskType','actor','taskId','jobId','domain','country','plannedSlot','intervalMinutes','batchConfig','requestedAt','createdAt','expiresAt'] AND job - ARRAY['version','source','taskType','actor','taskId','jobId','domain','country','plannedSlot','intervalMinutes','batchConfig','requestedAt','createdAt','expiresAt']='{}'::jsonb AND jsonb_typeof(job->'actor')='object' AND (job->'actor') - ARRAY['kind','purpose']='{}'::jsonb AND jsonb_typeof(job->'batchConfig')='object' AND (job->'batchConfig') - ARRAY['batchIndex','totalBatches']='{}'::jsonb AND jsonb_typeof(job->'taskId')='string' AND jsonb_typeof(job->'jobId')='string' AND jsonb_typeof(job->'plannedSlot')='string' AND jsonb_typeof(job->'requestedAt')='string' AND jsonb_typeof(job->'createdAt')='string' AND jsonb_typeof(job->'expiresAt')='string' AND job->>'plannedSlot' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND job->>'requestedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND job->>'createdAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND job->>'expiresAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND job @> jsonb_build_object('version',1,'source','scheduled','taskType','scheduled-monitor','actor',jsonb_build_object('kind','system','purpose','scheduled-monitor'),'domain',domain,'country',country,'taskId',task_id::text,'jobId',job_id,'intervalMinutes',interval_minutes,'batchConfig',jsonb_build_object('batchIndex',batch_index,'totalBatches',total_batches)) AND (job->>'plannedSlot')::timestamptz=planned_slot AND (job->>'requestedAt')::timestamptz=requested_at AND (job->>'createdAt')::timestamptz=created_at AND (job->>'expiresAt')::timestamptz=expires_at) IS TRUE),
  CONSTRAINT ck_primary_scheduled_monitor_time CHECK (planned_slot=(date_trunc('minute',planned_slot AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AND requested_at>=planned_slot AND created_at>=requested_at AND expires_at>created_at),
  CONSTRAINT ck_primary_scheduled_monitor_batch CHECK (interval_minutes IN (15,30,60) AND total_batches BETWEEN 1 AND 1000 AND batch_index>=0 AND batch_index<total_batches AND batch_index=mod(mod(floor(extract(epoch FROM planned_slot)/(interval_minutes*60))::bigint,total_batches)+total_batches,total_batches)),
  CONSTRAINT ck_primary_scheduled_monitor_snapshot CHECK (jsonb_typeof(groups)='array' AND jsonb_array_length(groups)<=1000 AND octet_length(groups::text)<=16777216 AND total_members BETWEEN 0 AND 20000),
  CONSTRAINT ck_primary_scheduled_monitor_state CHECK (state IN ('pending','running','business-completed','completed','skipped-expired','cancelled','failed')),
  CONSTRAINT ck_primary_scheduled_monitor_completion CHECK (((state IN ('completed','skipped-expired','cancelled','failed') AND completed_at IS NOT NULL) OR (state IN ('pending','running','business-completed') AND completed_at IS NULL)) AND (state NOT IN ('business-completed','completed') OR business_completed_at IS NOT NULL) AND (business_completed_at IS NULL OR (business_completed_at>=created_at AND state IN ('business-completed','completed','cancelled','failed'))) AND (completed_at IS NULL OR (completed_at>=created_at AND (business_completed_at IS NULL OR completed_at>=business_completed_at)))),
  CONSTRAINT ck_primary_scheduled_monitor_result CHECK (result IS NULL OR octet_length(result::text) BETWEEN 1 AND 33554432),
  CONSTRAINT ck_primary_scheduled_monitor_follow_up CHECK (((follow_up_job IS NULL AND follow_up_digest IS NULL AND follow_up_requested_at IS NULL) OR (domain='primary' AND country='US' AND business_completed_at IS NOT NULL AND follow_up_job IS NOT NULL AND jsonb_typeof(follow_up_job)='object' AND octet_length(follow_up_job::text)<=16384 AND follow_up_job ?& ARRAY['version','source','taskType','actor','taskId','jobId','domain','country','plannedSlot','intervalMinutes','batchConfig','requestedAt','createdAt','expiresAt'] AND follow_up_job - ARRAY['version','source','taskType','actor','taskId','jobId','domain','country','plannedSlot','intervalMinutes','batchConfig','requestedAt','createdAt','expiresAt']='{}'::jsonb AND jsonb_typeof(follow_up_job->'actor')='object' AND (follow_up_job->'actor') - ARRAY['kind','purpose']='{}'::jsonb AND jsonb_typeof(follow_up_job->'batchConfig')='object' AND (follow_up_job->'batchConfig') - ARRAY['batchIndex','totalBatches']='{}'::jsonb AND jsonb_typeof(follow_up_job->'taskId')='string' AND jsonb_typeof(follow_up_job->'jobId')='string' AND jsonb_typeof(follow_up_job->'plannedSlot')='string' AND jsonb_typeof(follow_up_job->'requestedAt')='string' AND jsonb_typeof(follow_up_job->'createdAt')='string' AND jsonb_typeof(follow_up_job->'expiresAt')='string' AND follow_up_job->>'plannedSlot' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND follow_up_job->>'requestedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND follow_up_job->>'createdAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND follow_up_job->>'expiresAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND follow_up_job @> '{"version":1,"source":"scheduled","taskType":"scheduled-monitor","actor":{"kind":"system","purpose":"scheduled-monitor"},"domain":"competitor","country":"US"}'::jsonb AND follow_up_job @> jsonb_build_object('plannedSlot',job->>'plannedSlot','intervalMinutes',interval_minutes,'batchConfig',jsonb_build_object('batchIndex',batch_index,'totalBatches',total_batches)) AND follow_up_job->>'taskId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND follow_up_job->>'taskId' <> task_id::text AND follow_up_job->>'jobId' = 'neo-competitor-monitor-scheduled-' || to_char(planned_slot AT TIME ZONE 'UTC','YYYYMMDD"T"HH24MI') || '-US-b' || batch_index::text || 'of' || total_batches::text AND follow_up_digest IS NOT NULL AND follow_up_digest ~ '^[a-f0-9]{64}$' AND follow_up_requested_at IS NOT NULL AND (follow_up_job->>'requestedAt')::timestamptz=follow_up_requested_at AND follow_up_requested_at=business_completed_at AND (follow_up_job->>'createdAt')::timestamptz=business_completed_at AND (follow_up_job->>'expiresAt')::timestamptz=expires_at AND business_completed_at>=created_at AND business_completed_at<expires_at)) IS TRUE)
);
CREATE INDEX idx_primary_scheduled_monitor_expiry ON public.primary_scheduled_monitor_runs(expires_at,task_id);
  END IF;
  IF preflight_relations[2] IS NULL THEN
CREATE TABLE public.primary_scheduled_monitor_notifications (
  task_id uuid NOT NULL,
  job_digest varchar(64) NOT NULL,
  country varchar(2) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'claimed',
  claimed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT primary_scheduled_monitor_notifications_pkey PRIMARY KEY(task_id,country),
  CONSTRAINT fk_primary_scheduled_monitor_notice_run FOREIGN KEY(task_id,job_digest,country) REFERENCES public.primary_scheduled_monitor_runs(task_id,job_digest,country) ON DELETE CASCADE,
  CONSTRAINT ck_primary_scheduled_monitor_notice_state CHECK ((state='claimed' AND completed_at IS NULL) OR (state IN ('sent','failed') AND completed_at IS NOT NULL))
);
  END IF;
  IF preflight_relations[3] IS NULL THEN
CREATE TABLE public.primary_scheduled_monitor_group_receipts (
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
  CONSTRAINT uq_primary_scheduled_monitor_group_ordinal UNIQUE(task_id,ordinal),
  CONSTRAINT uq_primary_scheduled_monitor_group_id UNIQUE(task_id,group_id),
  CONSTRAINT fk_primary_scheduled_monitor_group_run FOREIGN KEY(task_id,job_digest,country) REFERENCES public.primary_scheduled_monitor_runs(task_id,job_digest,country) ON DELETE CASCADE,
  CONSTRAINT ck_primary_scheduled_monitor_group_digest CHECK (operation_key ~ '^[a-f0-9]{64}$' AND request_hash ~ '^[a-f0-9]{64}$' AND snapshot_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT ck_primary_scheduled_monitor_group_ordinal CHECK (ordinal BETWEEN 0 AND 999),
  CONSTRAINT ck_primary_scheduled_monitor_group_kind CHECK (result_kind='group'),
  CONSTRAINT ck_primary_scheduled_monitor_group_size CHECK (octet_length(result::text) BETWEEN 1 AND 33554432)
);
  END IF;
  owned_relations := ARRAY[to_regclass('public.primary_scheduled_monitor_runs'),to_regclass('public.primary_scheduled_monitor_notifications'),to_regclass('public.primary_scheduled_monitor_group_receipts')];
  ALTER TABLE public.primary_scheduled_monitor_runs DROP CONSTRAINT ck_primary_scheduled_monitor_job, DROP CONSTRAINT ck_primary_scheduled_monitor_follow_up,
    ADD CONSTRAINT ck_primary_scheduled_monitor_job CHECK ((jsonb_typeof(job)='object' AND octet_length(job::text)<=16384 AND job ?& ARRAY['version','source','taskType','actor','taskId','jobId','domain','country','plannedSlot','intervalMinutes','batchConfig','requestedAt','createdAt','expiresAt'] AND job - ARRAY['version','source','taskType','actor','taskId','jobId','domain','country','plannedSlot','intervalMinutes','batchConfig','requestedAt','createdAt','expiresAt']='{}'::jsonb AND jsonb_typeof(job->'actor')='object' AND (job->'actor') - ARRAY['kind','purpose']='{}'::jsonb AND jsonb_typeof(job->'batchConfig')='object' AND (job->'batchConfig') - ARRAY['batchIndex','totalBatches']='{}'::jsonb AND jsonb_typeof(job->'taskId')='string' AND jsonb_typeof(job->'jobId')='string' AND jsonb_typeof(job->'plannedSlot')='string' AND jsonb_typeof(job->'requestedAt')='string' AND jsonb_typeof(job->'createdAt')='string' AND jsonb_typeof(job->'expiresAt')='string' AND job->>'plannedSlot' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND job->>'requestedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND job->>'createdAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND job->>'expiresAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND job @> jsonb_build_object('version',1,'source','scheduled','taskType','scheduled-monitor','actor',jsonb_build_object('kind','system','purpose','scheduled-monitor'),'domain',domain,'country',country,'taskId',task_id::text,'jobId',job_id,'intervalMinutes',interval_minutes,'batchConfig',jsonb_build_object('batchIndex',batch_index,'totalBatches',total_batches)) AND (job->>'plannedSlot')::timestamptz=planned_slot AND (job->>'requestedAt')::timestamptz=requested_at AND (job->>'createdAt')::timestamptz=created_at AND (job->>'expiresAt')::timestamptz=expires_at) IS TRUE),
    ADD CONSTRAINT ck_primary_scheduled_monitor_follow_up CHECK (((follow_up_job IS NULL AND follow_up_digest IS NULL AND follow_up_requested_at IS NULL) OR (domain='primary' AND country='US' AND business_completed_at IS NOT NULL AND follow_up_job IS NOT NULL AND jsonb_typeof(follow_up_job)='object' AND octet_length(follow_up_job::text)<=16384 AND follow_up_job ?& ARRAY['version','source','taskType','actor','taskId','jobId','domain','country','plannedSlot','intervalMinutes','batchConfig','requestedAt','createdAt','expiresAt'] AND follow_up_job - ARRAY['version','source','taskType','actor','taskId','jobId','domain','country','plannedSlot','intervalMinutes','batchConfig','requestedAt','createdAt','expiresAt']='{}'::jsonb AND jsonb_typeof(follow_up_job->'actor')='object' AND (follow_up_job->'actor') - ARRAY['kind','purpose']='{}'::jsonb AND jsonb_typeof(follow_up_job->'batchConfig')='object' AND (follow_up_job->'batchConfig') - ARRAY['batchIndex','totalBatches']='{}'::jsonb AND jsonb_typeof(follow_up_job->'taskId')='string' AND jsonb_typeof(follow_up_job->'jobId')='string' AND jsonb_typeof(follow_up_job->'plannedSlot')='string' AND jsonb_typeof(follow_up_job->'requestedAt')='string' AND jsonb_typeof(follow_up_job->'createdAt')='string' AND jsonb_typeof(follow_up_job->'expiresAt')='string' AND follow_up_job->>'plannedSlot' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND follow_up_job->>'requestedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND follow_up_job->>'createdAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND follow_up_job->>'expiresAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND follow_up_job @> '{"version":1,"source":"scheduled","taskType":"scheduled-monitor","actor":{"kind":"system","purpose":"scheduled-monitor"},"domain":"competitor","country":"US"}'::jsonb AND follow_up_job @> jsonb_build_object('plannedSlot',job->>'plannedSlot','intervalMinutes',interval_minutes,'batchConfig',jsonb_build_object('batchIndex',batch_index,'totalBatches',total_batches)) AND follow_up_job->>'taskId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND follow_up_job->>'taskId' <> task_id::text AND follow_up_job->>'jobId' = 'neo-competitor-monitor-scheduled-' || to_char(planned_slot AT TIME ZONE 'UTC','YYYYMMDD"T"HH24MI') || '-US-b' || batch_index::text || 'of' || total_batches::text AND follow_up_digest IS NOT NULL AND follow_up_digest ~ '^[a-f0-9]{64}$' AND follow_up_requested_at IS NOT NULL AND (follow_up_job->>'requestedAt')::timestamptz=follow_up_requested_at AND follow_up_requested_at=business_completed_at AND (follow_up_job->>'createdAt')::timestamptz=business_completed_at AND (follow_up_job->>'expiresAt')::timestamptz=expires_at AND business_completed_at>=created_at AND business_completed_at<expires_at)) IS TRUE);
  ordinal := 0;
  FOREACH table_name IN ARRAY ARRAY['primary_scheduled_monitor_runs','primary_scheduled_monitor_notifications','primary_scheduled_monitor_group_receipts'] LOOP
    ordinal := ordinal + 1;
    relation := to_regclass('public.' || table_name);
    expected_prefix := 'amazon-asin-monitor:scheduled-ledger:v1:primary:' || table_name || ':';
    IF relation IS NULL OR owned_relations[ordinal] <> relation THEN RAISE EXCEPTION 'scheduled ledger ownership changed'; END IF;
    SELECT md5(jsonb_build_object(
      'table', jsonb_build_array(c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.reloptions),
      'columns', (SELECT coalesce(jsonb_agg(jsonb_build_array(a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,a.attisdropped,a.attcollation::regcollation::text,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum),'[]'::jsonb) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0),
      'constraints', (SELECT coalesce(jsonb_agg(jsonb_build_array(k.conname,k.contype,k.convalidated,pg_get_constraintdef(k.oid)) ORDER BY k.conname),'[]'::jsonb) FROM pg_constraint k WHERE k.conrelid=c.oid),
      'indexes', (SELECT coalesce(jsonb_agg(jsonb_build_array(i.indexrelid::regclass::text,i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid::regclass::text),'[]'::jsonb) FROM pg_index i WHERE i.indrelid=c.oid),
      'triggers', (SELECT coalesce(jsonb_agg(jsonb_build_array(t.tgname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY t.tgname),'[]'::jsonb) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
      'constraintTriggers', (SELECT coalesce(jsonb_agg(jsonb_build_array(k.conname,t.tgtype,t.tgenabled,t.tgdeferrable,t.tginitdeferred,t.tgfoid::regproc::text) ORDER BY k.conname,t.tgtype,t.tgfoid::regproc::text),'[]'::jsonb) FROM pg_trigger t LEFT JOIN pg_constraint k ON k.oid=t.tgconstraint WHERE t.tgrelid=c.oid AND t.tgisinternal),
      'rules', (SELECT coalesce(jsonb_agg(pg_get_ruledef(r.oid) ORDER BY r.rulename),'[]'::jsonb) FROM pg_rewrite r WHERE r.ev_class=c.oid)
    )::text) INTO fingerprint FROM pg_class c WHERE c.oid=relation;
    -- Only preflight-owned or transaction-created locked OIDs reach this update.
    EXECUTE format('COMMENT ON TABLE %s IS %L',relation,expected_prefix || fingerprint);
  END LOOP;
END
$ledger_upgrade$;
COMMIT;
