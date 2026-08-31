-- P1-T4a: convert monitor_history to a Timescale hypertable and create the
-- read-only continuous-aggregate projection. The legacy aggregate tables and
-- analytics_refresh_watermark intentionally remain writable until cutover.

SET TIME ZONE 'Asia/Shanghai';
SET search_path TO pg_catalog, public;
SET lock_timeout = '30s';
SET statement_timeout = 0;

BEGIN;

CREATE COLLATION IF NOT EXISTS public.legacy_utf8mb4_unicode_ci (
  provider = icu,
  locale = 'und-u-ks-level1',
  deterministic = false
);

DO $collation_preflight$
DECLARE
  matching_collation_count integer;
BEGIN
  SELECT COUNT(*)::integer
  INTO matching_collation_count
  FROM pg_collation collation_row
  JOIN pg_namespace namespace
    ON namespace.oid = collation_row.collnamespace
  WHERE namespace.nspname = 'public'
    AND collation_row.collname = 'legacy_utf8mb4_unicode_ci'
    AND collation_row.collprovider = 'i'
    AND NOT collation_row.collisdeterministic
    AND collation_row.colliculocale = 'und-u-ks-level1';

  IF matching_collation_count <> 1 THEN
    RAISE EXCEPTION
      'public.legacy_utf8mb4_unicode_ci must be ICU und-u-ks-level1 and nondeterministic';
  END IF;
END
$collation_preflight$;

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

DO $cagg_definition_preflight$
DECLARE
  existing_count integer;
  expected_count integer;
  matching_fingerprint_count integer;
BEGIN
  SELECT
    COUNT(*)::integer,
    COUNT(*) FILTER (
      WHERE view_name IN (
        'monitor_history_cagg_asin_hour',
        'monitor_history_cagg_asin_day',
        'monitor_history_cagg_asin_month',
        'monitor_history_cagg_dim_hour',
        'monitor_history_cagg_dim_day',
        'monitor_history_cagg_dim_month',
        'monitor_history_cagg_variant_group_hour',
        'monitor_history_cagg_variant_group_day',
        'monitor_history_cagg_variant_group_month'
      )
    )::integer
  INTO existing_count, expected_count
  FROM timescaledb_information.continuous_aggregates
  WHERE view_schema = 'public';

  IF existing_count NOT IN (0, 9) OR expected_count <> existing_count THEN
    RAISE EXCEPTION
      'continuous aggregate definition preflight requires either zero or the exact nine managed CAGGs (found %, managed %)',
      existing_count,
      expected_count;
  END IF;

  IF existing_count = 9 THEN
    SELECT COUNT(*) FILTER (
      WHERE obj_description(
        format('%I.%I', view_schema, view_name)::regclass,
        'pg_class'
      ) =
        'amazon-asin-monitor:cagg-definition:p1-t4a-v1:md5:' ||
        md5(regexp_replace(view_definition, '[[:space:]]+', ' ', 'g'))
    )::integer
    INTO matching_fingerprint_count
    FROM timescaledb_information.continuous_aggregates
    WHERE view_schema = 'public';

    IF matching_fingerprint_count <> 9 THEN
      RAISE EXCEPTION
        'continuous aggregate definition fingerprint mismatch (matching %); controlled rebuild required',
        matching_fingerprint_count;
    END IF;
  END IF;

  PERFORM set_config(
    'asin_monitor.cagg_existing_count',
    existing_count::text,
    true
  );
END
$cagg_definition_preflight$;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.monitor_history_cagg_asin_hour
WITH (
  timescaledb.continuous,
  timescaledb.materialized_only = true,
  timescaledb.create_group_indexes = false
) AS
SELECT
  time_bucket(INTERVAL '1 hour', check_time) AS time_slot,
  country COLLATE public.legacy_utf8mb4_unicode_ci AS country,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id)
    COLLATE public.legacy_utf8mb4_unicode_ci AS asin_key,
  COUNT(*) AS check_count,
  COUNT(*) FILTER (WHERE is_broken IS TRUE) AS broken_count,
  BOOL_OR(is_broken IS TRUE) AS has_broken,
  BOOL_OR(
    CASE
      WHEN country COLLATE public.legacy_utf8mb4_unicode_ci = 'US' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 9
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 12
      WHEN country COLLATE public.legacy_utf8mb4_unicode_ci = 'UK' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 22
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 2
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 3
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
      WHEN country COLLATE public.legacy_utf8mb4_unicode_ci IN ('DE', 'FR', 'ES', 'IT') THEN
        EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 20
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 5
      ELSE false
    END
  ) AS has_peak,
  MIN(check_time) AS first_check_time,
  MAX(check_time) AS last_check_time
