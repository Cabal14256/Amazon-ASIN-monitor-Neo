#!/bin/sh
set -eu
exec sh "$(dirname "$0")/apply-competitor-query-matching.sh" \
  "${1:-/opt/asin-monitor/0015_competitor_monitor.sql}"
