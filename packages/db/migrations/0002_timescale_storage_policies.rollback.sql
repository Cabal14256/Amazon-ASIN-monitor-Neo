-- P1-T4b controlled rollback. Run only in a maintenance window after a fresh
-- backup. This cannot restore chunks already deleted by a retention policy.

SET TIME ZONE 'Asia/Shanghai';
SET search_path TO pg_catalog, public;
SET lock_timeout = '30s';
SET statement_timeout = 0;

SELECT remove_retention_policy(
  'public.monitor_history'::regclass,
  if_exists => true
);

CALL remove_columnstore_policy(
  'public.monitor_history'::regclass,
  if_exists => true
);
CALL remove_columnstore_policy('public.monitor_history_cagg_asin_hour'::regclass, if_exists => true);
CALL remove_columnstore_policy('public.monitor_history_cagg_asin_day'::regclass, if_exists => true);
CALL remove_columnstore_policy('public.monitor_history_cagg_asin_month'::regclass, if_exists => true);
CALL remove_columnstore_policy('public.monitor_history_cagg_dim_hour'::regclass, if_exists => true);
CALL remove_columnstore_policy('public.monitor_history_cagg_dim_day'::regclass, if_exists => true);
CALL remove_columnstore_policy('public.monitor_history_cagg_dim_month'::regclass, if_exists => true);
CALL remove_columnstore_policy('public.monitor_history_cagg_variant_group_hour'::regclass, if_exists => true);
CALL remove_columnstore_policy('public.monitor_history_cagg_variant_group_day'::regclass, if_exists => true);
CALL remove_columnstore_policy('public.monitor_history_cagg_variant_group_month'::regclass, if_exists => true);

DO $convert_managed_chunks_to_rowstore$
DECLARE
  managed_relation regclass;
  managed_chunk regclass;
BEGIN
  FOREACH managed_relation IN ARRAY ARRAY[
    'public.monitor_history'::regclass,
    'public.monitor_history_cagg_asin_hour'::regclass,
    'public.monitor_history_cagg_asin_day'::regclass,
    'public.monitor_history_cagg_asin_month'::regclass,
    'public.monitor_history_cagg_dim_hour'::regclass,
    'public.monitor_history_cagg_dim_day'::regclass,
    'public.monitor_history_cagg_dim_month'::regclass,
    'public.monitor_history_cagg_variant_group_hour'::regclass,
    'public.monitor_history_cagg_variant_group_day'::regclass,
    'public.monitor_history_cagg_variant_group_month'::regclass
  ]
  LOOP
    FOR managed_chunk IN SELECT show_chunks(managed_relation)
    LOOP
      CALL convert_to_rowstore(managed_chunk, if_columnstore => true);
    END LOOP;
  END LOOP;
END
$convert_managed_chunks_to_rowstore$;

ALTER TABLE public.monitor_history SET (timescaledb.enable_columnstore = false);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_asin_hour SET (timescaledb.enable_columnstore = false);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_asin_day SET (timescaledb.enable_columnstore = false);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_asin_month SET (timescaledb.enable_columnstore = false);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_dim_hour SET (timescaledb.enable_columnstore = false);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_dim_day SET (timescaledb.enable_columnstore = false);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_dim_month SET (timescaledb.enable_columnstore = false);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_variant_group_hour SET (timescaledb.enable_columnstore = false);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_variant_group_day SET (timescaledb.enable_columnstore = false);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_variant_group_month SET (timescaledb.enable_columnstore = false);

DO $drop_cagg_indexes$
DECLARE
  managed_index record;
