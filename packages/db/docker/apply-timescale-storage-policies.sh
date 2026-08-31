#!/bin/sh
set -eu

migration_path="${1:-/opt/asin-monitor/0002_timescale_storage_policies.sql}"
postgres_user="${POSTGRES_USER:-postgres}"
primary_database="${POSTGRES_DB:-amazon_asin_monitor}"
retention_days="${TIMESCALE_RETENTION_DAYS:-}"

validate_identifier() {
  case "$1" in
    '' | *[!a-zA-Z0-9_]*)
      printf 'database identifier contains unsupported characters\n' >&2
      exit 1
      ;;
  esac
}

validate_identifier "$primary_database"

if [ ! -r "$migration_path" ]; then
  printf 'Timescale storage-policy migration is not readable: %s\n' "$migration_path" >&2
  exit 1
fi

if [ -n "$retention_days" ]; then
  case "$retention_days" in
    *[!0-9]*)
      printf 'TIMESCALE_RETENTION_DAYS must be an integer >= 800\n' >&2
      exit 1
      ;;
  esac
  if [ "$retention_days" -lt 800 ]; then
    printf 'TIMESCALE_RETENTION_DAYS must be >= 800\n' >&2
    exit 1
  fi
  PGOPTIONS="-c asin_monitor.monitor_history_retention_days=$retention_days" \
    psql -X -v ON_ERROR_STOP=1 \
      --username "$postgres_user" \
      --dbname "$primary_database" \
      --file "$migration_path"
else
  psql -X -v ON_ERROR_STOP=1 \
    --username "$postgres_user" \
    --dbname "$primary_database" \
    --file "$migration_path"
fi
