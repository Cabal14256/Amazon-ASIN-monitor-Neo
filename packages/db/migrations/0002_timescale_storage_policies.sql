-- P1-T4b: replace the translated Legacy index set with workload-oriented
-- indexes, enable the TimescaleDB 2.29.2 columnstore, and install lifecycle
-- policies. Raw-data retention is intentionally opt-in: set the custom GUC
-- asin_monitor.monitor_history_retention_days to an integer >= 800 for the
-- migration session. An unset GUC requires that no retention policy exists.

SET TIME ZONE 'Asia/Shanghai';
SET search_path TO pg_catalog, public;
SET lock_timeout = '30s';
SET statement_timeout = 0;

DO $storage_preflight$
DECLARE
  extension_version text;
  managed_cagg_count integer;
  retention_days_text text := NULLIF(
    current_setting(
      'asin_monitor.monitor_history_retention_days',
      true
    ),
    ''
  );
  retention_days integer;
  retention_policy_count integer;
  matching_retention_policy_count integer;
  monitor_history_hypertable_id integer;
BEGIN
  SELECT extversion
  INTO extension_version
  FROM pg_extension
  WHERE extname = 'timescaledb';

  IF extension_version IS DISTINCT FROM '2.29.2' THEN
    RAISE EXCEPTION
      '0002_timescale_storage_policies requires TimescaleDB 2.29.2 (found %)',
      COALESCE(extension_version, 'missing');
  END IF;

  SELECT COUNT(*)::integer
  INTO managed_cagg_count
  FROM timescaledb_information.continuous_aggregates
  WHERE view_schema = 'public'
    AND view_name IN (
      'monitor_history_cagg_asin_hour',
      'monitor_history_cagg_asin_day',
      'monitor_history_cagg_asin_month',
      'monitor_history_cagg_dim_hour',
      'monitor_history_cagg_dim_day',
      'monitor_history_cagg_dim_month',
      'monitor_history_cagg_variant_group_hour',
      'monitor_history_cagg_variant_group_day',
      'monitor_history_cagg_variant_group_month'
    );

  IF managed_cagg_count <> 9 THEN
    RAISE EXCEPTION
      '0002_timescale_storage_policies requires the exact nine P1-T4a CAGGs (found %)',
      managed_cagg_count;
  END IF;

  SELECT id
  INTO monitor_history_hypertable_id
  FROM _timescaledb_catalog.hypertable
  WHERE schema_name = 'public'
    AND table_name = 'monitor_history';

  IF monitor_history_hypertable_id IS NULL THEN
    RAISE EXCEPTION
      '0002_timescale_storage_policies requires public.monitor_history to be a hypertable';
  END IF;

  IF retention_days_text IS NOT NULL THEN
    IF retention_days_text !~ '^[0-9]+$' THEN
      RAISE EXCEPTION
        'asin_monitor.monitor_history_retention_days must be an integer >= 800';
    END IF;
    retention_days := retention_days_text::integer;
    IF retention_days < 800 THEN
      RAISE EXCEPTION
        'monitor_history retention must be >= 800 days so it remains beyond the 25-month CAGG refresh/backfill window';
    END IF;
  END IF;

  SELECT
    COUNT(*)::integer,
    COUNT(*) FILTER (
      WHERE retention_days IS NOT NULL
        AND (jobs.config ->> 'drop_after')::interval =
          make_interval(days => retention_days)
        AND jobs.schedule_interval = INTERVAL '1 day'
        AND jobs.scheduled
        AND jobs.fixed_schedule
        AND jobs.initial_start = TIMESTAMPTZ '2026-01-01 00:00:00+08'
        AND catalog_job.timezone = 'Asia/Shanghai'
    )::integer
  INTO retention_policy_count, matching_retention_policy_count
  FROM timescaledb_information.jobs jobs
  JOIN _timescaledb_catalog.bgw_job catalog_job
    ON catalog_job.id = jobs.job_id
  WHERE jobs.proc_name = 'policy_retention'
    AND (jobs.config ->> 'hypertable_id')::integer =
      monitor_history_hypertable_id;

  IF retention_days IS NULL AND retention_policy_count <> 0 THEN
    RAISE EXCEPTION
      'monitor_history retention is configured in the catalog but the migration session did not explicitly set asin_monitor.monitor_history_retention_days';
  END IF;

  IF retention_days IS NOT NULL
    AND (
      retention_policy_count NOT IN (0, 1)
      OR matching_retention_policy_count <> retention_policy_count
    ) THEN
    RAISE EXCEPTION
      'existing monitor_history retention policy does not match the explicit % day configuration',
      retention_days;
  END IF;
