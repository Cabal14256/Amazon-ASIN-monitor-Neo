-- P1-T4a: convert monitor_history to a Timescale hypertable and create the
-- read-only continuous-aggregate projection. The legacy aggregate tables and
-- analytics_refresh_watermark intentionally remain writable until cutover.

SET TIME ZONE 'Asia/Shanghai';
SET lock_timeout = '30s';
SET statement_timeout = 0;

BEGIN;

LOCK TABLE public.monitor_history IN ACCESS EXCLUSIVE MODE;

DO $migration$
DECLARE
  extension_version text;
  already_hypertable boolean;
  primary_key_columns text[];
  descendant_count integer;
BEGIN
  SELECT extversion
  INTO extension_version
  FROM pg_extension
  WHERE extname = 'timescaledb';

  IF extension_version IS NULL THEN
    RAISE EXCEPTION '0001_timescale_aggregates requires the timescaledb extension';
  END IF;

  IF to_regclass('public.monitor_history') IS NULL THEN
    RAISE EXCEPTION '0001_timescale_aggregates requires public.monitor_history';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM timescaledb_information.hypertables
    WHERE hypertable_schema = 'public'
      AND hypertable_name = 'monitor_history'
  )
  INTO already_hypertable;

  IF NOT already_hypertable THEN
    SELECT COUNT(*)::integer
    INTO descendant_count
    FROM pg_inherits
    WHERE inhparent = 'public.monitor_history'::regclass;

    IF descendant_count <> 0 THEN
      RAISE EXCEPTION
        'refusing to convert public.monitor_history because it already has % inheritance descendants',
        descendant_count;
    END IF;
  END IF;

  SELECT ARRAY_AGG(attribute.attname::text ORDER BY key.position)
  INTO primary_key_columns
  FROM pg_constraint constraint_row
  CROSS JOIN LATERAL
    unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, position)
  JOIN pg_attribute attribute
    ON attribute.attrelid = constraint_row.conrelid
   AND attribute.attnum = key.attnum
  WHERE constraint_row.conrelid = 'public.monitor_history'::regclass
    AND constraint_row.contype = 'p';

  IF primary_key_columns = ARRAY['id']::text[] THEN
    IF already_hypertable THEN
      RAISE EXCEPTION
        'hypertable public.monitor_history still has the incompatible legacy primary key';
    END IF;
    ALTER TABLE public.monitor_history
      DROP CONSTRAINT monitor_history_pkey;
    ALTER TABLE public.monitor_history
      ADD CONSTRAINT monitor_history_pkey PRIMARY KEY (check_time, id);
  ELSIF primary_key_columns IS DISTINCT FROM ARRAY['check_time', 'id']::text[] THEN
    RAISE EXCEPTION
      'unexpected primary key on public.monitor_history: %',
      primary_key_columns;
  END IF;

  IF NOT already_hypertable THEN
    PERFORM create_hypertable(
      'public.monitor_history'::regclass,
      by_range('check_time', INTERVAL '7 days'),
      create_default_indexes => false,
      if_not_exists => false,
      migrate_data => true
    );
  END IF;
END
$migration$;

DO $postflight$
DECLARE
  dimension_count integer;
  actual_interval interval;
BEGIN
  SELECT COUNT(*)::integer, MAX(time_interval)
  INTO dimension_count, actual_interval
  FROM timescaledb_information.dimensions
  WHERE hypertable_schema = 'public'
    AND hypertable_name = 'monitor_history'
    AND dimension_type = 'Time'
    AND column_name = 'check_time';

  IF dimension_count <> 1 OR actual_interval IS DISTINCT FROM INTERVAL '7 days' THEN
    RAISE EXCEPTION
      'public.monitor_history hypertable dimension mismatch (count %, interval %)',
      dimension_count,
      actual_interval;
  END IF;