FROM public.monitor_history
WHERE check_type COLLATE public.legacy_utf8mb4_unicode_ci = 'ASIN'
  AND (asin_id IS NOT NULL OR NULLIF(asin_code, '') IS NOT NULL)
GROUP BY
  time_bucket(INTERVAL '1 hour', check_time),
  country COLLATE public.legacy_utf8mb4_unicode_ci,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id)
    COLLATE public.legacy_utf8mb4_unicode_ci
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.monitor_history_cagg_asin_day
WITH (
  timescaledb.continuous,
  timescaledb.materialized_only = true,
  timescaledb.create_group_indexes = false
) AS
SELECT
  time_bucket(INTERVAL '1 day', check_time) AS time_slot,
  country COLLATE public.legacy_utf8mb4_unicode_ci AS country,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id)
    COLLATE public.legacy_utf8mb4_unicode_ci AS asin_key,
  COUNT(*) AS check_count,
  COUNT(*) FILTER (WHERE is_broken IS TRUE) AS broken_count,
  BOOL_OR(is_broken IS TRUE) AS has_broken,
  BOOL_OR(
    CASE
      WHEN country COLLATE public.legacy_utf8mb4_unicode_ci = 'US' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 9
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 12
      WHEN country COLLATE public.legacy_utf8mb4_unicode_ci = 'UK' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 22
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 2
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 3
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
      WHEN country COLLATE public.legacy_utf8mb4_unicode_ci IN ('DE', 'FR', 'ES', 'IT') THEN
        EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 20
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 5
      ELSE false
    END
  ) AS has_peak,
  MIN(check_time) AS first_check_time,
  MAX(check_time) AS last_check_time
FROM public.monitor_history
WHERE check_type COLLATE public.legacy_utf8mb4_unicode_ci = 'ASIN'
  AND (asin_id IS NOT NULL OR NULLIF(asin_code, '') IS NOT NULL)
GROUP BY
  time_bucket(INTERVAL '1 day', check_time),
  country COLLATE public.legacy_utf8mb4_unicode_ci,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id)
    COLLATE public.legacy_utf8mb4_unicode_ci
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.monitor_history_cagg_asin_month
WITH (
  timescaledb.continuous,
  timescaledb.materialized_only = true,
  timescaledb.create_group_indexes = false
) AS
SELECT
  time_bucket(INTERVAL '1 month', check_time) AS time_slot,
  country COLLATE public.legacy_utf8mb4_unicode_ci AS country,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id)
    COLLATE public.legacy_utf8mb4_unicode_ci AS asin_key,
  COUNT(*) AS check_count,
  COUNT(*) FILTER (WHERE is_broken IS TRUE) AS broken_count,
  BOOL_OR(is_broken IS TRUE) AS has_broken,
  BOOL_OR(
    CASE
      WHEN country COLLATE public.legacy_utf8mb4_unicode_ci = 'US' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 9
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 12
      WHEN country COLLATE public.legacy_utf8mb4_unicode_ci = 'UK' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 22
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 2
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 3
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
      WHEN country COLLATE public.legacy_utf8mb4_unicode_ci IN ('DE', 'FR', 'ES', 'IT') THEN
        EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 20
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 5
      ELSE false
    END
  ) AS has_peak,
  MIN(check_time) AS first_check_time,
  MAX(check_time) AS last_check_time
