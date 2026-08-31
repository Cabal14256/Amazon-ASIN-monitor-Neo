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
      CALL convert_to_rowstore(managed_chunk, if_compressed => true);
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