END
$storage_preflight$;

-- Recover safely from a transaction-per-chunk build that was interrupted. A
-- valid object with one of these managed names is preserved and verified in
-- the postflight below.
DO $drop_interrupted_indexes$
DECLARE
  index_row record;
BEGIN
  FOR index_row IN
    SELECT namespace.nspname AS schema_name, relation.relname AS index_name
    FROM pg_class relation
    JOIN pg_namespace namespace
      ON namespace.oid = relation.relnamespace
    JOIN pg_index catalog_index
      ON catalog_index.indexrelid = relation.oid
    WHERE (NOT catalog_index.indisvalid OR NOT catalog_index.indisready)
      AND (
        (
          namespace.nspname = 'public'
          AND relation.relname = ANY(ARRAY[
            'idx_monitor_history_id_lookup',
            'idx_monitor_history_variant_group_time',
            'idx_monitor_history_country_time',
            'idx_monitor_history_asin_code_country_time',
            'idx_monitor_history_asin_country_time',
            'idx_monitor_history_notification_pending'
          ])
        )
        OR relation.relname LIKE 'idx_cagg_%'
      )
  LOOP
    EXECUTE format(
      'DROP INDEX %I.%I',
      index_row.schema_name,
      index_row.index_name
    );
  END LOOP;
END
$drop_interrupted_indexes$;

-- The option creates each child index in its own transaction, avoiding one
-- long transaction and long-lived lock across every existing chunk.
CREATE INDEX IF NOT EXISTS idx_monitor_history_id_lookup
  ON public.monitor_history (id)
  WITH (timescaledb.transaction_per_chunk);

CREATE INDEX IF NOT EXISTS idx_monitor_history_variant_group_time
  ON public.monitor_history (
    variant_group_id,
    check_time DESC NULLS LAST,
    id DESC NULLS LAST
  )
  WITH (timescaledb.transaction_per_chunk);

CREATE INDEX IF NOT EXISTS idx_monitor_history_country_time
  ON public.monitor_history (
    country,
    check_time DESC NULLS LAST,
    id DESC NULLS LAST
  )
  WITH (timescaledb.transaction_per_chunk);

CREATE INDEX IF NOT EXISTS idx_monitor_history_asin_code_country_time
  ON public.monitor_history (
    asin_code,
    country,
    check_time DESC NULLS LAST,
    id DESC NULLS LAST
  )
  WITH (timescaledb.transaction_per_chunk);

CREATE INDEX IF NOT EXISTS idx_monitor_history_asin_country_time
  ON public.monitor_history (
    asin_id,
    country,
    check_time DESC NULLS LAST,
    id DESC NULLS LAST
  )
  WITH (timescaledb.transaction_per_chunk);

CREATE INDEX IF NOT EXISTS idx_monitor_history_notification_pending
  ON public.monitor_history (country, check_time, id)
  WITH (timescaledb.transaction_per_chunk)
  WHERE is_broken = true AND notification_sent = false;

