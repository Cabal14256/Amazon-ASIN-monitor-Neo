#!/bin/sh
set -eu

domain="${1:-}"
case "$domain" in
  primary | competitor) ;;
  *)
    printf 'Scheduled monitor domain must be primary or competitor\n' >&2
    exit 1
    ;;
esac
migration_path="${2:-/opt/asin-monitor/0016_scheduled_monitor_${domain}.sql}"
postgres_user="${POSTGRES_USER:-postgres}"
primary_database="${POSTGRES_DB:-amazon_asin_monitor}"
competitor_database="${COMPETITOR_DATABASE:-amazon_competitor_monitor}"
for database in "$primary_database" "$competitor_database"; do
  case "$database" in
    '' | *[!a-zA-Z0-9_]*)
      printf 'Scheduled monitor database identifier contains unsupported characters\n' >&2
      exit 1
      ;;
  esac
done
if [ "$primary_database" = "$competitor_database" ]; then
  printf 'Scheduled monitor logical databases must differ\n' >&2
  exit 1
fi
if [ ! -r "$migration_path" ]; then
  printf 'Scheduled monitor migration is not readable\n' >&2
  exit 1
fi
database="$primary_database"
if [ "$domain" = competitor ]; then
  database="$competitor_database"
fi
psql -X -v ON_ERROR_STOP=1 --username "$postgres_user" \
  --dbname "$database" --file "$migration_path"