BEGIN
  FOR managed_index IN
    SELECT namespace.nspname AS schema_name, relation.relname AS index_name
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_index catalog_index ON catalog_index.indexrelid = relation.oid
    WHERE relation.relkind = 'i'
      AND relation.relname = ANY(ARRAY[
        'idx_cagg_asin_hour_country_time',
        'idx_cagg_asin_hour_asin_key_time',
        'idx_cagg_asin_day_country_time',
        'idx_cagg_asin_day_asin_key_time',
        'idx_cagg_asin_month_country_time',
        'idx_cagg_asin_month_asin_key_time',
        'idx_cagg_dim_hour_country_time',
        'idx_cagg_dim_hour_site_time',
        'idx_cagg_dim_hour_brand_time',
        'idx_cagg_dim_hour_asin_key_time',
        'idx_cagg_dim_day_country_time',
        'idx_cagg_dim_day_site_time',
        'idx_cagg_dim_day_brand_time',
        'idx_cagg_dim_day_asin_key_time',
        'idx_cagg_dim_month_country_time',
        'idx_cagg_dim_month_site_time',
        'idx_cagg_dim_month_brand_time',
        'idx_cagg_dim_month_asin_key_time',
        'idx_cagg_variant_hour_country_time',
        'idx_cagg_variant_hour_group_time',
        'idx_cagg_variant_hour_name_time',
        'idx_cagg_variant_hour_asin_key_time',
        'idx_cagg_variant_day_country_time',
        'idx_cagg_variant_day_group_time',
        'idx_cagg_variant_day_name_time',
        'idx_cagg_variant_day_asin_key_time',
        'idx_cagg_variant_month_country_time',
        'idx_cagg_variant_month_group_time',
        'idx_cagg_variant_month_name_time',
        'idx_cagg_variant_month_asin_key_time'
      ])
      AND catalog_index.indrelid IN (
        SELECT format(
          '%I.%I',
          aggregate_row.materialization_hypertable_schema,
          aggregate_row.materialization_hypertable_name
        )::regclass
        FROM timescaledb_information.continuous_aggregates aggregate_row
        WHERE aggregate_row.view_schema = 'public'
          AND aggregate_row.view_name = ANY(ARRAY[
            'monitor_history_cagg_asin_hour',
            'monitor_history_cagg_asin_day',
            'monitor_history_cagg_asin_month',
            'monitor_history_cagg_dim_hour',
            'monitor_history_cagg_dim_day',
            'monitor_history_cagg_dim_month',
            'monitor_history_cagg_variant_group_hour',
            'monitor_history_cagg_variant_group_day',
            'monitor_history_cagg_variant_group_month'
          ])
      )
  LOOP
    EXECUTE format(
      'DROP INDEX %I.%I',
      managed_index.schema_name,
      managed_index.index_name
    );
  END LOOP;
END
$drop_cagg_indexes$;

DROP INDEX IF EXISTS public.idx_monitor_history_id_lookup;
DROP INDEX IF EXISTS public.idx_monitor_history_variant_group_time;
DROP INDEX IF EXISTS public.idx_monitor_history_country_time;
DROP INDEX IF EXISTS public.idx_monitor_history_asin_code_country_time;
DROP INDEX IF EXISTS public.idx_monitor_history_asin_country_time;
DROP INDEX IF EXISTS public.idx_monitor_history_notification_pending;

-- transaction_per_chunk commits child indexes independently. If a prior
-- rollback was interrupted, remove any invalid/not-ready managed parent before
-- rebuilding so IF NOT EXISTS cannot preserve a partially installed index.
DO $drop_interrupted_legacy_indexes$
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
    WHERE namespace.nspname = 'public'
      AND catalog_index.indrelid = 'public.monitor_history'::regclass
      AND (NOT catalog_index.indisvalid OR NOT catalog_index.indisready)
      AND relation.relname = ANY(ARRAY[
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
        'idx_monitor_history_month_country_asin',
        'idx_monitor_history_status_interval_refresh'
      ])
  LOOP
    EXECUTE format(
      'DROP INDEX %I.%I',
      index_row.schema_name,
      index_row.index_name
    );
  END LOOP;
END
$drop_interrupted_legacy_indexes$;

