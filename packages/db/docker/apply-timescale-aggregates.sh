#!/bin/sh
set -eu

migration_path="${1:-/opt/asin-monitor/0001_timescale_aggregates.sql}"
postgres_user="${POSTGRES_USER:-postgres}"
primary_database="${POSTGRES_DB:-amazon_asin_monitor}"

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
  printf 'Timescale aggregate migration is not readable: %s\n' "$migration_path" >&2
  exit 1
fi

psql -X -v ON_ERROR_STOP=1 \
  --username "$postgres_user" \
  --dbname "$primary_database" \
  --file "$migration_path"
