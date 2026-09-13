-- Stop/revert Neo notification consumers first. RESTRICT deliberately refuses
-- to remove independently created indexes or other dependent objects.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP COLLATION IF EXISTS public.neo_notification_country_ci RESTRICT;
COMMIT;