FROM public.monitor_history
WHERE check_type COLLATE public.legacy_utf8mb4_unicode_ci = 'ASIN'
  AND (asin_id IS NOT NULL OR NULLIF(asin_code, '') IS NOT NULL)
GROUP BY
  time_bucket(INTERVAL '1 month', check_time),
  country COLLATE public.legacy_utf8mb4_unicode_ci,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id)
    COLLATE public.legacy_utf8mb4_unicode_ci
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.monitor_history_cagg_dim_hour
WITH (
  timescaledb.continuous,
  timescaledb.materialized_only = true,
  timescaledb.create_group_indexes = false
) AS
SELECT
  time_bucket(INTERVAL '1 hour', check_time) AS time_slot,
  country COLLATE public.legacy_utf8mb4_unicode_ci AS country,
  COALESCE(site_snapshot, '') COLLATE public.legacy_utf8mb4_unicode_ci AS site,
  COALESCE(brand_snapshot, '') COLLATE public.legacy_utf8mb4_unicode_ci AS brand,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id)
    COLLATE public.legacy_utf8mb4_unicode_ci AS asin_key,
  COUNT(*) AS check_count,
  COUNT(*) FILTER (WHERE is_broken IS TRUE) AS broken_count,
  BOOL_OR(is_broken IS TRUE) AS has_broken,
  BOOL_OR(
    CASE
      WHEN country COLLATE public.legacy_utf8mb4_unicode_ci = 'US' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 9
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 12
      WHEN country COLLATE public.legacy_utf8mb4_unicode_ci = 'UK' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 22
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 2
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 3
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
      WHEN country COLLATE public.legacy_utf8mb4_unicode_ci IN ('DE', 'FR', 'ES', 'IT') THEN
        EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 20
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 5
      ELSE false
    END
  ) AS has_peak,
  MIN(check_time) AS first_check_time,
  MAX(check_time) AS last_check_time
FROM public.monitor_history
WHERE check_type COLLATE public.legacy_utf8mb4_unicode_ci = 'ASIN'
  AND (asin_id IS NOT NULL OR NULLIF(asin_code, '') IS NOT NULL)
GROUP BY
  time_bucket(INTERVAL '1 hour', check_time),
  country COLLATE public.legacy_utf8mb4_unicode_ci,
  COALESCE(site_snapshot, '') COLLATE public.legacy_utf8mb4_unicode_ci,
  COALESCE(brand_snapshot, '') COLLATE public.legacy_utf8mb4_unicode_ci,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id)
    COLLATE public.legacy_utf8mb4_unicode_ci
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.monitor_history_cagg_dim_day
WITH (
  timescaledb.continuous,
  timescaledb.materialized_only = true,
  timescaledb.create_group_indexes = false
) AS
SELECT
  time_bucket(INTERVAL '1 day', check_time) AS time_slot,
  country COLLATE public.legacy_utf8mb4_unicode_ci AS country,
  COALESCE(site_snapshot, '') COLLATE public.legacy_utf8mb4_unicode_ci AS site,
  COALESCE(brand_snapshot, '') COLLATE public.legacy_utf8mb4_unicode_ci AS brand,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id)
    COLLATE public.legacy_utf8mb4_unicode_ci AS asin_key,
  COUNT(*) AS check_count,
  COUNT(*) FILTER (WHERE is_broken IS TRUE) AS broken_count,
  BOOL_OR(is_broken IS TRUE) AS has_broken,
  BOOL_OR(
    CASE
      WHEN country COLLATE public.legacy_utf8mb4_unicode_ci = 'US' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 9
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 12
      WHEN country COLLATE public.legacy_utf8mb4_unicode_ci = 'UK' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 22
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 2
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 3
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
      WHEN country COLLATE public.legacy_utf8mb4_unicode_ci IN ('DE', 'FR', 'ES', 'IT') THEN
        EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 20
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 5
      ELSE false
    END
  ) AS has_peak,
  MIN(check_time) AS first_check_time,
  MAX(check_time) AS last_check_time
FROM public.monitor_history
WHERE check_type COLLATE public.legacy_utf8mb4_unicode_ci = 'ASIN'
  AND (asin_id IS NOT NULL OR NULLIF(asin_code, '') IS NOT NULL)
