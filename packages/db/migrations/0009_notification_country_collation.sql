-- Apply separately to both D6 databases. Shared notification readers need the
-- same CI/PADSPACE equality even before competitor CRUD/import is migrated.
BEGIN;
SET LOCAL search_path TO pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE COLLATION IF NOT EXISTS public.neo_notification_country_ci
  (provider = icu, locale = 'und-u-ks-level1', deterministic = false);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_collation c
    WHERE c.oid='public.neo_notification_country_ci'::regcollation
      AND c.collprovider='i' AND NOT c.collisdeterministic
      AND c.colliculocale='und-u-ks-level1'
      AND c.collversion=pg_catalog.pg_collation_actual_version(c.oid)
  ) THEN
    RAISE EXCEPTION 'Notification country collation definition or ICU version differs';
  END IF;
END $$;
COMMIT;
