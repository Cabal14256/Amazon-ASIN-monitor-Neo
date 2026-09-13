#!/bin/sh
set -eu

migration_path="${1:-/opt/asin-monitor/0009_notification_country_collation.sql}"
postgres_user="${POSTGRES_USER:-postgres}"
primary_database="${POSTGRES_DB:-amazon_asin_monitor}"
competitor_database="${COMPETITOR_DATABASE:-amazon_competitor_monitor}"
for database in "$primary_database" "$competitor_database"; do
  case "$database" in
    '' | *[!a-zA-Z0-9_]*)
      printf 'database identifier contains unsupported characters\n' >&2
      exit 1
      ;;
  esac
done
if [ "$primary_database" = "$competitor_database" ]; then
  printf 'primary and competitor databases must be different\n' >&2
  exit 1
fi
if [ ! -r "$migration_path" ]; then
  printf 'Notification collation migration is not readable\n' >&2
  exit 1
fi
for database in "$primary_database" "$competitor_database"; do
  psql -X -v ON_ERROR_STOP=1 --username "$postgres_user" \
    --dbname "$database" --file "$migration_path"
done