GROUP BY
  time_bucket(INTERVAL '1 day', check_time),
  country COLLATE public.legacy_utf8mb4_unicode_ci,
  COALESCE(site_snapshot, '') COLLATE public.legacy_utf8mb4_unicode_ci,
  COALESCE(brand_snapshot, '') COLLATE public.legacy_utf8mb4_unicode_ci,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id)
    COLLATE public.legacy_utf8mb4_unicode_ci
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.monitor_history_cagg_dim_month
WITH (
  timescaledb.continuous,
  timescaledb.materialized_only = true,
  timescaledb.create_group_indexes = false
) AS
SELECT
  time_bucket(INTERVAL '1 month', check_time) AS time_slot,
  country COLLATE public.legacy_utf8mb4_unicode_ci AS country,
  COALESCE(site_snapshot, '') COLLATE public.legacy_utf8mb4_unicode_ci AS site,
  COALESCE(brand_snapshot, '') COLLATE public.legacy_utf8mb4_unicode_ci AS brand,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id)
    COLLATE public.legacy_utf8mb4_unicode_ci AS asin_key,
  COUNT(*) AS check_count,
  COUNT(*) FILTER (WHERE is_broken IS TRUE) AS broken_count,
  BOOL_OR(is_broken IS TRUE) AS has_broken,
  BOOL_OR(
    CASE
      WHEN country COLLATE public.legacy_utf8mb4_unicode_ci = 'US' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 9
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 12
      WHEN country COLLATE public.legacy_utf8mb4_unicode_ci = 'UK' THEN EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 22
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 2
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 3
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 6
      WHEN country COLLATE public.legacy_utf8mb4_unicode_ci IN ('DE', 'FR', 'ES', 'IT') THEN
        EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 20
        OR EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM check_time + INTERVAL '8 hours') < 5
      ELSE false
    END
  ) AS has_peak,
  MIN(check_time) AS first_check_time,
  MAX(check_time) AS last_check_time
FROM public.monitor_history
WHERE check_type COLLATE public.legacy_utf8mb4_unicode_ci = 'ASIN'
  AND (asin_id IS NOT NULL OR NULLIF(asin_code, '') IS NOT NULL)
GROUP BY
  time_bucket(INTERVAL '1 month', check_time),
  country COLLATE public.legacy_utf8mb4_unicode_ci,
  COALESCE(site_snapshot, '') COLLATE public.legacy_utf8mb4_unicode_ci,
  COALESCE(brand_snapshot, '') COLLATE public.legacy_utf8mb4_unicode_ci,
  COALESCE(NULLIF(asin_code, ''), 'ID#' || asin_id)
    COLLATE public.legacy_utf8mb4_unicode_ci
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.monitor_history_cagg_variant_group_hour
WITH (
  timescaledb.continuous,
  timescaledb.materialized_only = true,
  timescaledb.create_group_indexes = false
) AS
SELECT
  time_bucket(INTERVAL '1 hour', history.check_time) AS time_slot,
  history.country COLLATE public.legacy_utf8mb4_unicode_ci AS country,
  history.variant_group_id COLLATE public.legacy_utf8mb4_unicode_ci AS variant_group_id,
  COALESCE(
    MAX(NULLIF(history.variant_group_name, '') COLLATE public.legacy_utf8mb4_unicode_ci),
    MAX(variant_group.name COLLATE public.legacy_utf8mb4_unicode_ci),
    ''
  ) AS variant_group_name_snapshot,
  COALESCE(NULLIF(history.asin_code, ''), 'ID#' || history.asin_id)
    COLLATE public.legacy_utf8mb4_unicode_ci AS asin_key,
  COUNT(*) AS check_count,
  COUNT(*) FILTER (WHERE history.is_broken IS TRUE) AS broken_count,
  BOOL_OR(history.is_broken IS TRUE) AS has_broken,
  BOOL_OR(
    CASE
      WHEN history.country COLLATE public.legacy_utf8mb4_unicode_ci = 'US' THEN EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') < 6
        OR EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') >= 9
        AND EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') < 12
      WHEN history.country COLLATE public.legacy_utf8mb4_unicode_ci = 'UK' THEN EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') >= 22
        OR EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') < 2
        OR EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') >= 3
        AND EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') < 6
      WHEN history.country COLLATE public.legacy_utf8mb4_unicode_ci IN ('DE', 'FR', 'ES', 'IT') THEN
        EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') >= 20
        OR EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') < 5
      ELSE false
    END
  ) AS has_peak,
  MIN(history.check_time) AS first_check_time,
  MAX(history.check_time) AS last_check_time