END
$postflight$;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.monitor_history_cagg_asin_hour
WITH (
  timescaledb.continuous,
  timescaledb.materialized_only = true,
  timescaledb.create_group_indexes = false
) AS
SELECT
  time_bucket(INTERVAL '1 hour', check_time) AS time_slot,
  country,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id) AS asin_key,
  COUNT(*) AS check_count,
  COUNT(*) FILTER (WHERE is_broken IS TRUE) AS broken_count,
  BOOL_OR(is_broken IS TRUE) AS has_broken,
  BOOL_OR(
    CASE
      WHEN country = 'US' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 9
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 12
      WHEN country = 'UK' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 22
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 2
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 3
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
      WHEN country IN ('DE', 'FR', 'ES', 'IT') THEN
        EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 20
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 5
      ELSE false
    END
  ) AS has_peak,
  MIN(check_time) AS first_check_time,
  MAX(check_time) AS last_check_time
FROM public.monitor_history
WHERE check_type = 'ASIN'
  AND (asin_id IS NOT NULL OR NULLIF(asin_code, '') IS NOT NULL)
GROUP BY
  time_bucket(INTERVAL '1 hour', check_time),
  country,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id)
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.monitor_history_cagg_asin_day
WITH (
  timescaledb.continuous,
  timescaledb.materialized_only = true,
  timescaledb.create_group_indexes = false
) AS
SELECT
  time_bucket(INTERVAL '1 day', check_time) AS time_slot,
  country,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id) AS asin_key,
  COUNT(*) AS check_count,
  COUNT(*) FILTER (WHERE is_broken IS TRUE) AS broken_count,
  BOOL_OR(is_broken IS TRUE) AS has_broken,
  BOOL_OR(
    CASE
      WHEN country = 'US' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 9
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 12
      WHEN country = 'UK' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 22
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 2
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 3
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
      WHEN country IN ('DE', 'FR', 'ES', 'IT') THEN
        EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 20
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 5
      ELSE false
    END
  ) AS has_peak,
  MIN(check_time) AS first_check_time,
  MAX(check_time) AS last_check_time
FROM public.monitor_history
WHERE check_type = 'ASIN'
  AND (asin_id IS NOT NULL OR NULLIF(asin_code, '') IS NOT NULL)
GROUP BY
  time_bucket(INTERVAL '1 day', check_time),
  country,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id)
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.monitor_history_cagg_asin_month
WITH (
  timescaledb.continuous,
  timescaledb.materialized_only = true,
  timescaledb.create_group_indexes = false
) AS
SELECT
  time_bucket(INTERVAL '1 month', check_time) AS time_slot,
  country,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id) AS asin_key,
  COUNT(*) AS check_count,
  COUNT(*) FILTER (WHERE is_broken IS TRUE) AS broken_count,
  BOOL_OR(is_broken IS TRUE) AS has_broken,
  BOOL_OR(
    CASE
      WHEN country = 'US' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 9
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 12
      WHEN country = 'UK' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 22
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 2
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 3
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
      WHEN country IN ('DE', 'FR', 'ES', 'IT') THEN
        EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 20
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 5
      ELSE false
    END
  ) AS has_peak,
  MIN(check_time) AS first_check_time,
  MAX(check_time) AS last_check_time
FROM public.monitor_history
WHERE check_type = 'ASIN'
  AND (asin_id IS NOT NULL OR NULLIF(asin_code, '') IS NOT NULL)
GROUP BY
  time_bucket(INTERVAL '1 month', check_time),
  country,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id)
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.monitor_history_cagg_dim_hour
WITH (
  timescaledb.continuous,
  timescaledb.materialized_only = true,
  timescaledb.create_group_indexes = false
) AS
SELECT
  time_bucket(INTERVAL '1 hour', check_time) AS time_slot,
  country,
  COALESCE(site_snapshot, '') AS site,
  COALESCE(brand_snapshot, '') AS brand,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id) AS asin_key,
  COUNT(*) AS check_count,
  COUNT(*) FILTER (WHERE is_broken IS TRUE) AS broken_count,
  BOOL_OR(is_broken IS TRUE) AS has_broken,
  BOOL_OR(
    CASE
      WHEN country = 'US' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 9
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 12
      WHEN country = 'UK' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 22
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 2
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 3
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
      WHEN country IN ('DE', 'FR', 'ES', 'IT') THEN
        EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 20
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 5
      ELSE false
    END
  ) AS has_peak,
  MIN(check_time) AS first_check_time,
  MAX(check_time) AS last_check_time
