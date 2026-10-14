#!/bin/sh
set -eu

migration_path="${1:-/opt/asin-monitor/0017_catalog_operation_fence.sql}"
postgres_user="${POSTGRES_USER:-postgres}"
primary_database="${POSTGRES_DB:-amazon_asin_monitor}"
competitor_database="${COMPETITOR_DATABASE:-amazon_competitor_monitor}"
for database in "$primary_database" "$competitor_database"; do
  case "$database" in
    '' | *[!a-zA-Z0-9_]*)
      printf 'Catalog fence database identifier contains unsupported characters\n' >&2
      exit 1
      ;;
  esac
done
if [ "$primary_database" = "$competitor_database" ]; then
  printf 'Catalog fence primary and competitor databases must differ\n' >&2
  exit 1
fi
if [ ! -r "$migration_path" ]; then
  printf 'Catalog fence migration is not readable\n' >&2
  exit 1
fi
# The fence for both catalog domains belongs only to the primary database.
psql -X -v ON_ERROR_STOP=1 --username "$postgres_user" \
  --dbname "$primary_database" --file "$migration_path"