FROM public.monitor_history history
LEFT JOIN public.variant_groups variant_group
  ON variant_group.id COLLATE public.legacy_utf8mb4_unicode_ci =
    history.variant_group_id COLLATE public.legacy_utf8mb4_unicode_ci
WHERE history.check_type COLLATE public.legacy_utf8mb4_unicode_ci = 'ASIN'
  AND history.variant_group_id IS NOT NULL
  AND (history.asin_id IS NOT NULL OR NULLIF(history.asin_code, '') IS NOT NULL)
GROUP BY
  time_bucket(INTERVAL '1 hour', history.check_time),
  history.country COLLATE public.legacy_utf8mb4_unicode_ci,
  history.variant_group_id COLLATE public.legacy_utf8mb4_unicode_ci,
  COALESCE(NULLIF(history.asin_code, ''), 'ID#' || history.asin_id)
    COLLATE public.legacy_utf8mb4_unicode_ci
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.monitor_history_cagg_variant_group_day
WITH (
  timescaledb.continuous,
  timescaledb.materialized_only = true,
  timescaledb.create_group_indexes = false
) AS
SELECT
  time_bucket(INTERVAL '1 day', history.check_time) AS time_slot,
  history.country COLLATE public.legacy_utf8mb4_unicode_ci AS country,
  history.variant_group_id COLLATE public.legacy_utf8mb4_unicode_ci AS variant_group_id,
  COALESCE(
    MAX(NULLIF(history.variant_group_name, '') COLLATE public.legacy_utf8mb4_unicode_ci),
    MAX(variant_group.name COLLATE public.legacy_utf8mb4_unicode_ci),
    ''
  ) AS variant_group_name_snapshot,
  COALESCE(NULLIF(history.asin_code, ''), 'ID#' || history.asin_id)
    COLLATE public.legacy_utf8mb4_unicode_ci AS asin_key,
  COUNT(*) AS check_count,
  COUNT(*) FILTER (WHERE history.is_broken IS TRUE) AS broken_count,
  BOOL_OR(history.is_broken IS TRUE) AS has_broken,
  BOOL_OR(
    CASE
      WHEN history.country COLLATE public.legacy_utf8mb4_unicode_ci = 'US' THEN EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') < 6
        OR EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') >= 9
        AND EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') < 12
      WHEN history.country COLLATE public.legacy_utf8mb4_unicode_ci = 'UK' THEN EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') >= 22
        OR EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') < 2
        OR EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') >= 3
        AND EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') < 6
      WHEN history.country COLLATE public.legacy_utf8mb4_unicode_ci IN ('DE', 'FR', 'ES', 'IT') THEN
        EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') >= 20
        OR EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') < 5
      ELSE false
    END
  ) AS has_peak,
  MIN(history.check_time) AS first_check_time,
  MAX(history.check_time) AS last_check_time
FROM public.monitor_history history
LEFT JOIN public.variant_groups variant_group
  ON variant_group.id COLLATE public.legacy_utf8mb4_unicode_ci =
    history.variant_group_id COLLATE public.legacy_utf8mb4_unicode_ci
WHERE history.check_type COLLATE public.legacy_utf8mb4_unicode_ci = 'ASIN'
  AND history.variant_group_id IS NOT NULL
  AND (history.asin_id IS NOT NULL OR NULLIF(history.asin_code, '') IS NOT NULL)