FROM public.monitor_history
WHERE check_type = 'ASIN'
  AND (asin_id IS NOT NULL OR NULLIF(asin_code, '') IS NOT NULL)
GROUP BY
  time_bucket(INTERVAL '1 hour', check_time),
  country,
  COALESCE(site_snapshot, ''),
  COALESCE(brand_snapshot, ''),
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id)
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.monitor_history_cagg_dim_day
WITH (
  timescaledb.continuous,
  timescaledb.materialized_only = true,
  timescaledb.create_group_indexes = false
) AS
SELECT
  time_bucket(INTERVAL '1 day', check_time) AS time_slot,
  country,
  COALESCE(site_snapshot, '') AS site,
  COALESCE(brand_snapshot, '') AS brand,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id) AS asin_key,
  COUNT(*) AS check_count,
  COUNT(*) FILTER (WHERE is_broken IS TRUE) AS broken_count,
  BOOL_OR(is_broken IS TRUE) AS has_broken,
  BOOL_OR(
    CASE
      WHEN country = 'US' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 9
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 12
      WHEN country = 'UK' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 22
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 2
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 3
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
      WHEN country IN ('DE', 'FR', 'ES', 'IT') THEN
        EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 20
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 5
      ELSE false
    END
  ) AS has_peak,
  MIN(check_time) AS first_check_time,
  MAX(check_time) AS last_check_time
FROM public.monitor_history
WHERE check_type = 'ASIN'
  AND (asin_id IS NOT NULL OR NULLIF(asin_code, '') IS NOT NULL)
GROUP BY
  time_bucket(INTERVAL '1 day', check_time),
  country,
  COALESCE(site_snapshot, ''),
  COALESCE(brand_snapshot, ''),
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id)
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.monitor_history_cagg_dim_month
WITH (
  timescaledb.continuous,
  timescaledb.materialized_only = true,
  timescaledb.create_group_indexes = false
) AS
SELECT
  time_bucket(INTERVAL '1 month', check_time) AS time_slot,
  country,
  COALESCE(site_snapshot, '') AS site,
  COALESCE(brand_snapshot, '') AS brand,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id) AS asin_key,
  COUNT(*) AS check_count,
  COUNT(*) FILTER (WHERE is_broken IS TRUE) AS broken_count,
  BOOL_OR(is_broken IS TRUE) AS has_broken,
  BOOL_OR(
    CASE
      WHEN country = 'US' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 9
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 12
      WHEN country = 'UK' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 22
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 2
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 3
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
      WHEN country IN ('DE', 'FR', 'ES', 'IT') THEN
        EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 20
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 5
      ELSE false
    END
  ) AS has_peak,
  MIN(check_time) AS first_check_time,
  MAX(check_time) AS last_check_time
FROM public.monitor_history
WHERE check_type = 'ASIN'
  AND (asin_id IS NOT NULL OR NULLIF(asin_code, '') IS NOT NULL)
