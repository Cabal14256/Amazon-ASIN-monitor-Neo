-- Competitor database only. Preserve Legacy CI/PADSPACE identity and PG16 LIKE.
BEGIN;
SET LOCAL search_path TO pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE COLLATION IF NOT EXISTS public.neo_competitor_query_ci
  (provider = icu, locale = 'und-u-ks-level1', deterministic = false);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_collation c
    WHERE c.oid='public.neo_competitor_query_ci'::regcollation
      AND c.collprovider='i' AND NOT c.collisdeterministic
      AND c.colliculocale='und-u-ks-level1'
      AND c.collversion=pg_catalog.pg_collation_actual_version(c.oid)
  ) THEN
    RAISE EXCEPTION 'Competitor query collation definition or ICU version differs';
  END IF;
END $$;
-- Rebuild only this migration's indexes on repeat runs, guaranteeing the
-- required expressions/uniqueness rather than trusting a same-named object.
-- Duplicate equivalent IDs reject the whole transaction; no records are merged.
DROP INDEX IF EXISTS public.idx_neo_competitor_query_group_id;
DROP INDEX IF EXISTS public.idx_neo_competitor_query_asin_id;
DROP INDEX IF EXISTS public.idx_neo_competitor_query_children;
CREATE UNIQUE INDEX idx_neo_competitor_query_group_id
  ON public.competitor_variant_groups ((rtrim(id) COLLATE public.neo_competitor_query_ci));
CREATE UNIQUE INDEX idx_neo_competitor_query_asin_id
  ON public.competitor_asins ((rtrim(id) COLLATE public.neo_competitor_query_ci));
CREATE INDEX idx_neo_competitor_query_children
  ON public.competitor_asins ((rtrim(variant_group_id) COLLATE public.neo_competitor_query_ci),is_broken);
CREATE OR REPLACE FUNCTION public.neo_competitor_query_like(value text, pattern text)
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
    RAISE EXCEPTION 'Competitor query pattern exceeds bounds' USING ERRCODE='22023';
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
      source_chars[s] COLLATE public.neo_competitor_query_ci = literals[p]) THEN
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