GROUP BY
  time_bucket(INTERVAL '1 day', history.check_time),
  history.country COLLATE public.legacy_utf8mb4_unicode_ci,
  history.variant_group_id COLLATE public.legacy_utf8mb4_unicode_ci,
  COALESCE(NULLIF(history.asin_code, ''), 'ID#' || history.asin_id)
    COLLATE public.legacy_utf8mb4_unicode_ci
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.monitor_history_cagg_variant_group_month
WITH (
  timescaledb.continuous,
  timescaledb.materialized_only = true,
  timescaledb.create_group_indexes = false
) AS
SELECT
  time_bucket(INTERVAL '1 month', history.check_time) AS time_slot,
  history.country COLLATE public.legacy_utf8mb4_unicode_ci AS country,
  history.variant_group_id COLLATE public.legacy_utf8mb4_unicode_ci AS variant_group_id,
  COALESCE(
    MAX(NULLIF(history.variant_group_name, '') COLLATE public.legacy_utf8mb4_unicode_ci),
    MAX(variant_group.name COLLATE public.legacy_utf8mb4_unicode_ci),
    ''
  ) AS variant_group_name_snapshot,
  COALESCE(NULLIF(history.asin_code, ''), 'ID#' || history.asin_id)
    COLLATE public.legacy_utf8mb4_unicode_ci AS asin_key,
  COUNT(*) AS check_count,
  COUNT(*) FILTER (WHERE history.is_broken IS TRUE) AS broken_count,
  BOOL_OR(history.is_broken IS TRUE) AS has_broken,
  BOOL_OR(
    CASE
      WHEN history.country COLLATE public.legacy_utf8mb4_unicode_ci = 'US' THEN EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') < 6
        OR EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') >= 9
        AND EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') < 12
      WHEN history.country COLLATE public.legacy_utf8mb4_unicode_ci = 'UK' THEN EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') >= 22
        OR EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') < 2
        OR EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') >= 3
        AND EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') < 6
      WHEN history.country COLLATE public.legacy_utf8mb4_unicode_ci IN ('DE', 'FR', 'ES', 'IT') THEN
        EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') >= 20
        OR EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') >= 2
        AND EXTRACT(HOUR FROM history.check_time + INTERVAL '8 hours') < 5
      ELSE false
    END
  ) AS has_peak,
  MIN(history.check_time) AS first_check_time,
  MAX(history.check_time) AS last_check_time
FROM public.monitor_history history
LEFT JOIN public.variant_groups variant_group
  ON variant_group.id COLLATE public.legacy_utf8mb4_unicode_ci =
    history.variant_group_id COLLATE public.legacy_utf8mb4_unicode_ci
WHERE history.check_type COLLATE public.legacy_utf8mb4_unicode_ci = 'ASIN'
  AND history.variant_group_id IS NOT NULL
  AND (history.asin_id IS NOT NULL OR NULLIF(history.asin_code, '') IS NOT NULL)
GROUP BY
  time_bucket(INTERVAL '1 month', history.check_time),
  history.country COLLATE public.legacy_utf8mb4_unicode_ci,
  history.variant_group_id COLLATE public.legacy_utf8mb4_unicode_ci,
  COALESCE(NULLIF(history.asin_code, ''), 'ID#' || history.asin_id)
    COLLATE public.legacy_utf8mb4_unicode_ci
WITH NO DATA;

DO $cagg_definition_fingerprint$
DECLARE
  aggregate_row record;
BEGIN
  IF current_setting('asin_monitor.cagg_existing_count')::integer = 0 THEN
    FOR aggregate_row IN
      SELECT view_name, view_definition
      FROM timescaledb_information.continuous_aggregates
      WHERE view_schema = 'public'
      ORDER BY view_name
    LOOP
      EXECUTE format(
        'COMMENT ON MATERIALIZED VIEW public.%I IS %L',
        aggregate_row.view_name,
        'amazon-asin-monitor:cagg-definition:p1-t4a-v1:md5:' ||
          md5(regexp_replace(
            aggregate_row.view_definition,
            '[[:space:]]+',
            ' ',
            'g'
          ))
      );
    END LOOP;
  END IF;