-- P1-T4a deliberately disabled automatic group indexes so this performance
-- gate can own and verify the exact inventory. Each first grouping key gets a
-- (key, time_slot) index for filtered range scans and ordered cursor reads.
CREATE INDEX IF NOT EXISTS idx_cagg_asin_hour_country_time
  ON public.monitor_history_cagg_asin_hour (country, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_asin_hour_asin_key_time
  ON public.monitor_history_cagg_asin_hour (asin_key, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_asin_day_country_time
  ON public.monitor_history_cagg_asin_day (country, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_asin_day_asin_key_time
  ON public.monitor_history_cagg_asin_day (asin_key, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_asin_month_country_time
  ON public.monitor_history_cagg_asin_month (country, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_asin_month_asin_key_time
  ON public.monitor_history_cagg_asin_month (asin_key, time_slot)
  WITH (timescaledb.transaction_per_chunk);

CREATE INDEX IF NOT EXISTS idx_cagg_dim_hour_country_time
  ON public.monitor_history_cagg_dim_hour (country, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_dim_hour_site_time
  ON public.monitor_history_cagg_dim_hour (site, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_dim_hour_brand_time
  ON public.monitor_history_cagg_dim_hour (brand, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_dim_hour_asin_key_time
  ON public.monitor_history_cagg_dim_hour (asin_key, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_dim_day_country_time
  ON public.monitor_history_cagg_dim_day (country, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_dim_day_site_time
  ON public.monitor_history_cagg_dim_day (site, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_dim_day_brand_time
  ON public.monitor_history_cagg_dim_day (brand, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_dim_day_asin_key_time
  ON public.monitor_history_cagg_dim_day (asin_key, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_dim_month_country_time
  ON public.monitor_history_cagg_dim_month (country, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_dim_month_site_time
  ON public.monitor_history_cagg_dim_month (site, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_dim_month_brand_time
  ON public.monitor_history_cagg_dim_month (brand, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_dim_month_asin_key_time
  ON public.monitor_history_cagg_dim_month (asin_key, time_slot)
  WITH (timescaledb.transaction_per_chunk);

CREATE INDEX IF NOT EXISTS idx_cagg_variant_hour_country_time
  ON public.monitor_history_cagg_variant_group_hour (country, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_variant_hour_group_time
  ON public.monitor_history_cagg_variant_group_hour (variant_group_id, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_variant_hour_name_time
  ON public.monitor_history_cagg_variant_group_hour (variant_group_name_snapshot, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_variant_hour_asin_key_time
  ON public.monitor_history_cagg_variant_group_hour (asin_key, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_variant_day_country_time
  ON public.monitor_history_cagg_variant_group_day (country, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_variant_day_group_time
  ON public.monitor_history_cagg_variant_group_day (variant_group_id, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_variant_day_name_time
  ON public.monitor_history_cagg_variant_group_day (variant_group_name_snapshot, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_variant_day_asin_key_time
  ON public.monitor_history_cagg_variant_group_day (asin_key, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_variant_month_country_time
  ON public.monitor_history_cagg_variant_group_month (country, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_variant_month_group_time
  ON public.monitor_history_cagg_variant_group_month (variant_group_id, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_variant_month_name_time
  ON public.monitor_history_cagg_variant_group_month (variant_group_name_snapshot, time_slot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_cagg_variant_month_asin_key_time
  ON public.monitor_history_cagg_variant_group_month (asin_key, time_slot)
  WITH (timescaledb.transaction_per_chunk);

BEGIN;

-- The primary key already covers check_time-first access. The six generated
-- hour/day/month index pairs are retired in favor of the nine CAGGs. Prefix
-- duplicates are retired only after their replacements above are valid.
DROP INDEX IF EXISTS public.idx_monitor_history_variant_group_id;
DROP INDEX IF EXISTS public.idx_monitor_history_asin_id;
DROP INDEX IF EXISTS public.idx_monitor_history_asin_code;
DROP INDEX IF EXISTS public.idx_monitor_history_check_time;
DROP INDEX IF EXISTS public.idx_monitor_history_country;
DROP INDEX IF EXISTS public.idx_monitor_history_country_check_time;
DROP INDEX IF EXISTS public.idx_monitor_history_variant_group_check_time_broken;
DROP INDEX IF EXISTS public.idx_monitor_history_country_check_time_broken;
DROP INDEX IF EXISTS public.idx_monitor_history_check_time_country_broken;
DROP INDEX IF EXISTS public.idx_monitor_history_asin_code_country_check_time;
DROP INDEX IF EXISTS public.idx_monitor_history_country_time_broken_asin;
DROP INDEX IF EXISTS public.idx_monitor_history_asin_country_check_time_broken;
DROP INDEX IF EXISTS public.idx_monitor_history_country_hour_site_brand;
DROP INDEX IF EXISTS public.idx_monitor_history_country_day_site_brand;
DROP INDEX IF EXISTS public.idx_monitor_history_country_month_site_brand;
DROP INDEX IF EXISTS public.idx_monitor_history_hour_country_asin;
DROP INDEX IF EXISTS public.idx_monitor_history_day_country_asin;
DROP INDEX IF EXISTS public.idx_monitor_history_month_country_asin;

-- Hypercore/columnstore aliases are the TimescaleDB 2.29.2 primary API. The
-- old timescaledb.compress names are intentionally not used here.
ALTER TABLE public.monitor_history SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'country,asin_id',
  timescaledb.orderby = 'check_time DESC,id DESC'
);

ALTER MATERIALIZED VIEW public.monitor_history_cagg_asin_hour SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'country,asin_key',
  timescaledb.orderby = 'time_slot DESC'
);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_asin_day SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'country,asin_key',
  timescaledb.orderby = 'time_slot DESC'
);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_asin_month SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'country,asin_key',
  timescaledb.orderby = 'time_slot DESC'
);

ALTER MATERIALIZED VIEW public.monitor_history_cagg_dim_hour SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'country,site,brand,asin_key',
  timescaledb.orderby = 'time_slot DESC'
);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_dim_day SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'country,site,brand,asin_key',
  timescaledb.orderby = 'time_slot DESC'
);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_dim_month SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'country,site,brand,asin_key',
  timescaledb.orderby = 'time_slot DESC'
);

ALTER MATERIALIZED VIEW public.monitor_history_cagg_variant_group_hour SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'country,variant_group_id,asin_key',
  timescaledb.orderby = 'time_slot DESC'
);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_variant_group_day SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'country,variant_group_id,asin_key',
  timescaledb.orderby = 'time_slot DESC'
);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_variant_group_month SET (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'country,variant_group_id,asin_key',
  timescaledb.orderby = 'time_slot DESC'
);

CALL add_columnstore_policy(
  'public.monitor_history'::regclass,
  after => INTERVAL '30 days',
  if_not_exists => true,
  schedule_interval => INTERVAL '1 day',
  initial_start => TIMESTAMPTZ '2026-01-01 00:00:00+08',
  timezone => 'Asia/Shanghai'
);

CALL add_columnstore_policy(
  'public.monitor_history_cagg_asin_hour'::regclass,
  after => INTERVAL '3 days',
  if_not_exists => true,
  schedule_interval => INTERVAL '1 hour',
  initial_start => TIMESTAMPTZ '2026-01-01 00:00:00+08',
  timezone => 'Asia/Shanghai'
);
CALL add_columnstore_policy(
  'public.monitor_history_cagg_dim_hour'::regclass,
  after => INTERVAL '3 days',
  if_not_exists => true,
  schedule_interval => INTERVAL '1 hour',
  initial_start => TIMESTAMPTZ '2026-01-01 00:00:00+08',
  timezone => 'Asia/Shanghai'
);
CALL add_columnstore_policy(
  'public.monitor_history_cagg_variant_group_hour'::regclass,
  after => INTERVAL '3 days',
  if_not_exists => true,
  schedule_interval => INTERVAL '1 hour',
  initial_start => TIMESTAMPTZ '2026-01-01 00:00:00+08',
  timezone => 'Asia/Shanghai'
);

CALL add_columnstore_policy(
  'public.monitor_history_cagg_asin_day'::regclass,
  after => INTERVAL '40 days',
  if_not_exists => true,
  schedule_interval => INTERVAL '1 day',
  initial_start => TIMESTAMPTZ '2026-01-01 00:00:00+08',
  timezone => 'Asia/Shanghai'
);
CALL add_columnstore_policy(
  'public.monitor_history_cagg_dim_day'::regclass,
  after => INTERVAL '40 days',
  if_not_exists => true,
  schedule_interval => INTERVAL '1 day',
  initial_start => TIMESTAMPTZ '2026-01-01 00:00:00+08',
  timezone => 'Asia/Shanghai'
);
CALL add_columnstore_policy(
  'public.monitor_history_cagg_variant_group_day'::regclass,
  after => INTERVAL '40 days',
  if_not_exists => true,
  schedule_interval => INTERVAL '1 day',
  initial_start => TIMESTAMPTZ '2026-01-01 00:00:00+08',
  timezone => 'Asia/Shanghai'
);

CALL add_columnstore_policy(
  'public.monitor_history_cagg_asin_month'::regclass,
  after => INTERVAL '800 days',
  if_not_exists => true,
  schedule_interval => INTERVAL '1 day',
  initial_start => TIMESTAMPTZ '2026-01-01 00:00:00+08',
  timezone => 'Asia/Shanghai'
);
CALL add_columnstore_policy(
  'public.monitor_history_cagg_dim_month'::regclass,
  after => INTERVAL '800 days',
  if_not_exists => true,
  schedule_interval => INTERVAL '1 day',
  initial_start => TIMESTAMPTZ '2026-01-01 00:00:00+08',
  timezone => 'Asia/Shanghai'
);
CALL add_columnstore_policy(
  'public.monitor_history_cagg_variant_group_month'::regclass,
  after => INTERVAL '800 days',
  if_not_exists => true,
  schedule_interval => INTERVAL '1 day',
  initial_start => TIMESTAMPTZ '2026-01-01 00:00:00+08',
  timezone => 'Asia/Shanghai'
);

DO $configure_retention$
DECLARE
  retention_days_text text := NULLIF(
    current_setting(
      'asin_monitor.monitor_history_retention_days',
      true
    ),
    ''
  );
  retention_days integer;
BEGIN
  IF retention_days_text IS NOT NULL THEN
    retention_days := retention_days_text::integer;
    PERFORM add_retention_policy(
      'public.monitor_history'::regclass,
      drop_after => make_interval(days => retention_days),
      if_not_exists => true,
      schedule_interval => INTERVAL '1 day',
      initial_start => TIMESTAMPTZ '2026-01-01 00:00:00+08',
      timezone => 'Asia/Shanghai'
    );
  END IF;
END
$configure_retention$;

DO $storage_postflight$
DECLARE
  retention_days_text text := NULLIF(
    current_setting(
      'asin_monitor.monitor_history_retention_days',
      true
    ),
    ''
  );
  retention_days integer;
  total_operational_index_count integer;
  matching_operational_index_count integer;
  legacy_index_count integer;
  matching_cagg_index_count integer;
  matching_cagg_time_index_count integer;
  total_cagg_index_count integer;
  matching_columnstore_setting_count integer;
  columnstore_policy_count integer;
  matching_columnstore_policy_count integer;
  retention_policy_count integer;
  matching_retention_policy_count integer;
BEGIN
  IF retention_days_text IS NOT NULL THEN
    retention_days := retention_days_text::integer;
  END IF;

  WITH expected_index(
    index_name,
    key_columns,
    sort_options,
    predicate
  ) AS (
    VALUES
      ('idx_monitor_history_id_lookup', ARRAY['id']::text[], ARRAY[0]::smallint[], ''),
      ('idx_monitor_history_variant_group_time', ARRAY['variant_group_id', 'check_time', 'id']::text[], ARRAY[0, 1, 1]::smallint[], ''),
      ('idx_monitor_history_country_time', ARRAY['country', 'check_time', 'id']::text[], ARRAY[0, 1, 1]::smallint[], ''),
      ('idx_monitor_history_asin_code_country_time', ARRAY['asin_code', 'country', 'check_time', 'id']::text[], ARRAY[0, 0, 1, 1]::smallint[], ''),
      ('idx_monitor_history_asin_country_time', ARRAY['asin_id', 'country', 'check_time', 'id']::text[], ARRAY[0, 0, 1, 1]::smallint[], ''),
      ('idx_monitor_history_status_interval_refresh', ARRAY['check_type', 'check_time', 'id']::text[], ARRAY[0, 0, 0]::smallint[], ''),
      ('idx_monitor_history_notification_pending', ARRAY['country', 'check_time', 'id']::text[], ARRAY[0, 0, 0]::smallint[], 'is_broken=trueandnotification_sent=false')
  ), actual_index AS (
    SELECT
      index_relation.relname AS index_name,
      ARRAY(
        SELECT attribute.attname::text
        FROM unnest(index_row.indkey) WITH ORDINALITY
          AS key_position(attnum, position)
        JOIN pg_attribute attribute
          ON attribute.attrelid = table_relation.oid
         AND attribute.attnum = key_position.attnum
        WHERE key_position.position <= index_row.indnkeyatts
        ORDER BY key_position.position
      ) AS key_columns,
      ARRAY(
        SELECT sort_option.option::smallint
        FROM unnest(index_row.indoption) WITH ORDINALITY
          AS sort_option(option, position)
        WHERE sort_option.position <= index_row.indnkeyatts
        ORDER BY sort_option.position
      ) AS sort_options,
      index_row.indisvalid,
      index_row.indisready,
      access_method.amname,
      lower(
        regexp_replace(
          COALESCE(
            pg_get_expr(
              index_row.indpred,
              index_row.indrelid,
              true
            ),
            ''
          ),
          '[()[:space:]]',
          '',
          'g'
        )
      ) AS predicate
    FROM pg_index index_row
    JOIN pg_class table_relation
      ON table_relation.oid = index_row.indrelid
    JOIN pg_namespace table_namespace
      ON table_namespace.oid = table_relation.relnamespace
    JOIN pg_class index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_am access_method
      ON access_method.oid = index_relation.relam
    WHERE table_namespace.nspname = 'public'
      AND table_relation.relname = 'monitor_history'
  )
  SELECT
    (
      SELECT COUNT(*)::integer
      FROM actual_index
      WHERE index_name LIKE 'idx_monitor_history_%'
    ),
    (
      SELECT COUNT(*)::integer
      FROM expected_index
      JOIN actual_index USING (
        index_name,
        key_columns,
        sort_options,
        predicate
      )
      WHERE actual_index.indisvalid
        AND actual_index.indisready
        AND actual_index.amname = 'btree'
    )
  INTO total_operational_index_count, matching_operational_index_count;

  IF total_operational_index_count <> 7
    OR matching_operational_index_count <> 7 THEN
    RAISE EXCEPTION
      'monitor_history operational index postflight mismatch (found %, matching %)',
      total_operational_index_count,
      matching_operational_index_count;
  END IF;

  SELECT COUNT(*)::integer
  INTO legacy_index_count
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'monitor_history'
    AND indexname IN (
      'idx_monitor_history_variant_group_id',
      'idx_monitor_history_asin_id',
      'idx_monitor_history_asin_code',
      'idx_monitor_history_check_time',
      'idx_monitor_history_country',
      'idx_monitor_history_country_check_time',
      'idx_monitor_history_variant_group_check_time_broken',
      'idx_monitor_history_country_check_time_broken',
      'idx_monitor_history_check_time_country_broken',
      'idx_monitor_history_asin_code_country_check_time',
      'idx_monitor_history_country_time_broken_asin',
      'idx_monitor_history_asin_country_check_time_broken',
      'idx_monitor_history_country_hour_site_brand',
      'idx_monitor_history_country_day_site_brand',
      'idx_monitor_history_country_month_site_brand',
      'idx_monitor_history_hour_country_asin',
      'idx_monitor_history_day_country_asin',
      'idx_monitor_history_month_country_asin'
    );

  IF legacy_index_count <> 0 THEN
    RAISE EXCEPTION
      'retired monitor_history Legacy indexes remain (found %)',
      legacy_index_count;
  END IF;

  WITH expected_first_key(family, first_key) AS (
    VALUES
      ('asin', 'country'),
      ('asin', 'asin_key'),
      ('dim', 'country'),
      ('dim', 'site'),
      ('dim', 'brand'),
      ('dim', 'asin_key'),
      ('variant_group', 'country'),
      ('variant_group', 'variant_group_id'),
      ('variant_group', 'variant_group_name_snapshot'),
      ('variant_group', 'asin_key')
  ), selected_cagg AS (
    SELECT
      aggregate_row.view_name,
      CASE
        WHEN aggregate_row.view_name LIKE 'monitor_history_cagg_asin_%'
          THEN 'asin'
        WHEN aggregate_row.view_name LIKE 'monitor_history_cagg_dim_%'
          THEN 'dim'
        ELSE 'variant_group'
      END AS family,
      format(
        '%I.%I',
        aggregate_row.materialization_hypertable_schema,
        aggregate_row.materialization_hypertable_name
      )::regclass AS materialization
    FROM timescaledb_information.continuous_aggregates aggregate_row
    WHERE aggregate_row.view_schema = 'public'
      AND aggregate_row.view_name LIKE 'monitor_history_cagg_%'
  ), actual_index AS (
    SELECT
      selected_cagg.view_name,
      selected_cagg.family,
      index_row.indexrelid,
      ARRAY_AGG(attribute.attname::text ORDER BY key_position.position)
        FILTER (
          WHERE key_position.position <= index_row.indnkeyatts
        ) AS key_columns,
      BOOL_AND(index_row.indisvalid AND index_row.indisready) AS is_ready,
      BOOL_AND(access_method.amname = 'btree') AS is_btree
    FROM selected_cagg
    JOIN pg_index index_row
      ON index_row.indrelid = selected_cagg.materialization
    JOIN pg_class index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_am access_method
      ON access_method.oid = index_relation.relam
    CROSS JOIN LATERAL
      unnest(index_row.indkey) WITH ORDINALITY
        AS key_position(attnum, position)
    JOIN pg_attribute attribute
      ON attribute.attrelid = selected_cagg.materialization
     AND attribute.attnum = key_position.attnum
    GROUP BY
      selected_cagg.view_name,
      selected_cagg.family,
      index_row.indexrelid
  ), expected_index AS (
    SELECT
      selected_cagg.view_name,
      ARRAY[expected_first_key.first_key, 'time_slot']::text[] AS key_columns
    FROM selected_cagg
    JOIN expected_first_key USING (family)
  )
  SELECT
    (SELECT COUNT(*)::integer FROM actual_index),
    (
      SELECT COUNT(*)::integer
      FROM actual_index
      JOIN expected_index USING (view_name, key_columns)
      WHERE actual_index.is_ready AND actual_index.is_btree
    ),
    (
      SELECT COUNT(*)::integer
      FROM actual_index
      WHERE actual_index.key_columns = ARRAY['time_slot']::text[]
        AND actual_index.is_ready
        AND actual_index.is_btree
    )
  INTO
    total_cagg_index_count,
    matching_cagg_index_count,
    matching_cagg_time_index_count
  ;

  IF total_cagg_index_count <> 39
    OR matching_cagg_index_count <> 30
    OR matching_cagg_time_index_count <> 9 THEN
    RAISE EXCEPTION
      'continuous aggregate index inventory mismatch (found %, matching group %, matching time %)',
      total_cagg_index_count,
      matching_cagg_index_count,
      matching_cagg_time_index_count;
  END IF;

  WITH expected_setting(
    view_name,
    segmentby,
    orderby
  ) AS (
    VALUES
      ('monitor_history', 'country,asin_id', 'check_time DESC,id DESC'),
      ('monitor_history_cagg_asin_hour', 'country,asin_key', 'time_slot DESC'),
      ('monitor_history_cagg_asin_day', 'country,asin_key', 'time_slot DESC'),
      ('monitor_history_cagg_asin_month', 'country,asin_key', 'time_slot DESC'),
      ('monitor_history_cagg_dim_hour', 'country,site,brand,asin_key', 'time_slot DESC'),
      ('monitor_history_cagg_dim_day', 'country,site,brand,asin_key', 'time_slot DESC'),
      ('monitor_history_cagg_dim_month', 'country,site,brand,asin_key', 'time_slot DESC'),
      ('monitor_history_cagg_variant_group_hour', 'country,variant_group_id,asin_key', 'time_slot DESC'),
      ('monitor_history_cagg_variant_group_day', 'country,variant_group_id,asin_key', 'time_slot DESC'),
      ('monitor_history_cagg_variant_group_month', 'country,variant_group_id,asin_key', 'time_slot DESC')
  ), selected_relation AS (
    SELECT
      expected_setting.*,
      'public.monitor_history'::regclass AS hypertable
    FROM expected_setting
    WHERE view_name = 'monitor_history'
    UNION ALL
    SELECT
      expected_setting.*,
      format(
        '%I.%I',
        aggregate_row.materialization_hypertable_schema,
        aggregate_row.materialization_hypertable_name
      )::regclass AS hypertable
    FROM expected_setting
    JOIN timescaledb_information.continuous_aggregates aggregate_row
      ON aggregate_row.view_schema = 'public'
     AND aggregate_row.view_name = expected_setting.view_name
  )
  SELECT COUNT(*)::integer
  INTO matching_columnstore_setting_count
  FROM selected_relation
  JOIN timescaledb_information.hypertable_columnstore_settings settings
    ON settings.hypertable = selected_relation.hypertable
   AND settings.segmentby = selected_relation.segmentby
   AND settings.orderby = selected_relation.orderby;

  IF matching_columnstore_setting_count <> 10 THEN
    RAISE EXCEPTION
      'columnstore setting postflight mismatch (matching %)',
      matching_columnstore_setting_count;
  END IF;

  WITH expected_policy(view_name, compress_after, schedule_interval) AS (
    VALUES
      ('monitor_history', INTERVAL '30 days', INTERVAL '1 day'),
      ('monitor_history_cagg_asin_hour', INTERVAL '3 days', INTERVAL '1 hour'),
      ('monitor_history_cagg_dim_hour', INTERVAL '3 days', INTERVAL '1 hour'),
      ('monitor_history_cagg_variant_group_hour', INTERVAL '3 days', INTERVAL '1 hour'),
      ('monitor_history_cagg_asin_day', INTERVAL '40 days', INTERVAL '1 day'),
      ('monitor_history_cagg_dim_day', INTERVAL '40 days', INTERVAL '1 day'),
      ('monitor_history_cagg_variant_group_day', INTERVAL '40 days', INTERVAL '1 day'),
      ('monitor_history_cagg_asin_month', INTERVAL '800 days', INTERVAL '1 day'),
      ('monitor_history_cagg_dim_month', INTERVAL '800 days', INTERVAL '1 day'),
      ('monitor_history_cagg_variant_group_month', INTERVAL '800 days', INTERVAL '1 day')
  ), selected_hypertable AS (
    SELECT
      expected_policy.*,
      hypertable.id AS hypertable_id
    FROM expected_policy
    JOIN _timescaledb_catalog.hypertable hypertable
      ON expected_policy.view_name = 'monitor_history'
     AND hypertable.schema_name = 'public'
     AND hypertable.table_name = 'monitor_history'
    UNION ALL
    SELECT
      expected_policy.*,
      hypertable.id AS hypertable_id
    FROM expected_policy
    JOIN timescaledb_information.continuous_aggregates aggregate_row
      ON aggregate_row.view_schema = 'public'
     AND aggregate_row.view_name = expected_policy.view_name
    JOIN _timescaledb_catalog.hypertable hypertable
      ON hypertable.schema_name = aggregate_row.materialization_hypertable_schema
     AND hypertable.table_name = aggregate_row.materialization_hypertable_name
  ), selected_job AS (
    SELECT
      selected_hypertable.*,
      jobs.schedule_interval AS actual_schedule_interval,
      jobs.scheduled,
      jobs.fixed_schedule,
      jobs.initial_start,
      jobs.config,
      catalog_job.timezone
    FROM selected_hypertable
    JOIN timescaledb_information.jobs jobs
      ON jobs.proc_name = 'policy_compression'
     AND (jobs.config ->> 'hypertable_id')::integer =
       selected_hypertable.hypertable_id
    JOIN _timescaledb_catalog.bgw_job catalog_job
      ON catalog_job.id = jobs.job_id
  )
  SELECT
    COUNT(*)::integer,
    COUNT(*) FILTER (
      WHERE (config ->> 'compress_after')::interval = compress_after
        AND actual_schedule_interval = schedule_interval
        AND scheduled
        AND fixed_schedule
        AND initial_start = TIMESTAMPTZ '2026-01-01 00:00:00+08'
        AND timezone = 'Asia/Shanghai'
    )::integer
  INTO columnstore_policy_count, matching_columnstore_policy_count
  FROM selected_job;

  IF columnstore_policy_count <> 10
    OR matching_columnstore_policy_count <> 10 THEN
    RAISE EXCEPTION
      'columnstore policy postflight mismatch (found %, matching %)',
      columnstore_policy_count,
      matching_columnstore_policy_count;
  END IF;

  SELECT
    COUNT(*)::integer,
    COUNT(*) FILTER (
      WHERE retention_days IS NOT NULL
        AND (jobs.config ->> 'drop_after')::interval =
          make_interval(days => retention_days)
        AND jobs.schedule_interval = INTERVAL '1 day'
        AND jobs.scheduled
        AND jobs.fixed_schedule
        AND jobs.initial_start = TIMESTAMPTZ '2026-01-01 00:00:00+08'
        AND catalog_job.timezone = 'Asia/Shanghai'
    )::integer
  INTO retention_policy_count, matching_retention_policy_count
  FROM timescaledb_information.jobs jobs
  JOIN _timescaledb_catalog.bgw_job catalog_job
    ON catalog_job.id = jobs.job_id
  JOIN _timescaledb_catalog.hypertable hypertable
    ON hypertable.id = (jobs.config ->> 'hypertable_id')::integer
  WHERE jobs.proc_name = 'policy_retention'
    AND hypertable.schema_name = 'public'
    AND hypertable.table_name = 'monitor_history';

  IF retention_days IS NULL AND retention_policy_count <> 0 THEN
    RAISE EXCEPTION
      'retention must remain disabled when no explicit retention days are configured';
  END IF;

  IF retention_days IS NOT NULL
    AND (
      retention_policy_count <> 1
      OR matching_retention_policy_count <> 1
    ) THEN
    RAISE EXCEPTION
      'retention policy postflight mismatch for % days (found %, matching %)',
      retention_days,
      retention_policy_count,
      matching_retention_policy_count;
  END IF;
END
$storage_postflight$;

COMMIT;