CREATE INDEX IF NOT EXISTS idx_monitor_history_variant_group_id
  ON public.monitor_history (variant_group_id)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_monitor_history_asin_id
  ON public.monitor_history (asin_id)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_monitor_history_asin_code
  ON public.monitor_history (asin_code)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_monitor_history_check_time
  ON public.monitor_history (check_time)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_monitor_history_country
  ON public.monitor_history (country)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_monitor_history_country_check_time
  ON public.monitor_history (country, check_time)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_monitor_history_variant_group_check_time_broken
  ON public.monitor_history (variant_group_id, check_time, is_broken)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_monitor_history_country_check_time_broken
  ON public.monitor_history (country, check_time, is_broken)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_monitor_history_check_time_country_broken
  ON public.monitor_history (check_time, country, is_broken)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_monitor_history_asin_code_country_check_time
  ON public.monitor_history (asin_code, country, check_time)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_monitor_history_country_time_broken_asin
  ON public.monitor_history (country, check_time, is_broken, asin_id)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_monitor_history_asin_country_check_time_broken
  ON public.monitor_history (asin_id, country, check_time, is_broken)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_monitor_history_country_hour_site_brand
  ON public.monitor_history (country, hour_ts, site_snapshot, brand_snapshot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_monitor_history_country_day_site_brand
  ON public.monitor_history (country, day_ts, site_snapshot, brand_snapshot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_monitor_history_country_month_site_brand
  ON public.monitor_history (country, month_ts, site_snapshot, brand_snapshot)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_monitor_history_hour_country_asin
  ON public.monitor_history (hour_ts, country, asin_id, asin_code, is_broken)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_monitor_history_day_country_asin
  ON public.monitor_history (day_ts, country, asin_id, asin_code, is_broken)
  WITH (timescaledb.transaction_per_chunk);
CREATE INDEX IF NOT EXISTS idx_monitor_history_month_country_asin
  ON public.monitor_history (month_ts, country, asin_id, asin_code, is_broken)
  WITH (timescaledb.transaction_per_chunk);

CREATE INDEX IF NOT EXISTS idx_monitor_history_status_interval_refresh
  ON public.monitor_history (check_type, check_time, id)
  WITH (timescaledb.transaction_per_chunk);

DO $rollback_index_postflight$
DECLARE
  total_legacy_index_count integer;
  matching_legacy_index_count integer;
BEGIN
  WITH expected_index(
    index_name,
    key_columns,
    sort_options,
    predicate
  ) AS (
    VALUES
      ('idx_monitor_history_variant_group_id', ARRAY['variant_group_id']::text[], ARRAY[0]::smallint[], ''),
      ('idx_monitor_history_asin_id', ARRAY['asin_id']::text[], ARRAY[0]::smallint[], ''),
      ('idx_monitor_history_asin_code', ARRAY['asin_code']::text[], ARRAY[0]::smallint[], ''),
      ('idx_monitor_history_check_time', ARRAY['check_time']::text[], ARRAY[0]::smallint[], ''),
      ('idx_monitor_history_country', ARRAY['country']::text[], ARRAY[0]::smallint[], ''),
      ('idx_monitor_history_country_check_time', ARRAY['country', 'check_time']::text[], ARRAY[0, 0]::smallint[], ''),
      ('idx_monitor_history_variant_group_check_time_broken', ARRAY['variant_group_id', 'check_time', 'is_broken']::text[], ARRAY[0, 0, 0]::smallint[], ''),
      ('idx_monitor_history_country_check_time_broken', ARRAY['country', 'check_time', 'is_broken']::text[], ARRAY[0, 0, 0]::smallint[], ''),
      ('idx_monitor_history_check_time_country_broken', ARRAY['check_time', 'country', 'is_broken']::text[], ARRAY[0, 0, 0]::smallint[], ''),
      ('idx_monitor_history_asin_code_country_check_time', ARRAY['asin_code', 'country', 'check_time']::text[], ARRAY[0, 0, 0]::smallint[], ''),
      ('idx_monitor_history_country_time_broken_asin', ARRAY['country', 'check_time', 'is_broken', 'asin_id']::text[], ARRAY[0, 0, 0, 0]::smallint[], ''),
      ('idx_monitor_history_asin_country_check_time_broken', ARRAY['asin_id', 'country', 'check_time', 'is_broken']::text[], ARRAY[0, 0, 0, 0]::smallint[], ''),
      ('idx_monitor_history_country_hour_site_brand', ARRAY['country', 'hour_ts', 'site_snapshot', 'brand_snapshot']::text[], ARRAY[0, 0, 0, 0]::smallint[], ''),
      ('idx_monitor_history_country_day_site_brand', ARRAY['country', 'day_ts', 'site_snapshot', 'brand_snapshot']::text[], ARRAY[0, 0, 0, 0]::smallint[], ''),
      ('idx_monitor_history_country_month_site_brand', ARRAY['country', 'month_ts', 'site_snapshot', 'brand_snapshot']::text[], ARRAY[0, 0, 0, 0]::smallint[], ''),
      ('idx_monitor_history_hour_country_asin', ARRAY['hour_ts', 'country', 'asin_id', 'asin_code', 'is_broken']::text[], ARRAY[0, 0, 0, 0, 0]::smallint[], ''),
      ('idx_monitor_history_day_country_asin', ARRAY['day_ts', 'country', 'asin_id', 'asin_code', 'is_broken']::text[], ARRAY[0, 0, 0, 0, 0]::smallint[], ''),
      ('idx_monitor_history_month_country_asin', ARRAY['month_ts', 'country', 'asin_id', 'asin_code', 'is_broken']::text[], ARRAY[0, 0, 0, 0, 0]::smallint[], ''),
      ('idx_monitor_history_status_interval_refresh', ARRAY['check_type', 'check_time', 'id']::text[], ARRAY[0, 0, 0]::smallint[], '')
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
      index_row.indisprimary,
      index_row.indisunique,
      index_row.indnkeyatts,
      index_row.indnatts,
      access_method.amname,
      lower(
        regexp_replace(
          COALESCE(
            pg_get_expr(index_row.indpred, index_row.indrelid, true),
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
      WHERE NOT indisprimary
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
        AND NOT actual_index.indisprimary
        AND NOT actual_index.indisunique
        AND actual_index.indnkeyatts = cardinality(expected_index.key_columns)
        AND actual_index.indnatts = cardinality(expected_index.key_columns)
        AND actual_index.amname = 'btree'
    )
  INTO total_legacy_index_count, matching_legacy_index_count;

  IF total_legacy_index_count <> 19
    OR matching_legacy_index_count <> 19 THEN
    RAISE EXCEPTION
      'monitor_history Legacy rollback index postflight mismatch (found %, matching %)',
      total_legacy_index_count,
      matching_legacy_index_count;
  END IF;
END
$rollback_index_postflight$;