END
$cagg_definition_fingerprint$;

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
  COALESCE(aggregate_row.variant_group_name_snapshot, '') AS variant_group_name,
  aggregate_row.asin_key,
  aggregate_row.check_count,
  aggregate_row.broken_count,
  aggregate_row.has_broken,
  aggregate_row.has_peak,
  aggregate_row.first_check_time,
  aggregate_row.last_check_time
FROM public.monitor_history_cagg_variant_group_hour aggregate_row
UNION ALL
SELECT
  'day'::varchar(5) AS granularity,
  aggregate_row.time_slot,
  aggregate_row.country,
  aggregate_row.variant_group_id,
  COALESCE(aggregate_row.variant_group_name_snapshot, '') AS variant_group_name,
  aggregate_row.asin_key,
  aggregate_row.check_count,
  aggregate_row.broken_count,
  aggregate_row.has_broken,
  aggregate_row.has_peak,
  aggregate_row.first_check_time,
  aggregate_row.last_check_time
FROM public.monitor_history_cagg_variant_group_day aggregate_row
UNION ALL
SELECT
  'month'::varchar(5) AS granularity,
  aggregate_row.time_slot,
  aggregate_row.country,
  aggregate_row.variant_group_id,
  COALESCE(aggregate_row.variant_group_name_snapshot, '') AS variant_group_name,
  aggregate_row.asin_key,
  aggregate_row.check_count,
  aggregate_row.broken_count,
  aggregate_row.has_broken,
  aggregate_row.has_peak,
  aggregate_row.first_check_time,
  aggregate_row.last_check_time