GROUP BY
  time_bucket(INTERVAL '1 month', check_time),
  country,
  COALESCE(site_snapshot, ''),
  COALESCE(brand_snapshot, ''),
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id)
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.monitor_history_cagg_variant_group_hour
WITH (
  timescaledb.continuous,
  timescaledb.materialized_only = true,
  timescaledb.create_group_indexes = false
) AS
SELECT
  time_bucket(INTERVAL '1 hour', check_time) AS time_slot,
  country,
  variant_group_id,
  MAX(NULLIF(variant_group_name, '')) AS variant_group_name_snapshot,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id) AS asin_key,
  COUNT(*) AS check_count,
  COUNT(*) FILTER (WHERE is_broken IS TRUE) AS broken_count,
  BOOL_OR(is_broken IS TRUE) AS has_broken,
  BOOL_OR(
    CASE
      WHEN country = 'US' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 9
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 12
      WHEN country = 'UK' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 22
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 2
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 3
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
      WHEN country IN ('DE', 'FR', 'ES', 'IT') THEN
        EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 20
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 5
      ELSE false
    END
  ) AS has_peak,
  MIN(check_time) AS first_check_time,
  MAX(check_time) AS last_check_time
FROM public.monitor_history
WHERE check_type = 'ASIN'
  AND variant_group_id IS NOT NULL
  AND (asin_id IS NOT NULL OR NULLIF(asin_code, '') IS NOT NULL)
GROUP BY
  time_bucket(INTERVAL '1 hour', check_time),
  country,
  variant_group_id,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id)
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.monitor_history_cagg_variant_group_day
WITH (
  timescaledb.continuous,
  timescaledb.materialized_only = true,
  timescaledb.create_group_indexes = false
) AS
SELECT
  time_bucket(INTERVAL '1 day', check_time) AS time_slot,
  country,
  variant_group_id,
  MAX(NULLIF(variant_group_name, '')) AS variant_group_name_snapshot,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id) AS asin_key,
  COUNT(*) AS check_count,
  COUNT(*) FILTER (WHERE is_broken IS TRUE) AS broken_count,
  BOOL_OR(is_broken IS TRUE) AS has_broken,
  BOOL_OR(
    CASE
      WHEN country = 'US' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 9
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 12
      WHEN country = 'UK' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 22
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 2
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 3
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
      WHEN country IN ('DE', 'FR', 'ES', 'IT') THEN
        EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 20
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 5
      ELSE false
    END
  ) AS has_peak,
  MIN(check_time) AS first_check_time,
  MAX(check_time) AS last_check_time
FROM public.monitor_history
WHERE check_type = 'ASIN'
  AND variant_group_id IS NOT NULL
  AND (asin_id IS NOT NULL OR NULLIF(asin_code, '') IS NOT NULL)
GROUP BY
  time_bucket(INTERVAL '1 day', check_time),
  country,
  variant_group_id,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id)
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.monitor_history_cagg_variant_group_month
WITH (
  timescaledb.continuous,
  timescaledb.materialized_only = true,
  timescaledb.create_group_indexes = false
) AS
SELECT
  time_bucket(INTERVAL '1 month', check_time) AS time_slot,
  country,
  variant_group_id,
  MAX(NULLIF(variant_group_name, '')) AS variant_group_name_snapshot,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id) AS asin_key,
  COUNT(*) AS check_count,
  COUNT(*) FILTER (WHERE is_broken IS TRUE) AS broken_count,
  BOOL_OR(is_broken IS TRUE) AS has_broken,
  BOOL_OR(
    CASE
      WHEN country = 'US' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 9
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 12
      WHEN country = 'UK' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 22
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 2
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 3
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
      WHEN country IN ('DE', 'FR', 'ES', 'IT') THEN
        EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 20
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 5
      ELSE false
    END
  ) AS has_peak,
  MIN(check_time) AS first_check_time,
  MAX(check_time) AS last_check_time
FROM public.monitor_history
WHERE check_type = 'ASIN'
  AND variant_group_id IS NOT NULL
  AND (asin_id IS NOT NULL OR NULLIF(asin_code, '') IS NOT NULL)
GROUP BY
  time_bucket(INTERVAL '1 month', check_time),
  country,
  variant_group_id,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id)
WITH NO DATA;

