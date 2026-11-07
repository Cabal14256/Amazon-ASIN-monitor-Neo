#!/bin/sh
set -eu

exec sh "$(dirname "$0")/apply-competitor-query-matching.sh" \
  "${1:-/opt/asin-monitor/0018_competitor_batch_check_receipts.sql}"
