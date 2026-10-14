'use strict';

const { StringDecoder } = require('node:string_decoder');

function migrationPlan(filenames) {
  const domainsByFilename = new Map([
    ['0001_timescale_aggregates.sql', ['primary']],
    ['0002_timescale_storage_policies.sql', ['primary']],
    ['0003_auth_maintenance.sql', ['primary']],
    ['0004_asin_timestamp_policy.sql', ['primary']],
    ['0005_import_group_collation.sql', ['primary']],
    ['0006_variant_check_receipts.sql', ['primary']],
    ['0007_monitor_history_matching.sql', ['primary']],
    ['0008_monitor_interval_projection.sql', ['primary']],
    ['0009_notification_country_collation.sql', ['primary', 'competitor']],
    ['0010_competitor_query_matching.sql', ['competitor']],
    ['0011_competitor_write_policy.sql', ['competitor']],
    ['0012_primary_monitor.sql', ['primary']],
    ['0013_feishu_revision.sql', ['primary']],
    ['0014_competitor_check_receipts.sql', ['competitor']],
    ['0015_competitor_monitor.sql', ['competitor']],
    ['0016_scheduled_monitor_primary.sql', ['primary']],
    ['0016_scheduled_monitor_competitor.sql', ['competitor']],
  ]);
  return filenames
    .filter((name) => name.endsWith('.sql'))
    .filter((name) => !name.endsWith('.rollback.sql'))
    .filter((name) => name !== '0000_baseline.sql')
    .sort()
    .map((filename) => {
      const domains = domainsByFilename.get(filename);
      if (!domains)
        throw new Error('Unclassified migration requires fixture review');
      return { filename, domains };
    });
}

// Redact complete lines before applying the artifact size bound. Secrets split
// across child stdout/stderr chunks never become partially retained suffixes.
// Oversized or unfinished lines are omitted rather than persisted as fragments.
function createStartupCapture(secrets, maximumBytes = 128 * 1024) {
  const streams = new Map();
  const lines = [];
  let bytes = 0;
  const append = (line) => {
    let safe = line;
    for (const secret of secrets) {
      if (secret) safe = safe.replaceAll(secret, '<redacted>');
    }
    safe = safe.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <redacted>');
    const length = Buffer.byteLength(safe);
    if (length > maximumBytes) return;
    lines.push({ text: safe, bytes: length });
    bytes += length;
    while (bytes > maximumBytes) bytes -= lines.shift().bytes;
  };
  const write = (stream, chunk) => {
    let state = streams.get(stream);
    if (!state) {
      state = {
        decoder: new StringDecoder('utf8'),
        pending: '',
        omitted: false,
      };
      streams.set(stream, state);
    }
    const decoded = state.decoder.write(Buffer.from(chunk));
    for (const fragment of decoded.split(/(?<=\n)/)) {
      const completed = fragment.endsWith('\n');
      if (!state.omitted) {
        state.pending += fragment;
        if (Buffer.byteLength(state.pending) > maximumBytes) {
          state.pending = '';
          state.omitted = true;
          append('[oversized startup line omitted]\n');
        }
      }
      if (completed) {
        if (!state.omitted) append(state.pending);
        state.pending = '';
        state.omitted = false;
      }
    }
  };
  const finish = () => {
    for (const state of streams.values()) {
      if (state.pending || state.decoder.end())
        append('[unfinished startup line omitted]\n');
      state.pending = '';
    }
    return lines.map((line) => line.text).join('');
  };
  return { write, finish };
}

module.exports = { createStartupCapture, migrationPlan };
