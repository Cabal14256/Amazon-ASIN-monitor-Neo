-- Stop system monitor producers/consumers and reconcile unresolved claims first.
-- Removes only private system ledgers. Business and monitor history remain.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- Ownership is the original version/domain/table marker, not a fresh schema
-- fingerprint: removing one owned child changes the parent's internal triggers.
-- Validate every present relation before removing even one owned table.
DO $ledger_rollback_preflight$
DECLARE
  table_name text;
  relation regclass;
  marker text;
  expected_prefix text;
  relkind "char";
  ledger_present boolean := false;
  owned_relations regclass[] := ARRAY[]::regclass[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('amazon-asin-monitor:scheduled-ledger:competitor',0));
  FOREACH table_name IN ARRAY ARRAY['competitor_scheduled_monitor_runs','competitor_scheduled_monitor_notifications','competitor_scheduled_monitor_group_receipts'] LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN ledger_present := true; END IF;
  END LOOP;
  IF NOT ledger_present THEN RETURN; END IF;
  IF to_regclass('public.competitor_variant_groups') IS NULL
     OR to_regclass('public.competitor_monitor_history') IS NULL
     OR to_regclass('public.competitor_monitor_runs') IS NULL
     OR to_regclass('public.variant_groups') IS NOT NULL THEN
    RAISE EXCEPTION 'scheduled monitor target prerequisite mismatch';
  END IF;
  FOREACH table_name IN ARRAY ARRAY['competitor_scheduled_monitor_runs','competitor_scheduled_monitor_notifications','competitor_scheduled_monitor_group_receipts'] LOOP
    relation := to_regclass('public.' || table_name);
    IF relation IS NULL THEN CONTINUE; END IF;
    SELECT c.relkind INTO relkind FROM pg_class c WHERE c.oid=relation;
    IF relkind <> 'r' THEN
      RAISE EXCEPTION 'scheduled ledger relation kind mismatch';
    END IF;
    EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE',relation);
    marker := obj_description(relation,'pg_class');
    expected_prefix := 'amazon-asin-monitor:scheduled-ledger:v1:competitor:' || table_name || ':';
    IF marker IS NULL OR marker !~ ('^' || expected_prefix || '[a-f0-9]{32}$') THEN
      RAISE EXCEPTION 'scheduled ledger version marker mismatch';
    END IF;
    owned_relations := array_append(owned_relations,relation);
  END LOOP;
  -- Missing names may be claimed concurrently by unrelated objects. Only the
  -- relation identities already locked and validated above belong to rollback.
  IF to_regclass('public.competitor_scheduled_monitor_group_receipts')=ANY(owned_relations) THEN
    DROP TABLE public.competitor_scheduled_monitor_group_receipts;
  END IF;
  IF to_regclass('public.competitor_scheduled_monitor_notifications')=ANY(owned_relations) THEN
    DROP TABLE public.competitor_scheduled_monitor_notifications;
  END IF;
  IF to_regclass('public.competitor_scheduled_monitor_runs')=ANY(owned_relations) THEN
    DROP TABLE public.competitor_scheduled_monitor_runs;
  END IF;
END
$ledger_rollback_preflight$;
COMMIT;
