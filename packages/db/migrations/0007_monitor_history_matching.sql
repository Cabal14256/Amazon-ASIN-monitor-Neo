-- Primary database only, after 0005. PG16 LIKE cannot use a nondeterministic
-- collation. Match Legacy utf8mb4_unicode_ci LIKE one character at a time;
-- unlike equality, LIKE must not expand e.g. sharp-s into two characters.
BEGIN;
SET LOCAL search_path TO pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_collation c
    WHERE c.oid='public.neo_import_group_ci'::regcollation
      AND c.collprovider='i' AND NOT c.collisdeterministic
      AND c.colliculocale='und-u-ks-level1'
      AND c.collversion=pg_catalog.pg_collation_actual_version(c.oid)
  ) THEN
    RAISE EXCEPTION 'Monitor history requires the verified 0005 ICU collation';
  END IF;
END $$;
-- Soft historical references retain MySQL ID comparison rules. Reject ambiguous
-- existing IDs before enabling these joins and keep both lookups indexable.
CREATE UNIQUE INDEX IF NOT EXISTS idx_variant_groups_history_id_ci
  ON public.variant_groups ((rtrim(id) COLLATE public.neo_import_group_ci));
CREATE UNIQUE INDEX IF NOT EXISTS idx_asins_history_id_ci
  ON public.asins ((rtrim(id) COLLATE public.neo_import_group_ci));
CREATE OR REPLACE FUNCTION public.neo_monitor_like(value text, pattern text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path TO pg_catalog
AS $$
DECLARE
  source_chars text[] := string_to_array(value, NULL);
  pattern_chars text[] := string_to_array(pattern, NULL);
  literals text[] := ARRAY[]::text[];
  kinds integer[] := ARRAY[]::integer[];
  n integer := cardinality(source_chars);
  m integer := cardinality(pattern_chars);
  s integer := 1;
  p integer := 1;
  star integer := 0;
  retry integer := 0;
  token text;
BEGIN
  -- The query layer has the same character limits. Bound any direct SQL caller.
  IF n > 500 OR m > 502 THEN
    RAISE EXCEPTION 'Monitor history pattern exceeds bounds' USING ERRCODE='22023';
  END IF;
  WHILE p <= m LOOP
    token := pattern_chars[p];
    IF token = chr(92) THEN
      IF p < m THEN
        p := p + 1;
        token := pattern_chars[p];
      END IF;
      kinds := array_append(kinds, 1);
    ELSIF token = '%' THEN
      kinds := array_append(kinds, -1);
    ELSIF token = '_' THEN
      kinds := array_append(kinds, 0);
    ELSE
      kinds := array_append(kinds, 1);
    END IF;
    literals := array_append(literals, token);
    p := p + 1;
  END LOOP;
  m := cardinality(kinds);
  p := 1;
  -- Greedy wildcard matching with one retry position, no recursion or regex.
  WHILE s <= n LOOP
    IF p <= m AND kinds[p] = -1 THEN
      star := p;
      retry := s;
      p := p + 1;
    ELSIF p <= m AND (kinds[p] = 0 OR
      source_chars[s] COLLATE public.neo_import_group_ci = literals[p]) THEN
      s := s + 1;
      p := p + 1;
    ELSIF star > 0 THEN
      retry := retry + 1;
      s := retry;
      p := star + 1;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  WHILE p <= m AND kinds[p] = -1 LOOP
    p := p + 1;
  END LOOP;
  RETURN p > m;
END $$;
COMMIT;