ALTER MATERIALIZED VIEW public.monitor_history_cagg_asin_hour
  SET (timescaledb.materialized_only = true);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_asin_day
  SET (timescaledb.materialized_only = true);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_asin_month
  SET (timescaledb.materialized_only = true);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_dim_hour
  SET (timescaledb.materialized_only = true);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_dim_day
  SET (timescaledb.materialized_only = true);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_dim_month
  SET (timescaledb.materialized_only = true);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_variant_group_hour
  SET (timescaledb.materialized_only = true);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_variant_group_day
  SET (timescaledb.materialized_only = true);
ALTER MATERIALIZED VIEW public.monitor_history_cagg_variant_group_month
  SET (timescaledb.materialized_only = true);

CREATE OR REPLACE VIEW public.monitor_history_agg_v2 AS
SELECT 'hour'::varchar(5) AS granularity, *
FROM public.monitor_history_cagg_asin_hour
UNION ALL
SELECT 'day'::varchar(5) AS granularity, *
FROM public.monitor_history_cagg_asin_day
UNION ALL
SELECT 'month'::varchar(5) AS granularity, *
FROM public.monitor_history_cagg_asin_month;

CREATE OR REPLACE VIEW public.monitor_history_agg_dim_v2 AS
SELECT 'hour'::varchar(5) AS granularity, *
FROM public.monitor_history_cagg_dim_hour
UNION ALL
SELECT 'day'::varchar(5) AS granularity, *
FROM public.monitor_history_cagg_dim_day
UNION ALL
SELECT 'month'::varchar(5) AS granularity, *
FROM public.monitor_history_cagg_dim_month;

CREATE OR REPLACE VIEW public.monitor_history_agg_variant_group_v2 AS
SELECT
  'hour'::varchar(5) AS granularity,
  aggregate_row.time_slot,
  aggregate_row.country,
  aggregate_row.variant_group_id,
  COALESCE(
    aggregate_row.variant_group_name_snapshot,
    NULLIF(variant_group.name, ''),
    ''
  ) AS variant_group_name,
  aggregate_row.asin_key,
  aggregate_row.check_count,
  aggregate_row.broken_count,
  aggregate_row.has_broken,
  aggregate_row.has_peak,
  aggregate_row.first_check_time,
  aggregate_row.last_check_time
FROM public.monitor_history_cagg_variant_group_hour aggregate_row
LEFT JOIN public.variant_groups variant_group
  ON variant_group.id = aggregate_row.variant_group_id
UNION ALL
SELECT
  'day'::varchar(5) AS granularity,
  aggregate_row.time_slot,
  aggregate_row.country,
  aggregate_row.variant_group_id,
  COALESCE(
    aggregate_row.variant_group_name_snapshot,
    NULLIF(variant_group.name, ''),
    ''
  ) AS variant_group_name,
  aggregate_row.asin_key,
  aggregate_row.check_count,
  aggregate_row.broken_count,
  aggregate_row.has_broken,
  aggregate_row.has_peak,
  aggregate_row.first_check_time,
  aggregate_row.last_check_time
FROM public.monitor_history_cagg_variant_group_day aggregate_row
LEFT JOIN public.variant_groups variant_group
  ON variant_group.id = aggregate_row.variant_group_id
UNION ALL
SELECT
  'month'::varchar(5) AS granularity,
  aggregate_row.time_slot,
  aggregate_row.country,
  aggregate_row.variant_group_id,
  COALESCE(
    aggregate_row.variant_group_name_snapshot,
    NULLIF(variant_group.name, ''),
    ''
  ) AS variant_group_name,
  aggregate_row.asin_key,
  aggregate_row.check_count,
  aggregate_row.broken_count,
  aggregate_row.has_broken,
  aggregate_row.has_peak,
  aggregate_row.first_check_time,
  aggregate_row.last_check_time
FROM public.monitor_history_cagg_variant_group_month aggregate_row
LEFT JOIN public.variant_groups variant_group
  ON variant_group.id = aggregate_row.variant_group_id;

