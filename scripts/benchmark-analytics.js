#!/usr/bin/env node
/**
 * Analytics correctness and performance promotion gate.
 *
 * The machine report intentionally contains only timings, HTTP status codes,
 * normalized-response digests, shapes, window boundaries, and first-difference
 * paths. Bearer tokens, cookies, response payloads, and filter values are never
 * persisted.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REQUIRED_TIME_SLOTS = ['hour', 'day', 'month'];
const REQUIRED_WINDOWS = ['hot', 'cold'];

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  return parsed;
}

function normalizeBaseUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const url = new URL(text);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Benchmark base URLs must use http or https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'Benchmark base URLs must not contain credentials, query strings, or fragments',
    );
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/api/v1')) {
    url.pathname = pathname;
  } else if (pathname.endsWith('/api')) {
    url.pathname = `${pathname}/v1`;
  } else {
    url.pathname = `${pathname}/api/v1`.replace(/\/+/g, '/');
  }
  return url.toString().replace(/\/$/, '');
}

function joinApiUrl(baseUrl, endpointPath, query) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  const requestPath = String(endpointPath || '').replace(/^\/+/, '');
  url.pathname = `${basePath}/${requestPath}`.replace(/\/+/g, '/');
  url.search = query || '';
  return url.toString();
}

function integerArg(value, name, fallback, minimum) {
  const source = value === undefined ? fallback : value;
  const parsed = Number(source);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`--${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function numberArg(value, name, fallback, minimum) {
  const source = value === undefined ? fallback : value;
  const parsed = Number(source);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`--${name} must be a number >= ${minimum}`);
  }
  return parsed;
}

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

function calcStats(runs) {
  const durations = runs
    .filter((run) => run.ok && Number.isFinite(run.durationMs))
    .map((run) => run.durationMs);
  const totalCount = runs.length;
  const successCount = durations.length;
  const sum = durations.reduce((total, duration) => total + duration, 0);
  return {
    count: totalCount,
    successCount,
    failCount: totalCount - successCount,
    passRate: totalCount === 0 ? 0 : (successCount / totalCount) * 100,
    min: successCount === 0 ? null : Math.min(...durations),
    max: successCount === 0 ? null : Math.max(...durations),
    avg: successCount === 0 ? null : sum / successCount,
    p50: successCount === 0 ? null : percentile(durations, 50),
    p90: successCount === 0 ? null : percentile(durations, 90),
    p95: successCount === 0 ? null : percentile(durations, 95),
  };
}

function buildQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) query.set(key, text);
  }
  return query.toString();
}

function normalizeComparableValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeComparableValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeComparableValue(value[key])]),
    );
  }
  return value;
}

function comparableResponse(body) {
  if (
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.prototype.hasOwnProperty.call(body, 'data')
  ) {
    return normalizeComparableValue({
      success: body.success,
      errorCode: body.errorCode,
      data: body.data,
    });
  }
  return normalizeComparableValue(body);
}

function canonicalJson(value) {
  return JSON.stringify(normalizeComparableValue(value));
}

function digestValue(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function responseShape(value) {
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (value === null) return { type: 'null' };
  if (value && typeof value === 'object') {
    return { type: 'object', keys: Object.keys(value).sort() };
  }
  return { type: typeof value };
}

function responseCardinality(value, pathSegments, itemField) {
  let selected = value;
  for (const segment of pathSegments) {
    if (
      selected === null ||
      typeof selected !== 'object' ||
      !Object.prototype.hasOwnProperty.call(selected, segment)
    ) {
      return null;
    }
    selected = selected[segment];
  }
  if (Array.isArray(selected)) {
    if (!itemField) return selected.length;
    let total = 0;
    for (const item of selected) {
      if (
        item === null ||
        typeof item !== 'object' ||
        !Object.prototype.hasOwnProperty.call(item, itemField)
      ) {
        return null;
      }
      const numericValue = Number(item[itemField]);
      if (!Number.isFinite(numericValue)) return null;
      total += numericValue;
    }
    return total;
  }
  if (typeof selected === 'number' && Number.isFinite(selected)) {
    return selected;
  }
  if (typeof selected === 'string') return selected.trim().length;
  if (selected && typeof selected === 'object') {
    return Object.keys(selected).length;
  }
  return null;
}

function firstDifferencePath(left, right, currentPath = '$') {
  if (Object.is(left, right)) return null;
  if (typeof left !== typeof right || left === null || right === null) {
    return currentPath;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return currentPath;
    if (left.length !== right.length) return `${currentPath}.length`;
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstDifferencePath(
        left[index],
        right[index],
        `${currentPath}[${index}]`,
      );
      if (difference) return difference;
    }
    return null;
  }
  if (typeof left === 'object') {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.join('\u0000') !== rightKeys.join('\u0000')) {
      return `${currentPath}.__keys`;
    }
    for (const key of leftKeys) {
      const difference = firstDifferencePath(
        left[key],
        right[key],
        `${currentPath}.${key}`,
      );
      if (difference) return difference;
    }
    return null;
  }
  return currentPath;
}

function requireText(value, name) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`Missing required --${name}`);
  return text;
}

function expectedSourceArg(value, name, fallback) {
  const source = String(value === undefined ? fallback : value)
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9:+._-]{0,63}$/.test(source)) {
    throw new Error(
      `--${name} must contain only lowercase letters, numbers, colon, plus, dot, underscore, or hyphen`,
    );
  }
  return source;
}

function validateWindows(windows) {
  const parsed = {};
  for (const windowName of REQUIRED_WINDOWS) {
    const window = windows[windowName];
    const startMs = Date.parse(window.startTime);
    const endMs = Date.parse(window.endTime);
    if (!Number.isFinite(startMs)) {
      throw new Error(`--${windowName}-start-time must be a valid timestamp`);
    }
    if (!Number.isFinite(endMs)) {
      throw new Error(`--${windowName}-end-time must be a valid timestamp`);
    }
    if (startMs >= endMs) {
      throw new Error(
        `--${windowName}-start-time must be earlier than --${windowName}-end-time`,
      );
    }
    parsed[windowName] = { startMs, endMs };
  }
  if (parsed.cold.endMs > parsed.hot.startMs) {
    throw new Error(
      '--cold-end-time must be earlier than or equal to --hot-start-time',
    );
  }
  return windows;
}

function parseTimeSlots(value) {
  const slots = [
    ...new Set(
      String(value || REQUIRED_TIME_SLOTS.join(','))
        .split(',')
        .map((slot) => slot.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (
    slots.length !== REQUIRED_TIME_SLOTS.length ||
    REQUIRED_TIME_SLOTS.some((slot) => !slots.includes(slot))
  ) {
    throw new Error('--time-slots must contain exactly hour,day,month');
  }
  return REQUIRED_TIME_SLOTS;
}

function buildMatrix(config) {
  const cases = [];
  for (const windowName of REQUIRED_WINDOWS) {
    const window = config.windows[windowName];
    for (const timeSlotGranularity of config.timeSlots) {
      const common = {
        startTime: window.startTime,
        endTime: window.endTime,
        timeSlotGranularity,
      };
      for (const endpoint of [
        {
          suffix: 'all-countries',
          path: '/monitor-history/statistics/all-countries-summary',
          params: common,
          cardinalityPath: ['data', 'totalChecks'],
          requiresDatabaseExecution: true,
        },
        {
          suffix: 'region',
          path: '/monitor-history/statistics/region-summary',
          params: common,
          cardinalityPath: ['data'],
          cardinalityItemField: 'totalChecks',
          requiresDatabaseExecution: true,
        },
        {
          suffix: 'period-unfiltered',
          path: '/monitor-history/statistics/period-summary',
          params: { ...common, current: 1, pageSize: config.pageSize },
          cardinalityPath: ['data', 'list'],
          requiresDatabaseExecution: true,
        },
        {
          suffix: 'period-filtered',
          path: '/monitor-history/statistics/period-summary',
          params: {
            ...common,
            country: config.filters.country,
            site: config.filters.site,
            brand: config.filters.brand,
            current: 1,
            pageSize: config.pageSize,
          },
          cardinalityPath: ['data', 'list'],
          requiresDatabaseExecution: true,
        },
      ]) {
        const query = buildQuery(endpoint.params);
        cases.push({
          name: `${windowName}-${timeSlotGranularity}-${endpoint.suffix}`,
          window: windowName,
          granularity: timeSlotGranularity,
          path: endpoint.path,
          query,
          queryKeys: Object.keys(endpoint.params).sort(),
          expectedStatus: 200,
          cardinalityPath: endpoint.cardinalityPath,
          cardinalityItemField: endpoint.cardinalityItemField,
          requiresDatabaseExecution: endpoint.requiresDatabaseExecution,
          expectedOldSource: endpoint.requiresDatabaseExecution
            ? config.expectedOldSource
            : undefined,
          expectedNewSource: endpoint.requiresDatabaseExecution
            ? config.expectedNewSource
            : undefined,
          minimumCardinality: 1,
        });
      }
    }

    for (const endpoint of [
      {
        suffix: 'variant-group-summary',
        path: '/monitor-history/statistics/by-variant-group',
        params: {
          country: config.filters.country,
          startTime: window.startTime,
          endTime: window.endTime,
          limit: config.groupLimit,
        },
        cardinalityPath: ['data'],
      },
      {
        suffix: 'variant-group-filtered-duration',
        path: '/monitor-history/abnormal-duration-statistics',
        params: {
          variantGroupId: config.filters.variantGroupId,
          country: config.filters.country,
          startTime: window.startTime,
          endTime: window.endTime,
          includeSeries: 1,
        },
        cardinalityPath: ['data', 'data'],
        cardinalityItemField: 'totalChecks',
      },
    ]) {
      const query = buildQuery(endpoint.params);
      cases.push({
        name: `${windowName}-${endpoint.suffix}`,
        window: windowName,
        granularity: 'adaptive',
        path: endpoint.path,
        query,
        queryKeys: Object.keys(endpoint.params).sort(),
        expectedStatus: 200,
        cardinalityPath: endpoint.cardinalityPath,
        cardinalityItemField: endpoint.cardinalityItemField,
        minimumCardinality: 1,
      });
    }
  }
  return cases;
}

async function requestWithTiming(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);
  const startedAt = process.hrtime.bigint();
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: options.headers,
      signal: controller.signal,
    });
    const text = await response.text();
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      return {
        ok: false,
        status: response.status,
        durationMs,
        errorCode: 'INVALID_JSON',
        comparable: null,
      };
    }
    const applicationSucceeded =
      !parsed ||
      typeof parsed !== 'object' ||
      !Object.prototype.hasOwnProperty.call(parsed, 'success') ||
      parsed.success !== false;
    const ok = response.ok && applicationSucceeded;
    const responseMeta =
      parsed &&
      typeof parsed === 'object' &&
      parsed.meta &&
      typeof parsed.meta === 'object'
        ? parsed.meta
        : null;
    return {
      ok,
      status: response.status,
      durationMs,
      errorCode: ok
        ? null
        : response.ok
        ? 'APPLICATION_FAILURE'
        : 'HTTP_FAILURE',
      cacheHit:
        typeof responseMeta?.cacheHit === 'boolean'
          ? responseMeta.cacheHit
          : null,
      source:
        typeof responseMeta?.source === 'string'
          ? responseMeta.source.slice(0, 64)
          : null,
      comparable: comparableResponse(parsed),
    };
  } catch (error) {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const timedOut =
      error &&
      (error.name === 'AbortError' || /aborted/i.test(error.message || ''));
    return {
      ok: false,
      status: 0,
      durationMs,
      errorCode: timedOut ? 'TIMEOUT' : 'NETWORK_FAILURE',
      cacheHit: null,
      source: null,
      comparable: null,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function safeRun(result, run) {
  return {
    run,
    ok: result.ok,
    status: result.status,
    durationMs: result.durationMs,
    errorCode: result.errorCode,
    cacheHit: result.cacheHit,
    source: result.source,
    responseDigest:
      result.comparable !== null ? digestValue(result.comparable) : null,
    responseShape: responseShape(result.comparable),
  };
}

function comparePairResults(oldResult, newResult, benchmarkCase, run) {
  const statusesMatch =
    oldResult.status === benchmarkCase.expectedStatus &&
    newResult.status === benchmarkCase.expectedStatus &&
    oldResult.status === newResult.status;
  const oldCardinality = responseCardinality(
    oldResult.comparable,
    benchmarkCase.cardinalityPath,
    benchmarkCase.cardinalityItemField,
  );
  const newCardinality = responseCardinality(
    newResult.comparable,
    benchmarkCase.cardinalityPath,
    benchmarkCase.cardinalityItemField,
  );
  const cardinalityMatches =
    oldCardinality !== null &&
    newCardinality !== null &&
    oldCardinality >= benchmarkCase.minimumCardinality &&
    newCardinality >= benchmarkCase.minimumCardinality;
  const databaseExecutionMatches =
    !benchmarkCase.requiresDatabaseExecution ||
    (oldResult.cacheHit === false && newResult.cacheHit === false);
  const databaseSourceMatches =
    !benchmarkCase.requiresDatabaseExecution ||
    (oldResult.source === benchmarkCase.expectedOldSource &&
      newResult.source === benchmarkCase.expectedNewSource);
  let differencePath = '$.__unavailable';
  if (!statusesMatch) {
    differencePath = '$.__httpStatus';
  } else if (oldResult.comparable !== null && newResult.comparable !== null) {
    differencePath = firstDifferencePath(
      oldResult.comparable,
      newResult.comparable,
    );
    if (differencePath === null && !cardinalityMatches) {
      differencePath = '$.__cardinality';
    }
    if (differencePath === null && !databaseExecutionMatches) {
      differencePath = '$.__databaseExecution';
    }
    if (differencePath === null && !databaseSourceMatches) {
      differencePath = '$.__databaseSource';
    }
  }
  return {
    run,
    matches: differencePath === null,
    differencePath,
    statusesMatch,
    expectedStatus: benchmarkCase.expectedStatus,
    oldStatus: oldResult.status,
    newStatus: newResult.status,
    cardinalityMatches,
    databaseExecutionMatches,
    databaseSourceMatches,
    requiresDatabaseExecution: Boolean(benchmarkCase.requiresDatabaseExecution),
    expectedOldSource: benchmarkCase.expectedOldSource || null,
    expectedNewSource: benchmarkCase.expectedNewSource || null,
    oldCacheHit: oldResult.cacheHit,
    newCacheHit: newResult.cacheHit,
    oldSource: oldResult.source,
    newSource: newResult.source,
    cardinalityPath: `$.${benchmarkCase.cardinalityPath.join('.')}${
      benchmarkCase.cardinalityItemField
        ? `[*].${benchmarkCase.cardinalityItemField} (sum)`
        : ''
    }`,
    minimumCardinality: benchmarkCase.minimumCardinality,
    oldCardinality,
    newCardinality,
    oldDigest:
      oldResult.comparable === null ? null : digestValue(oldResult.comparable),
    newDigest:
      newResult.comparable === null ? null : digestValue(newResult.comparable),
  };
}

async function runCase(targets, benchmarkCase, options) {
  const warmups = [];
  const runs = { old: [], new: [] };
  const comparisons = [];

  for (let warmup = 1; warmup <= options.warmup; warmup += 1) {
    for (const target of targets) {
      const result = await requestWithTiming(
        joinApiUrl(target.base, benchmarkCase.path, benchmarkCase.query),
        { timeoutMs: options.timeoutMs, headers: target.headers },
      );
      warmups.push({ target: target.key, ...safeRun(result, warmup) });
      process.stdout.write(
        `[warmup] ${benchmarkCase.name} | ${target.label} | ${warmup}/${
          options.warmup
        } | ${result.ok ? 'ok' : result.errorCode}\n`,
      );
    }
  }

  for (let run = 1; run <= options.runs; run += 1) {
    const pair = {};
    const orderedTargets = run % 2 === 0 ? [...targets].reverse() : targets;
    for (const target of orderedTargets) {
      const result = await requestWithTiming(
        joinApiUrl(target.base, benchmarkCase.path, benchmarkCase.query),
        { timeoutMs: options.timeoutMs, headers: target.headers },
      );
      pair[target.key] = result;
      runs[target.key].push(safeRun(result, run));
      process.stdout.write(
        `[run] ${benchmarkCase.name} | ${target.label} | ${run}/${
          options.runs
        } | ${
          result.ok ? `${result.durationMs.toFixed(2)} ms` : result.errorCode
        }\n`,
      );
    }
    const oldResult = pair.old;
    const newResult = pair.new;
    comparisons.push(
      comparePairResults(oldResult, newResult, benchmarkCase, run),
    );
  }

  const oldStats = calcStats(runs.old);
  const newStats = calcStats(runs.new);
  const speedup =
    oldStats.p95 !== null && newStats.p95 !== null && newStats.p95 > 0
      ? oldStats.p95 / newStats.p95
      : null;
  const requestGate =
    warmups.every(
      (item) => item.ok && item.status === benchmarkCase.expectedStatus,
    ) &&
    runs.old.every(
      (item) => item.ok && item.status === benchmarkCase.expectedStatus,
    ) &&
    runs.new.every(
      (item) => item.ok && item.status === benchmarkCase.expectedStatus,
    );
  const sampleGate =
    oldStats.successCount === options.runs &&
    newStats.successCount === options.runs;
  const correctnessGate = comparisons.every((item) => item.matches);
  const statusGate = comparisons.every((item) => item.statusesMatch);
  const cardinalityGate = comparisons.every((item) => item.cardinalityMatches);
  const databaseExecutionGate = comparisons.every(
    (item) => item.databaseExecutionMatches,
  );
  const databaseSourceGate = comparisons.every(
    (item) => item.databaseSourceMatches,
  );
  const performanceGate = speedup !== null && speedup >= options.minSpeedup;

  return {
    name: benchmarkCase.name,
    window: benchmarkCase.window,
    granularity: benchmarkCase.granularity,
    path: benchmarkCase.path,
    queryKeys: benchmarkCase.queryKeys,
    warmups,
    runs,
    comparisons,
    stats: { old: oldStats, new: newStats, speedup },
    gates: {
      requests: requestGate,
      samples: sampleGate,
      statuses: statusGate,
      cardinality: cardinalityGate,
      databaseExecution: databaseExecutionGate,
      databaseSource: databaseSourceGate,
      correctness: correctnessGate,
      performance: performanceGate,
      passed:
        requestGate &&
        sampleGate &&
        statusGate &&
        cardinalityGate &&
        databaseExecutionGate &&
        databaseSourceGate &&
        correctnessGate &&
        performanceGate,
    },
  };
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, content, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function formatMs(value) {
  return value === null ? 'N/A' : `${value.toFixed(2)} ms`;
}

function buildMarkdown(report) {
  const lines = [
    '# Analytics Correctness and Performance Gate',
    '',
    `- Status: ${report.status}`,
    `- Created At: ${report.meta.createdAt}`,
    `- Environment: ${report.meta.environmentLabel}`,
    `- Dataset Rows: ${report.meta.datasetRows}`,
    `- Dataset Profile: ${report.meta.datasetProfile}`,
    `- Warmup / Runs: ${report.meta.warmup} / ${report.meta.runs}`,
    `- Required P95 Speedup: ${report.meta.minSpeedup}x`,
    `- Matrix Cases: ${report.cases.length}`,
    '',
    '| Case | Old P50 | Old P90 | Old P95 | New P50 | New P90 | New P95 | Speedup | Non-empty | DB executed | DB source | Correct | Passed |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const benchmarkCase of report.cases) {
    lines.push(
      `| ${benchmarkCase.name} | ${formatMs(
        benchmarkCase.stats.old.p50,
      )} | ${formatMs(benchmarkCase.stats.old.p90)} | ${formatMs(
        benchmarkCase.stats.old.p95,
      )} | ${formatMs(benchmarkCase.stats.new.p50)} | ${formatMs(
        benchmarkCase.stats.new.p90,
      )} | ${formatMs(benchmarkCase.stats.new.p95)} | ${
        benchmarkCase.stats.speedup === null
          ? 'N/A'
          : `${benchmarkCase.stats.speedup.toFixed(2)}x`
      } | ${benchmarkCase.gates.cardinality ? 'yes' : 'no'} | ${
        benchmarkCase.gates.databaseExecution ? 'yes' : 'no'
      } | ${benchmarkCase.gates.databaseSource ? 'yes' : 'no'} | ${
        benchmarkCase.gates.correctness ? 'yes' : 'no'
      } | ${benchmarkCase.gates.passed ? 'yes' : 'no'} |`,
    );
  }
  lines.push(
    '',
    'The report excludes authorization headers, cookies, filter values, connection strings, and raw response bodies.',
    '',
    `Reproduce: \`${report.meta.reproductionCommand}\``,
    '',
  );
  return lines.join('\n');
}

function usage() {
  return `
Usage:
  node scripts/benchmark-analytics.js --old-base <url> --new-base <url> \\
    --hot-start-time <time> --hot-end-time <time> \\
    --cold-start-time <time> --cold-end-time <time> \\
    --country <value> --site <value> --brand <value> \\
    --variant-group-id <value> --environment-label <label> \\
    --dataset-rows <count> --dataset-profile <description> [options]

Required promotion evidence:
  --old-base / --new-base       Targets, with or without /api or /api/v1
  --hot-start-time / --hot-end-time
  --cold-start-time / --cold-end-time
  --country / --site / --brand / --variant-group-id
  --environment-label
  --dataset-rows                Positive integer
  --dataset-profile             Non-sensitive fixture/data description

Database execution evidence:
  The 24 database-backed cases require meta.cacheHit=false on every measured
  response, meta.source=raw on the old target, and meta.source=agg on the new
  target by default. Run both targets with isolated caches and their supported
  cache bypass/disable mode; cached, raw-fallback, or missing execution metadata
  fails the gate.

Options:
  --time-slots                  Must be hour,day,month (default: all three)
  --runs                        Measured pairs per case, minimum 5 (default: 7)
  --warmup                      Warmups per target/case, minimum 1 (default: 2)
  --timeout-ms                  Request timeout (default: 120000)
  --min-speedup                 Required old/new P95 ratio, minimum 3 (default: 3)
  --page-size                   period-summary page size (default: 100)
  --group-limit                 group summary limit (default: 100)
  --token                       Bearer token; never logged or persisted
  --label-old / --label-new     Report labels (default: old/new)
  --expected-old-source         Required old DB source (default: raw)
  --expected-new-source         Required new DB source (default: agg; raw/cache forbidden)
  --output-dir                  Default: artifacts/analytics-benchmark
  --dry-run                     Validate and print URLs only
  --help
`;
}

function buildConfig(args) {
  const oldBase = normalizeBaseUrl(
    args['old-base'] || process.env.BENCH_OLD_BASE_URL,
  );
  const newBase = normalizeBaseUrl(
    args['new-base'] ||
      process.env.BENCH_NEW_BASE_URL ||
      process.env.API_BASE_URL,
  );
  if (!oldBase || !newBase) {
    throw new Error('Missing required --old-base or --new-base');
  }
  const windows = validateWindows({
    hot: {
      startTime: requireText(
        args['hot-start-time'] || args['start-time'],
        'hot-start-time',
      ),
      endTime: requireText(
        args['hot-end-time'] || args['end-time'],
        'hot-end-time',
      ),
    },
    cold: {
      startTime: requireText(args['cold-start-time'], 'cold-start-time'),
      endTime: requireText(args['cold-end-time'], 'cold-end-time'),
    },
  });
  const expectedOldSource = expectedSourceArg(
    args['expected-old-source'],
    'expected-old-source',
    'raw',
  );
  const expectedNewSource = expectedSourceArg(
    args['expected-new-source'],
    'expected-new-source',
    'agg',
  );
  if (
    expectedNewSource === 'raw' ||
    expectedNewSource.startsWith('raw:') ||
    expectedNewSource === 'cache' ||
    expectedNewSource.startsWith('cache+') ||
    expectedNewSource.startsWith('cache:')
  ) {
    throw new Error(
      '--expected-new-source must identify an aggregate-backed, non-cache source',
    );
  }
  return {
    oldBase,
    newBase,
    oldLabel: String(args['label-old'] || 'old'),
    newLabel: String(args['label-new'] || 'new'),
    expectedOldSource,
    expectedNewSource,
    token: String(args.token || process.env.BENCH_TOKEN || ''),
    windows,
    filters: {
      country: requireText(args.country, 'country'),
      site: requireText(args.site, 'site'),
      brand: requireText(args.brand, 'brand'),
      variantGroupId: requireText(args['variant-group-id'], 'variant-group-id'),
    },
    environmentLabel: requireText(
      args['environment-label'],
      'environment-label',
    ),
    datasetRows: integerArg(args['dataset-rows'], 'dataset-rows', undefined, 1),
    datasetProfile: requireText(args['dataset-profile'], 'dataset-profile'),
    timeSlots: parseTimeSlots(args['time-slots']),
    runs: integerArg(args.runs, 'runs', 7, 5),
    warmup: integerArg(args.warmup, 'warmup', 2, 1),
    timeoutMs: integerArg(args['timeout-ms'], 'timeout-ms', 120000, 1000),
    minSpeedup: numberArg(args['min-speedup'], 'min-speedup', 3, 3),
    pageSize: integerArg(args['page-size'], 'page-size', 100, 1),
    groupLimit: integerArg(args['group-limit'], 'group-limit', 100, 1),
    outputDir: path.resolve(
      String(args['output-dir'] || 'artifacts/analytics-benchmark'),
    ),
    dryRun: Boolean(args['dry-run']),
  };
}

function reproductionCommand(config) {
  return [
    'node scripts/benchmark-analytics.js',
    `--old-base ${config.oldBase}`,
    `--new-base ${config.newBase}`,
    `--expected-old-source ${config.expectedOldSource}`,
    `--expected-new-source ${config.expectedNewSource}`,
    '--hot-start-time <redacted>',
    '--hot-end-time <redacted>',
    '--cold-start-time <redacted>',
    '--cold-end-time <redacted>',
    '--country <redacted>',
    '--site <redacted>',
    '--brand <redacted>',
    '--variant-group-id <redacted>',
    `--environment-label ${JSON.stringify(config.environmentLabel)}`,
    `--dataset-rows ${config.datasetRows}`,
    `--dataset-profile ${JSON.stringify(config.datasetProfile)}`,
    `--runs ${config.runs}`,
    `--warmup ${config.warmup}`,
    `--min-speedup ${config.minSpeedup}`,
    config.token ? '--token <redacted>' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  const config = buildConfig(args);
  const matrix = buildMatrix(config);
  const headers = { Accept: 'application/json' };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  const targets = [
    { key: 'old', label: config.oldLabel, base: config.oldBase, headers },
    { key: 'new', label: config.newLabel, base: config.newBase, headers },
  ];

  if (config.dryRun) {
    for (const benchmarkCase of matrix) {
      for (const target of targets) {
        process.stdout.write(
          `${benchmarkCase.name} | ${target.label} | ${joinApiUrl(
            target.base,
            benchmarkCase.path,
            benchmarkCase.query,
          )}\n`,
        );
      }
    }
    return;
  }

  const cases = [];
  for (const benchmarkCase of matrix) {
    cases.push(
      await runCase(targets, benchmarkCase, {
        runs: config.runs,
        warmup: config.warmup,
        timeoutMs: config.timeoutMs,
        minSpeedup: config.minSpeedup,
      }),
    );
  }

  const passed = cases.every((benchmarkCase) => benchmarkCase.gates.passed);
  const report = {
    schemaVersion: 3,
    status: passed ? 'passed' : 'failed',
    meta: {
      createdAt: new Date().toISOString(),
      environmentLabel: config.environmentLabel,
      datasetRows: config.datasetRows,
      datasetProfile: config.datasetProfile,
      oldLabel: config.oldLabel,
      newLabel: config.newLabel,
      expectedOldSource: config.expectedOldSource,
      expectedNewSource: config.expectedNewSource,
      oldBase: config.oldBase,
      newBase: config.newBase,
      windows: REQUIRED_WINDOWS,
      windowRanges: config.windows,
      timeSlots: REQUIRED_TIME_SLOTS,
      warmup: config.warmup,
      runs: config.runs,
      timeoutMs: config.timeoutMs,
      minSpeedup: config.minSpeedup,
      reproductionCommand: reproductionCommand(config),
      sensitiveDataPersisted: false,
    },
    gates: {
      requests: cases.every((item) => item.gates.requests),
      samples: cases.every((item) => item.gates.samples),
      statuses: cases.every((item) => item.gates.statuses),
      cardinality: cases.every((item) => item.gates.cardinality),
      databaseExecution: cases.every((item) => item.gates.databaseExecution),
      databaseSource: cases.every((item) => item.gates.databaseSource),
      correctness: cases.every((item) => item.gates.correctness),
      performance: cases.every((item) => item.gates.performance),
      passed,
    },
    cases,
  };

  const stamp = timestamp();
  const jsonPath = path.join(config.outputDir, `analytics-gate-${stamp}.json`);
  const markdownPath = path.join(
    config.outputDir,
    `analytics-gate-${stamp}.md`,
  );
  atomicWrite(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  atomicWrite(markdownPath, buildMarkdown(report));
  process.stdout.write(`Gate status: ${report.status}\n`);
  process.stdout.write(`JSON report: ${jsonPath}\n`);
  process.stdout.write(`Markdown report: ${markdownPath}\n`);
  if (!passed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${error && error.message ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  atomicWrite,
  buildConfig,
  buildMatrix,
  calcStats,
  canonicalJson,
  comparePairResults,
  comparableResponse,
  digestValue,
  firstDifferencePath,
  joinApiUrl,
  normalizeBaseUrl,
  normalizeComparableValue,
  percentile,
  responseCardinality,
  responseShape,
  validateWindows,
};
