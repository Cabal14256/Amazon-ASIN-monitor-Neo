#!/bin/sh
set -eu

baseline_path="${1:-/opt/asin-monitor/0000_baseline.sql}"
postgres_user="${POSTGRES_USER:-postgres}"
primary_database="${POSTGRES_DB:-amazon_asin_monitor}"
competitor_database="${COMPETITOR_DATABASE:-amazon_competitor_monitor}"

validate_identifier() {
  case "$1" in
    '' | *[!a-zA-Z0-9_]*)
      printf 'database identifier contains unsupported characters\n' >&2
      exit 1
      ;;
  esac
}

validate_identifier "$primary_database"
validate_identifier "$competitor_database"

if [ "$primary_database" = "$competitor_database" ]; then
  printf 'primary and competitor databases must be different\n' >&2
  exit 1
fi

if [ ! -r "$baseline_path" ]; then
  printf 'PostgreSQL baseline is not readable: %s\n' "$baseline_path" >&2
  exit 1
fi

psql -X -v ON_ERROR_STOP=1 \
  --username "$postgres_user" \
  --dbname postgres \
  --set "primary_database=$primary_database" \
  --set "competitor_database=$competitor_database" \
  --file "$baseline_path"
