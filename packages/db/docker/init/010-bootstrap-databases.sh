#!/bin/sh
set -eu

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

psql -X -v ON_ERROR_STOP=1 \
  --username "$postgres_user" \
  --dbname postgres \
  --set "database_name=$competitor_database" <<'SQL'
SELECT format('CREATE DATABASE %I', :'database_name')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = :'database_name'
)
\gexec
SQL

for database in "$primary_database" "$competitor_database"; do
  psql -X -v ON_ERROR_STOP=1 \
    --username "$postgres_user" \
    --dbname "$database" <<'SQL'
CREATE EXTENSION IF NOT EXISTS timescaledb;
SQL
done
