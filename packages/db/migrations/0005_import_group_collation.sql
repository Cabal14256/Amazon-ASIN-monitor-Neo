-- Primary database only, after 0004. Match Legacy group lookup case/accent
-- insensitivity without changing displayed text or ordinary CRUD uniqueness.
BEGIN;
SET LOCAL search_path TO pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.variant_groups IN SHARE ROW EXCLUSIVE MODE;
CREATE COLLATION IF NOT EXISTS public.neo_import_group_ci
  (provider = icu, locale = 'und-u-ks-level1', deterministic = false);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_collation c
    WHERE c.oid='public.neo_import_group_ci'::regcollation
      AND c.collprovider='i' AND NOT c.collisdeterministic
      AND c.colliculocale='und-u-ks-level1'
      AND c.collversion=pg_catalog.pg_collation_actual_version(c.oid)
  ) THEN
    RAISE EXCEPTION 'Import group collation definition or ICU version differs';
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_variant_groups_import_match
  ON public.variant_groups (
    (rtrim(name) COLLATE public.neo_import_group_ci),
    (rtrim(country) COLLATE public.neo_import_group_ci),
    (rtrim(site) COLLATE public.neo_import_group_ci),
    (rtrim(brand) COLLATE public.neo_import_group_ci),
    create_time DESC, id DESC
  );
COMMIT;
