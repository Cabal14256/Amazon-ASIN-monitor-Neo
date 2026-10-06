'use strict';

const { StringDecoder } = require('node:string_decoder');

function migrationPlan(filenames) {
  return filenames
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .filter((name) => !name.endsWith('.rollback.sql'))
    .filter((name) => name !== '0000_baseline.sql')
    .sort()
    .map((filename) => {
      if (!/^\d{4}_[a-z_]+\.sql$/.test(filename))
        throw new Error('Unclassified migration requires fixture review');
      const version = Number(filename.slice(0, 4));
      let domains;
      if (version >= 1 && version <= 8) domains = ['primary'];
      else if (version === 9) domains = ['primary', 'competitor'];
      else if ([10, 11, 14, 15].includes(version)) domains = ['competitor'];
      else if ([12, 13].includes(version)) domains = ['primary'];
      else if (filename === '0016_scheduled_monitor_primary.sql')
        domains = ['primary'];
      else if (filename === '0016_scheduled_monitor_competitor.sql')
        domains = ['competitor'];
      else throw new Error('Unclassified migration requires fixture review');
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
