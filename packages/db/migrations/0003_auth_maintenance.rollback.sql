-- Stop maintenance and application writes before rollback. Conflicts fail closed.
SET search_path TO pg_catalog, public;
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';
LOCK TABLE public.audit_logs, public.audit_logs_archive IN ACCESS EXCLUSIVE MODE;

INSERT INTO public.audit_logs (
  id, user_id, username, action, resource, resource_id, resource_name,
  method, path, ip_address, user_agent, request_data, response_status,
  error_message, create_time
) OVERRIDING SYSTEM VALUE
SELECT id, user_id, username, action, resource, resource_id, resource_name,
       method, path, ip_address, user_agent, request_data, response_status,
       error_message, create_time
FROM public.audit_logs_archive
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.audit_logs_archive archive
    LEFT JOIN public.audit_logs hot ON hot.id = archive.id
    WHERE hot.id IS NULL OR to_jsonb(hot) IS DISTINCT FROM to_jsonb(archive)
  ) THEN
    RAISE EXCEPTION 'Audit archive rollback conflict; no records removed';
  END IF;
END $$;

-- Explicit IDs do not advance identity. Never lower the live sequence position.
DO $$
DECLARE
  identity_sequence regclass := pg_get_serial_sequence('public.audit_logs', 'id');
  previous_value bigint;
  retained_max bigint;
BEGIN
  EXECUTE format('SELECT last_value FROM %s', identity_sequence) INTO previous_value;
  SELECT COALESCE(max(id), 1) INTO retained_max FROM public.audit_logs;
  PERFORM setval(identity_sequence, GREATEST(previous_value, retained_max), true);
END $$;

DROP VIEW public.audit_logs_all;
DROP TABLE public.audit_logs_archive;
COMMIT;
