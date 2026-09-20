#!/bin/sh
set -eu
migration_path="${1:-/opt/asin-monitor/0010_competitor_query_matching.sql}"
postgres_user="${POSTGRES_USER:-postgres}"
primary_database="${POSTGRES_DB:-amazon_asin_monitor}"
competitor_database="${COMPETITOR_DATABASE:-amazon_competitor_monitor}"
case "$competitor_database" in
  '' | *[!a-zA-Z0-9_]*)
    printf 'Competitor database identifier contains unsupported characters\n' >&2
    exit 1
    ;;
esac
if [ "$primary_database" = "$competitor_database" ]; then
  printf 'Competitor database must differ from the primary database\n' >&2
  exit 1
fi
if [ ! -r "$migration_path" ]; then
  printf 'Competitor query migration is not readable\n' >&2
  exit 1
fi
psql -X -v ON_ERROR_STOP=1 --username "$postgres_user" \
  --dbname "$competitor_database" --file "$migration_path"
