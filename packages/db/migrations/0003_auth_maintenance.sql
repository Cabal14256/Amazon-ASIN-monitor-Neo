-- D4: preserve audit evidence in monthly archive partitions. Run on the primary DB.
SET search_path TO pg_catalog, public;
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.audit_logs_archive (
  LIKE public.audit_logs INCLUDING DEFAULTS INCLUDING STORAGE INCLUDING COMMENTS,
  PRIMARY KEY (create_time, id)
) PARTITION BY RANGE (create_time);

CREATE INDEX IF NOT EXISTS idx_audit_archive_id ON public.audit_logs_archive (id);
CREATE INDEX IF NOT EXISTS idx_audit_archive_user_id ON public.audit_logs_archive (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_archive_username ON public.audit_logs_archive (username);
CREATE INDEX IF NOT EXISTS idx_audit_archive_action ON public.audit_logs_archive (action);
CREATE INDEX IF NOT EXISTS idx_audit_archive_resource ON public.audit_logs_archive (resource);
CREATE INDEX IF NOT EXISTS idx_audit_archive_resource_id ON public.audit_logs_archive (resource_id);

-- Moving a batch is one transaction: every MVCC snapshot sees exactly one copy.
CREATE OR REPLACE VIEW public.audit_logs_all AS
SELECT id, user_id, username, action, resource, resource_id, resource_name,
       method, path, ip_address, user_agent, request_data, response_status,
       error_message, create_time
FROM public.audit_logs
UNION ALL
SELECT id, user_id, username, action, resource, resource_id, resource_name,
       method, path, ip_address, user_agent, request_data, response_status,
       error_message, create_time
FROM public.audit_logs_archive;

COMMENT ON TABLE public.audit_logs_archive IS
  'D4 retained audit evidence; monthly partitions created by bounded maintenance; no automatic archive deletion';
COMMIT;
