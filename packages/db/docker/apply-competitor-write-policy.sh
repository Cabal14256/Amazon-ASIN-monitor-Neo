#!/bin/sh
set -eu
exec sh "$(dirname "$0")/apply-competitor-query-matching.sh" \
  "${1:-/opt/asin-monitor/0011_competitor_write_policy.sql}"