SELECT add_continuous_aggregate_policy(
  'public.monitor_history_cagg_asin_hour'::regclass,
  start_offset => INTERVAL '49 hours',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '10 minutes',
  if_not_exists => true,
  initial_start => TIMESTAMPTZ '2026-01-01 00:00:00+08',
  timezone => 'Asia/Shanghai'
);
SELECT add_continuous_aggregate_policy(
  'public.monitor_history_cagg_dim_hour'::regclass,
  start_offset => INTERVAL '49 hours',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '10 minutes',
  if_not_exists => true,
  initial_start => TIMESTAMPTZ '2026-01-01 00:00:00+08',
  timezone => 'Asia/Shanghai'
);
SELECT add_continuous_aggregate_policy(
  'public.monitor_history_cagg_variant_group_hour'::regclass,
  start_offset => INTERVAL '49 hours',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '10 minutes',
  if_not_exists => true,
  initial_start => TIMESTAMPTZ '2026-01-01 00:00:00+08',
  timezone => 'Asia/Shanghai'
);

SELECT add_continuous_aggregate_policy(
  'public.monitor_history_cagg_asin_day'::regclass,
  start_offset => INTERVAL '32 days',
  end_offset => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => true,
  initial_start => TIMESTAMPTZ '2026-01-01 00:00:00+08',
  timezone => 'Asia/Shanghai'
);
SELECT add_continuous_aggregate_policy(
  'public.monitor_history_cagg_dim_day'::regclass,
  start_offset => INTERVAL '32 days',
  end_offset => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => true,
  initial_start => TIMESTAMPTZ '2026-01-01 00:00:00+08',
  timezone => 'Asia/Shanghai'
);
SELECT add_continuous_aggregate_policy(
  'public.monitor_history_cagg_variant_group_day'::regclass,
  start_offset => INTERVAL '32 days',
  end_offset => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => true,
  initial_start => TIMESTAMPTZ '2026-01-01 00:00:00+08',
  timezone => 'Asia/Shanghai'
);

SELECT add_continuous_aggregate_policy(
  'public.monitor_history_cagg_asin_month'::regclass,
  start_offset => INTERVAL '25 months',
  end_offset => INTERVAL '1 month',
  schedule_interval => INTERVAL '1 day',
  if_not_exists => true,
  initial_start => TIMESTAMPTZ '2026-01-01 00:00:00+08',
  timezone => 'Asia/Shanghai'
);
SELECT add_continuous_aggregate_policy(
  'public.monitor_history_cagg_dim_month'::regclass,
  start_offset => INTERVAL '25 months',
  end_offset => INTERVAL '1 month',
  schedule_interval => INTERVAL '1 day',
  if_not_exists => true,
  initial_start => TIMESTAMPTZ '2026-01-01 00:00:00+08',
  timezone => 'Asia/Shanghai'
);
SELECT add_continuous_aggregate_policy(
  'public.monitor_history_cagg_variant_group_month'::regclass,
  start_offset => INTERVAL '25 months',
  end_offset => INTERVAL '1 month',
  schedule_interval => INTERVAL '1 day',
  if_not_exists => true,
  initial_start => TIMESTAMPTZ '2026-01-01 00:00:00+08',
  timezone => 'Asia/Shanghai'
);

DO $cagg_postflight$
DECLARE
  continuous_aggregate_count integer;
  materialized_only_count integer;
BEGIN
  SELECT
    COUNT(*)::integer,
    COUNT(*) FILTER (WHERE materialized_only)::integer
  INTO continuous_aggregate_count, materialized_only_count
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

  IF continuous_aggregate_count <> 9 OR materialized_only_count <> 9 THEN
    RAISE EXCEPTION
      'continuous aggregate postflight mismatch (found %, materialized_only %)',
      continuous_aggregate_count,
      materialized_only_count;
  END IF;
END
$cagg_postflight$;

COMMIT;
