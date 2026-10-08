-- Stop/drain Neo catalog API + workers first. Never discard unresolved pins.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $catalog_fence_rollback$
DECLARE table_name text; relation regclass; fingerprint text; marker text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('amazon-asin-monitor:catalog-operation-fence:v1',0));
  IF to_regclass('public.catalog_operation_slots') IS NULL AND to_regclass('public.catalog_operation_pins') IS NULL THEN RETURN; END IF;
  FOREACH table_name IN ARRAY ARRAY['catalog_operation_slots','catalog_operation_pins'] LOOP
    relation := to_regclass('public.'||table_name);
    IF relation IS NULL OR (SELECT relkind FROM pg_class WHERE oid=relation)<>'r'
      OR COALESCE(obj_description(relation,'pg_class'),'') !~ '^neo-catalog-operation-fence-v1:[0-9a-f]{32}$' THEN
      RAISE EXCEPTION 'catalog operation fence rollback object conflict';
    END IF;
  END LOOP;
  LOCK TABLE public.catalog_operation_slots,public.catalog_operation_pins IN ACCESS EXCLUSIVE MODE;
  FOREACH table_name IN ARRAY ARRAY['catalog_operation_slots','catalog_operation_pins'] LOOP
    relation := to_regclass('public.'||table_name);
    -- Detect column/default/collation, constraint/index, trigger or RLS drift.
    SELECT md5(concat_ws('|',
      (SELECT string_agg(concat_ws(':',a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),
         a.attnotnull,a.attidentity,a.attgenerated,a.attcollation,COALESCE(pg_get_expr(d.adbin,d.adrelid),'')), '|' ORDER BY a.attnum)
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
       WHERE a.attrelid=relation AND a.attnum>0 AND NOT a.attisdropped),
      (SELECT string_agg(conname||':'||pg_get_constraintdef(oid,true), '|' ORDER BY conname)
       FROM pg_constraint WHERE conrelid=relation),
      (SELECT string_agg(indexrelid::regclass::text||':'||pg_get_indexdef(indexrelid), '|' ORDER BY indexrelid::regclass::text)
       FROM pg_index WHERE indrelid=relation),
      (SELECT string_agg(tgname||':'||pg_get_triggerdef(oid,true), '|' ORDER BY tgname)
       FROM pg_trigger WHERE tgrelid=relation AND NOT tgisinternal),
      (SELECT concat_ws(':',relrowsecurity,relforcerowsecurity) FROM pg_class WHERE oid=relation),
      (SELECT string_agg(concat_ws(':',polname,polcmd,polpermissive,polroles,
         pg_get_expr(polqual,polrelid),pg_get_expr(polwithcheck,polrelid)), '|' ORDER BY polname)
       FROM pg_policy WHERE polrelid=relation)
    )) INTO fingerprint;
    marker := 'neo-catalog-operation-fence-v1:' || fingerprint;
    IF obj_description(relation,'pg_class') IS DISTINCT FROM marker THEN
      RAISE EXCEPTION 'catalog operation fence rollback structural drift';
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.catalog_operation_slots WHERE state<>'idle')
    OR EXISTS(SELECT 1 FROM public.catalog_operation_pins) THEN
    RAISE EXCEPTION 'catalog operation fence has unresolved operations/pins';
  END IF;
  DROP TABLE public.catalog_operation_pins;
  DROP TABLE public.catalog_operation_slots;
END
$catalog_fence_rollback$;
COMMIT;