FROM public.monitor_history_cagg_variant_group_month aggregate_row;

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
  legacy_collation_column_count integer;
  variant_fallback_materialized_count integer;
  matching_definition_fingerprint_count integer;
  refresh_policy_count integer;
  matching_refresh_policy_count integer;
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

  SELECT COUNT(*) FILTER (
    WHERE obj_description(
      format('%I.%I', view_schema, view_name)::regclass,
      'pg_class'
    ) =
      'amazon-asin-monitor:cagg-definition:p1-t4a-v1:md5:' ||
      md5(regexp_replace(view_definition, '[[:space:]]+', ' ', 'g'))
  )::integer
  INTO matching_definition_fingerprint_count
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

  IF matching_definition_fingerprint_count <> 9 THEN
    RAISE EXCEPTION
      'continuous aggregate definition fingerprint postflight mismatch (matching %)',
      matching_definition_fingerprint_count;
  END IF;

  SELECT COUNT(*) FILTER (
    WHERE attribute.attcollation =
      'public.legacy_utf8mb4_unicode_ci'::regcollation::oid
  )::integer
  INTO legacy_collation_column_count
  FROM pg_attribute attribute
  JOIN pg_class relation
    ON relation.oid = attribute.attrelid
  JOIN pg_namespace namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
    AND (
      (
        relation.relname IN (
          'monitor_history_cagg_asin_hour',
          'monitor_history_cagg_asin_day',
          'monitor_history_cagg_asin_month'
        )
        AND attribute.attname IN ('country', 'asin_key')
      )
      OR (
        relation.relname IN (
          'monitor_history_cagg_dim_hour',
          'monitor_history_cagg_dim_day',
          'monitor_history_cagg_dim_month'
        )
        AND attribute.attname IN ('country', 'site', 'brand', 'asin_key')
      )
      OR (
        relation.relname IN (
          'monitor_history_cagg_variant_group_hour',
          'monitor_history_cagg_variant_group_day',
          'monitor_history_cagg_variant_group_month'
        )
        AND attribute.attname IN (
          'country',
          'variant_group_id',
          'variant_group_name_snapshot',
          'asin_key'
        )
      )
    );

  IF legacy_collation_column_count <> 30 THEN
    RAISE EXCEPTION
      'continuous aggregate legacy collation postflight mismatch (matching columns %)',
      legacy_collation_column_count;
  END IF;

  SELECT COUNT(*) FILTER (
    WHERE POSITION('variant_groups' IN view_definition) > 0
  )::integer
  INTO variant_fallback_materialized_count
  FROM timescaledb_information.continuous_aggregates
  WHERE view_schema = 'public'
    AND view_name IN (
      'monitor_history_cagg_variant_group_hour',
      'monitor_history_cagg_variant_group_day',
      'monitor_history_cagg_variant_group_month'
    );

  IF variant_fallback_materialized_count <> 3 THEN
    RAISE EXCEPTION
      'variant-group fallback must be materialized by all three continuous aggregates (matching %)',
      variant_fallback_materialized_count;
  END IF;

  WITH expected_policy (
    view_name,
    start_offset,
    end_offset,
    schedule_interval
  ) AS (
    VALUES
      ('monitor_history_cagg_asin_hour', INTERVAL '49 hours', INTERVAL '1 hour', INTERVAL '10 minutes'),
      ('monitor_history_cagg_dim_hour', INTERVAL '49 hours', INTERVAL '1 hour', INTERVAL '10 minutes'),
      ('monitor_history_cagg_variant_group_hour', INTERVAL '49 hours', INTERVAL '1 hour', INTERVAL '10 minutes'),
      ('monitor_history_cagg_asin_day', INTERVAL '32 days', INTERVAL '1 day', INTERVAL '1 hour'),
      ('monitor_history_cagg_dim_day', INTERVAL '32 days', INTERVAL '1 day', INTERVAL '1 hour'),
      ('monitor_history_cagg_variant_group_day', INTERVAL '32 days', INTERVAL '1 day', INTERVAL '1 hour'),
      ('monitor_history_cagg_asin_month', INTERVAL '25 months', INTERVAL '1 month', INTERVAL '1 day'),
      ('monitor_history_cagg_dim_month', INTERVAL '25 months', INTERVAL '1 month', INTERVAL '1 day'),
      ('monitor_history_cagg_variant_group_month', INTERVAL '25 months', INTERVAL '1 month', INTERVAL '1 day')
  ), selected_materialization AS (
    SELECT
      expected_policy.*,
      hypertable.id AS materialization_hypertable_id
    FROM expected_policy
    JOIN timescaledb_information.continuous_aggregates aggregate_row
      ON aggregate_row.view_schema = 'public'
     AND aggregate_row.view_name = expected_policy.view_name
    JOIN _timescaledb_catalog.hypertable hypertable
      ON hypertable.schema_name = aggregate_row.materialization_hypertable_schema
     AND hypertable.table_name = aggregate_row.materialization_hypertable_name
  ), selected_job AS (
    SELECT
      expected_policy.*,
      jobs.schedule_interval AS actual_schedule_interval,
      jobs.scheduled,
      jobs.fixed_schedule,
      jobs.initial_start,
      catalog_job.timezone,
      jobs.config
    FROM selected_materialization expected_policy
    JOIN timescaledb_information.jobs jobs
      ON jobs.proc_name = 'policy_refresh_continuous_aggregate'
     AND (jobs.config ->> 'mat_hypertable_id')::integer =
       expected_policy.materialization_hypertable_id
    JOIN _timescaledb_catalog.bgw_job catalog_job
      ON catalog_job.id = jobs.job_id
  )
  SELECT
    COUNT(*)::integer,
    COUNT(*) FILTER (
      WHERE actual_schedule_interval = schedule_interval
        AND (config ->> 'start_offset')::interval = start_offset
        AND (config ->> 'end_offset')::interval = end_offset
        AND scheduled
        AND fixed_schedule
        AND initial_start = TIMESTAMPTZ '2026-01-01 00:00:00+08'
        AND timezone = 'Asia/Shanghai'
    )::integer
  INTO refresh_policy_count, matching_refresh_policy_count
  FROM selected_job;

  IF refresh_policy_count <> 9 OR matching_refresh_policy_count <> 9 THEN
    RAISE EXCEPTION
      'continuous aggregate refresh policy postflight mismatch (found %, matching %)',
      refresh_policy_count,
      matching_refresh_policy_count;
  END IF;
END
$cagg_postflight$;

COMMIT;
