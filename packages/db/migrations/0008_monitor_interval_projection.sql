-- Primary database, after 0007. Rebuild imported intervals before trusting them.
-- Source mutations and their dirty receipt commit together. A worker locks one
-- receipt, rebuilds that key, and completes its revision in the same transaction.
BEGIN;
SET LOCAL search_path TO pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
LOCK TABLE public.monitor_history, public.monitor_history_status_interval IN SHARE ROW EXCLUSIVE MODE;

-- A missing ASIN code uses ID# plus the complete varchar(50) identifier.
ALTER TABLE public.monitor_history_status_interval ALTER COLUMN asin_key TYPE varchar(53);
CREATE TABLE IF NOT EXISTS public.monitor_interval_dirty (
  asin_key varchar(53) NOT NULL,
  country varchar(10) NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  completed_revision bigint NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT false,
  first_check_time timestamp without time zone,
  last_check_time timestamp without time zone,
  queued_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (asin_key, country)
);
CREATE INDEX IF NOT EXISTS idx_monitor_interval_dirty_queue ON public.monitor_interval_dirty (queued_at, asin_key, country)
  WHERE completed_revision <> revision;
CREATE TABLE IF NOT EXISTS public.monitor_interval_projection (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL,
  initialized_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION public.neo_monitor_interval_key(code text, identifier text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path TO pg_catalog
AS $$ SELECT CASE WHEN nullif(rtrim(code), '') IS NOT NULL THEN code ELSE 'ID#' || identifier END $$;

CREATE INDEX IF NOT EXISTS idx_monitor_history_interval_key
  ON public.monitor_history (country, (public.neo_monitor_interval_key(asin_code, asin_id)), check_time, id)
  WHERE rtrim(check_type) COLLATE public.neo_import_group_ci = 'ASIN'
    AND (asin_id IS NOT NULL OR nullif(rtrim(asin_code), '') IS NOT NULL);

CREATE OR REPLACE FUNCTION public.neo_queue_monitor_interval()
RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog
AS $$
DECLARE
  old_key text;
  new_key text;
BEGIN
  IF TG_TABLE_NAME = 'monitor_history_status_interval' THEN
    IF TG_OP <> 'INSERT' THEN old_key := OLD.asin_key; END IF;
    IF TG_OP <> 'DELETE' THEN new_key := NEW.asin_key; END IF;
  ELSE
    -- Notification bookkeeping does not alter the observed status timeline.
    IF TG_OP = 'UPDATE' AND
      ROW(OLD.asin_id, OLD.asin_code, OLD.asin_name, OLD.country,
          OLD.variant_group_id, OLD.variant_group_name, OLD.check_type,
          OLD.check_time, OLD.id, OLD.is_broken) IS NOT DISTINCT FROM
      ROW(NEW.asin_id, NEW.asin_code, NEW.asin_name, NEW.country,
          NEW.variant_group_id, NEW.variant_group_name, NEW.check_type,
          NEW.check_time, NEW.id, NEW.is_broken) THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND rtrim(OLD.check_type) COLLATE public.neo_import_group_ci = 'ASIN' THEN
      old_key := public.neo_monitor_interval_key(OLD.asin_code, OLD.asin_id);
    END IF;
    IF TG_OP <> 'DELETE' AND rtrim(NEW.check_type) COLLATE public.neo_import_group_ci = 'ASIN' THEN
      new_key := public.neo_monitor_interval_key(NEW.asin_code, NEW.asin_id);
    END IF;
  END IF;
  IF old_key IS NOT NULL THEN
    INSERT INTO public.monitor_interval_dirty(asin_key, country) VALUES(old_key, OLD.country)
    ON CONFLICT (asin_key, country) DO UPDATE SET revision = monitor_interval_dirty.revision + 1, queued_at = CASE WHEN monitor_interval_dirty.completed_revision = monitor_interval_dirty.revision THEN clock_timestamp() ELSE monitor_interval_dirty.queued_at END;
  END IF;
  IF new_key IS NOT NULL AND (TG_OP = 'INSERT' OR old_key IS DISTINCT FROM new_key OR OLD.country IS DISTINCT FROM NEW.country) THEN
    INSERT INTO public.monitor_interval_dirty(asin_key, country) VALUES(new_key, NEW.country)
    ON CONFLICT (asin_key, country) DO UPDATE SET revision = monitor_interval_dirty.revision + 1, queued_at = CASE WHEN monitor_interval_dirty.completed_revision = monitor_interval_dirty.revision THEN clock_timestamp() ELSE monitor_interval_dirty.queued_at END;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.neo_queue_monitor_interval_truncate()
RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog
AS $$
BEGIN
  IF TG_TABLE_NAME = 'monitor_history' THEN
    INSERT INTO public.monitor_interval_dirty(asin_key, country)
      SELECT DISTINCT asin_key, country FROM public.monitor_history_status_interval
      ON CONFLICT (asin_key, country) DO UPDATE SET revision = monitor_interval_dirty.revision + 1, queued_at = CASE WHEN monitor_interval_dirty.completed_revision = monitor_interval_dirty.revision THEN clock_timestamp() ELSE monitor_interval_dirty.queued_at END;
  ELSE
    INSERT INTO public.monitor_interval_dirty(asin_key, country)
      SELECT DISTINCT public.neo_monitor_interval_key(asin_code, asin_id), country
      FROM public.monitor_history
      WHERE rtrim(check_type) COLLATE public.neo_import_group_ci = 'ASIN'
        AND (asin_id IS NOT NULL OR nullif(rtrim(asin_code), '') IS NOT NULL)
      ON CONFLICT (asin_key, country) DO UPDATE SET revision = monitor_interval_dirty.revision + 1, queued_at = CASE WHEN monitor_interval_dirty.completed_revision = monitor_interval_dirty.revision THEN clock_timestamp() ELSE monitor_interval_dirty.queued_at END;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_monitor_interval_source_dirty ON public.monitor_history;
CREATE TRIGGER trg_monitor_interval_source_dirty AFTER INSERT OR UPDATE OR DELETE ON public.monitor_history
  FOR EACH ROW EXECUTE FUNCTION public.neo_queue_monitor_interval();
DROP TRIGGER IF EXISTS trg_monitor_interval_projection_dirty ON public.monitor_history_status_interval;
CREATE TRIGGER trg_monitor_interval_projection_dirty AFTER INSERT OR UPDATE OR DELETE ON public.monitor_history_status_interval
  FOR EACH ROW EXECUTE FUNCTION public.neo_queue_monitor_interval();
DROP TRIGGER IF EXISTS trg_monitor_interval_source_truncate ON public.monitor_history;
CREATE TRIGGER trg_monitor_interval_source_truncate BEFORE TRUNCATE ON public.monitor_history
  FOR EACH STATEMENT EXECUTE FUNCTION public.neo_queue_monitor_interval_truncate();
DROP TRIGGER IF EXISTS trg_monitor_interval_projection_truncate ON public.monitor_history_status_interval;
CREATE TRIGGER trg_monitor_interval_projection_truncate BEFORE TRUNCATE ON public.monitor_history_status_interval
  FOR EACH STATEMENT EXECUTE FUNCTION public.neo_queue_monitor_interval_truncate();

-- Re-running the migration must preserve pending work and completed receipts.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.monitor_interval_projection WHERE singleton AND version = 1) THEN
    INSERT INTO public.monitor_interval_dirty(asin_key, country)
      SELECT public.neo_monitor_interval_key(asin_code, asin_id), country FROM public.monitor_history
        WHERE rtrim(check_type) COLLATE public.neo_import_group_ci = 'ASIN'
          AND (asin_id IS NOT NULL OR nullif(rtrim(asin_code), '') IS NOT NULL)
      UNION SELECT asin_key, country FROM public.monitor_history_status_interval
      ON CONFLICT (asin_key, country) DO UPDATE SET revision = monitor_interval_dirty.revision + 1, queued_at = CASE WHEN monitor_interval_dirty.completed_revision = monitor_interval_dirty.revision THEN clock_timestamp() ELSE monitor_interval_dirty.queued_at END;
    INSERT INTO public.monitor_interval_projection(singleton, version) VALUES(true, 1)
      ON CONFLICT (singleton) DO UPDATE SET version = 1, initialized_at = clock_timestamp();
  END IF;
END $$;
COMMIT;
