-- Primary database only. Stop Neo catalog producers before rollback/upgrade.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $catalog_fence$
DECLARE
  existed boolean;
  table_name text;
  relation regclass;
  fingerprint text;
  marker text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('amazon-asin-monitor:catalog-operation-fence:v1',0));
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.competitor_variant_groups') IS NOT NULL THEN
    RAISE EXCEPTION 'catalog operation fence requires the primary database';
  END IF;
  existed := to_regclass('public.catalog_operation_slots') IS NOT NULL
          OR to_regclass('public.catalog_operation_pins') IS NOT NULL;
  IF existed AND (to_regclass('public.catalog_operation_slots') IS NULL
              OR to_regclass('public.catalog_operation_pins') IS NULL) THEN
    RAISE EXCEPTION 'catalog operation fence has a partial/conflicting schema';
  END IF;
  IF NOT existed THEN
    CREATE TABLE public.catalog_operation_slots (
      owner_id varchar(50) COLLATE "C" NOT NULL,
      domain varchar(16) COLLATE "C" NOT NULL,
      generation bigint NOT NULL DEFAULT 0,
      operation_id uuid,
      kind varchar(32),
      state varchar(16) NOT NULL DEFAULT 'idle',
      expected_task_id uuid,
      task_id uuid,
      task_type varchar(32),
      task_sub_type varchar(80),
      task_created_at text,
      terminal jsonb,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT catalog_operation_slots_pkey PRIMARY KEY(owner_id,domain),
      CONSTRAINT uq_catalog_operation_identity UNIQUE(owner_id,domain,generation,operation_id),
      CONSTRAINT ck_catalog_operation_owner CHECK(char_length(owner_id)>0),
      CONSTRAINT ck_catalog_operation_domain CHECK(domain IN ('asin','competitor')),
      CONSTRAINT ck_catalog_operation_generation CHECK(generation>=0),
      CONSTRAINT ck_catalog_operation_state CHECK(state IN ('idle','open','closed','uncertain')),
      CONSTRAINT ck_catalog_operation_shape CHECK((
        (state='idle' AND operation_id IS NULL AND kind IS NULL
          AND expected_task_id IS NULL AND task_id IS NULL AND terminal IS NULL)
        OR (state<>'idle' AND generation>0 AND operation_id IS NOT NULL
          AND kind IN ('write','batch-delete','import','check','monitor')
          AND (kind<>'write' OR expected_task_id IS NULL))
      ) IS TRUE),
      CONSTRAINT ck_catalog_operation_task CHECK((
        (task_id IS NULL AND task_type IS NULL AND task_sub_type IS NULL AND task_created_at IS NULL)
        OR (task_id IS NOT NULL AND task_id=expected_task_id AND task_type IS NOT NULL
          AND task_sub_type IS NOT NULL AND task_created_at IS NOT NULL
          AND task_type IN ('batch-delete','import','variant-check','batch-check','monitor','competitor-monitor')
          AND char_length(task_sub_type)>0
          AND task_created_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')
      ) IS TRUE),
      CONSTRAINT ck_catalog_operation_terminal CHECK((terminal IS NULL OR (
        state IN ('closed','uncertain') AND jsonb_typeof(terminal)='object'
        AND terminal->>'status' IN ('completed','failed','cancelled','rejected')
        AND terminal->>'source' IN ('sync','worker','cancel','producer')
        AND (terminal->>'source'<>'producer' OR terminal->>'status'='rejected')
        AND (terminal->>'source'<>'cancel' OR terminal->>'status'='cancelled')
        AND terminal - ARRAY['status','source','task']='{}'::jsonb
        AND (
          (terminal->>'source'='sync' AND task_id IS NULL AND NOT (terminal ? 'task'))
          OR (terminal->>'source'<>'sync' AND task_id IS NOT NULL
            AND jsonb_typeof(terminal->'task')='object'
            AND (terminal->'task') - ARRAY['taskId','userId','taskType','taskSubType','createdAt']='{}'::jsonb
            AND jsonb_typeof(terminal->'task'->'taskId')='string' AND terminal->'task'->>'taskId'=task_id::text
            AND jsonb_typeof(terminal->'task'->'userId')='string' AND terminal->'task'->>'userId'=owner_id
            AND jsonb_typeof(terminal->'task'->'taskType')='string' AND terminal->'task'->>'taskType'=task_type
            AND jsonb_typeof(terminal->'task'->'taskSubType')='string' AND terminal->'task'->>'taskSubType'=task_sub_type
            AND jsonb_typeof(terminal->'task'->'createdAt')='string' AND terminal->'task'->>'createdAt'=task_created_at)
        )
      )) IS TRUE)
    );
    CREATE UNIQUE INDEX uq_catalog_operation_task ON public.catalog_operation_slots(task_id);
    CREATE TABLE public.catalog_operation_pins (
      pin_id uuid PRIMARY KEY,
      owner_id varchar(50) COLLATE "C" NOT NULL,
      domain varchar(16) COLLATE "C" NOT NULL,
      generation bigint NOT NULL,
      operation_id uuid NOT NULL,
      state varchar(16) NOT NULL DEFAULT 'pending',
      outcome varchar(16),
      created_at timestamptz NOT NULL DEFAULT now(),
      settled_at timestamptz,
      CONSTRAINT fk_catalog_operation_pin_identity FOREIGN KEY(owner_id,domain,generation,operation_id)
        REFERENCES public.catalog_operation_slots(owner_id,domain,generation,operation_id) ON DELETE RESTRICT,
      CONSTRAINT ck_catalog_operation_pin_state CHECK(state IN ('pending','settled','uncertain')),
      CONSTRAINT ck_catalog_operation_pin_shape CHECK((
        (state='pending' AND outcome IS NULL AND settled_at IS NULL)
        OR (state='uncertain' AND outcome IS NULL AND settled_at IS NOT NULL)
        OR (state='settled' AND outcome IN ('committed','rolled-back') AND settled_at IS NOT NULL)
      ) IS TRUE)
    );
    CREATE INDEX idx_catalog_operation_pins_identity
      ON public.catalog_operation_pins(owner_id,domain,generation,operation_id);
  END IF;
  FOREACH table_name IN ARRAY ARRAY['catalog_operation_slots','catalog_operation_pins'] LOOP
    relation := to_regclass('public.' || table_name);
    IF (SELECT relkind FROM pg_class WHERE oid=relation)<>'r' THEN
      RAISE EXCEPTION 'catalog operation fence object conflict';
    END IF;
    -- Detect column/default/collation, constraint/index, trigger or RLS drift.
    SELECT md5(concat_ws('|',
      (SELECT string_agg(concat_ws(':',a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),
         a.attnotnull,a.attidentity,a.attgenerated,a.attcollation,COALESCE(pg_get_expr(d.adbin,d.adrelid),'')), '|' ORDER BY a.attnum)
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
       WHERE a.attrelid=relation AND a.attnum>0 AND NOT a.attisdropped),
      (SELECT string_agg(conname||':'||pg_get_constraintdef(oid,true), '|' ORDER BY conname)
       FROM pg_constraint WHERE conrelid=relation),
      (SELECT string_agg(indexrelid::regclass::text||':'||pg_get_indexdef(indexrelid), '|' ORDER BY indexrelid::regclass::text)
       FROM pg_index WHERE indrelid=relation),
      (SELECT string_agg(tgname||':'||pg_get_triggerdef(oid,true), '|' ORDER BY tgname)
       FROM pg_trigger WHERE tgrelid=relation AND NOT tgisinternal),
      (SELECT concat_ws(':',relrowsecurity,relforcerowsecurity) FROM pg_class WHERE oid=relation),
      (SELECT string_agg(concat_ws(':',polname,polcmd,polpermissive,polroles,
         pg_get_expr(polqual,polrelid),pg_get_expr(polwithcheck,polrelid)), '|' ORDER BY polname)
       FROM pg_policy WHERE polrelid=relation)
    )) INTO fingerprint;
    marker := 'neo-catalog-operation-fence-v1:' || fingerprint;
    IF existed THEN
      IF obj_description(relation,'pg_class') IS DISTINCT FROM marker THEN
        RAISE EXCEPTION 'catalog operation fence unowned object or structural drift';
      END IF;
    ELSE
      EXECUTE format('COMMENT ON TABLE public.%I IS %L',table_name,marker);
    END IF;
  END LOOP;
END
$catalog_fence$;
COMMIT;
