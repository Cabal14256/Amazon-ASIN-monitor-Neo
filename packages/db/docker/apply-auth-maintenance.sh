#!/bin/sh
set -eu

migration_path="${1:-/opt/asin-monitor/0003_auth_maintenance.sql}"
postgres_user="${POSTGRES_USER:-postgres}"
primary_database="${POSTGRES_DB:-amazon_asin_monitor}"

case "$primary_database" in
  '' | *[!a-zA-Z0-9_]*)
    printf 'database identifier contains unsupported characters\n' >&2
    exit 1
    ;;
esac

if [ ! -r "$migration_path" ]; then
  printf 'Authentication maintenance migration is not readable\n' >&2
  exit 1
fi

psql -X -v ON_ERROR_STOP=1 \
  --username "$postgres_user" \
  --dbname "$primary_database" \
  --file "$migration_path"
