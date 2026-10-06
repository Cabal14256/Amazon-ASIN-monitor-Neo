#!/usr/bin/env node
'use strict';

const { execFile, spawn } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} = require('node:fs/promises');
const { createRequire } = require('node:module');
const { availableParallelism, cpus, tmpdir, totalmem } = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const logger = require('../server/src/utils/logger');
const {
  COLUMNS,
  PROFILE,
  WINDOWS,
  buildFixtureConfig,
  datasetManifest,
  fixtureBatches,
  fixtureRow,
} = require('./analytics-performance-fixture');
const {
  createStartupCapture,
  migrationPlan,
} = require('./analytics-performance-runtime');

const exec = promisify(execFile);
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/analytics-http-performance');

function safeCode(error) {
  const value = String(error?.code ?? error?.name ?? 'UNKNOWN');
  return /^[A-Z0-9_]{1,64}$/i.test(value) ? value : 'UNKNOWN';
}

function isolatedChildEnvironment(config, credentials, cwd) {
  // A fresh cwd prevents both dotenv loaders from reading deployment files.
  // Only operating-system essentials are inherited. No deployment credentials,
  // libpq overrides, token, SP-API settings, or queue/scheduler flags leak in.
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return {
    ...env,
    NODE_ENV: 'test',
    TZ: 'Asia/Shanghai',
    LOG_LEVEL: 'WARN',
    NODE_OPTIONS: '--max-old-space-size=1536',
    PROCESS_ROLE: 'api',
    SCHEDULER_ENABLED: 'false',
    API_RATE_LIMIT_ENABLED: 'false',
    ANALYTICS_STATUS_INTERVAL_ENABLED: '0',
    ANALYTICS_BENCHMARK_CACHE_BYPASS_ENABLED: '1',
    AUTH_DATA_AUTHORITY: 'postgresql',
    REDIS_URL: config.redisUrl,
    BULL_PREFIX: `analytics-http-ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
    RATE_LIMITER_KEY_PREFIX: `analytics-http-ci:${process.env.GITHUB_RUN_ID}`,
    JWT_SECRET: credentials.jwtSecret,
    DB_HOST: config.mysqlHost,
    DB_PORT: String(config.mysqlPort),
    DB_USER: credentials.mysqlUser,
    DB_PASSWORD: credentials.mysqlPassword,
    DB_NAME: config.names.legacyPrimary,
    DB_CONNECTION_LIMIT: '10',
    COMPETITOR_DB_NAME: config.names.legacyCompetitor,
    DATABASE_URL: `postgresql://postgres@${config.postgresHost}:${config.postgresPort}/${config.names.neoPrimary}`,
    COMPETITOR_DATABASE_URL: `postgresql://postgres@${config.postgresHost}:${config.postgresPort}/${config.names.neoCompetitor}`,
    IMPORT_STORAGE_DIRECTORY: path.join(cwd, 'imports'),
  };
}

function normalizeLegacyDdl(ddl, originalDatabase, targetDatabase) {
  if (!/^[a-z_]+_[0-9]+_[0-9]+$/.test(targetDatabase)) {
    throw new Error('Invalid owned MySQL fixture name');
  }
  const literal = `\`${originalDatabase}\``;
  if (ddl.split(literal).length !== 3) {
    throw new Error('Legacy bootstrap database directives changed');
  }
  const rewritten = ddl.replaceAll(literal, `\`${targetDatabase}\``);
  // The existing Legacy SQL oracle explicitly pins unicode_ci. Match that
  // documented contract on every table, including the sessions FK, rather than
  // silently selecting MySQL 8's server default collation for utf8mb4.
  return rewritten.replace(
    /DEFAULT CHARSET=utf8mb4(?: COLLATE=[a-z0-9_]+)?/g,
    'DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  );
}

async function main() {
  const config = buildFixtureConfig(process.env);
  await mkdir(output, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    status: 'preparing',
    generatedAt: new Date().toISOString(),
    phase: 'dependency-preflight',
    revision: (
      await exec('git', ['rev-parse', 'HEAD'], { cwd: root })
    ).stdout.trim(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    hardware: {
      availableCpuCount: availableParallelism(),
      cpuModel: cpus()[0]?.model ?? 'unavailable',
      totalMemoryBytes: totalmem(),
    },
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    databaseNames: config.names,
    versions: {},
    request: {
      transport: 'real loopback HTTP GET; complete response body measured',
      legacyEntry: 'server/src/index.js, complete Express application',
      neoEntry: 'apps/api/dist/main.js, complete Nest/Fastify AppModule',
      identity:
        'synthetic seeded user and session; actual JWT verification, session lookup/touch and authorization providers',
      loginFlowMeasured: false,
      legacyAuthority: 'Legacy MySQL',
      neoAuthority: 'PostgreSQL',
      cache:
        'actual Redis; per-request X-Analytics-Cache-Bypass: 1 accepted by explicit fixture configuration',
      legacySource: 'raw, ANALYTICS_AGG_ENABLED=0',
      neoSource: 'agg, ANALYTICS_AGG_ENABLED=1; real CAGG coverage required',
      statusIntervals:
        'disabled in both applications; adaptive cases retain raw correctness coverage',
      startupAndSeedMeasured: false,
      parallelRequests: 1,
      pairsAlternateOrder: true,
      rateLimit:
        'disabled in both applications for isolated throughput measurement',
      databaseConnectionLimit: { legacy: 10, neo: 10 },
    },
    gate: {
      warmupsPerTargetCase: config.warmup,
      measuredPairsPerCase: config.iterations,
      requestTimeoutMs: 30_000,
      benchmarkDeadlineMs: 900_000,
      requiredAggregateP95Speedup: config.requiredP95Speedup,
      aggregateCases: 24,
      adaptiveCorrectnessOnlyCases: 4,
      classifier: 'scripts/benchmark-analytics.js buildMatrix, unchanged',
    },
    fixtureSchema: {
      legacy:
        'actual init.sql/competitor-init.sql; database names rewritten and table collation pinned to existing oracle unicode_ci',
      mysqlSqlMode:
        'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION; matches existing private Legacy oracle non-ONLY_FULL_GROUP_BY arithmetic semantics',
      neo: 'actual baseline plus all numbered migrations available on this revision; normal dual-database targets',
    },
    physicalCache:
      'warm database/application; no OS cache clearing or claim of physically cold reads',
    isolation:
      'one GitHub job with fresh services; no production service or configured database URL used',
    sensitiveDataPersisted: false,
  };
  const persist = () =>
    writeFile(
      path.join(output, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  await persist();

  const serverRequire = createRequire(path.join(root, 'server/package.json'));
  const dbRequire = createRequire(path.join(root, 'packages/db/package.json'));
  const migrations = migrationPlan(
    await readdir(path.join(root, 'packages/db/migrations')),
  );
  const mysql = serverRequire('mysql2/promise');
  const jwt = serverRequire('jsonwebtoken');
  const { Client } = dbRequire('pg');
  const Redis = dbRequire('ioredis');
  const credentials = {
    mysqlUser: `analytics_ci_${process.env.GITHUB_RUN_ID}_${process.env.GITHUB_RUN_ATTEMPT}`,
    mysqlPassword: randomBytes(24).toString('hex'),
    jwtSecret: randomBytes(32).toString('hex'),
  };
  const secrets = new Set(Object.values(credentials));
  const children = [];
  const childClosures = new Map();
  const trackChild = (child) => {
    children.push(child);
    childClosures.set(
      child,
      new Promise((resolve) => child.once('close', resolve)),
    );
    return child;
  };
  const createdMysql = [];
  const createdPg = [];
  let mysqlUserCreated = false;
  let controlMysql, controlPg, primaryMysql, primaryPg, redis;
  const logs = {
    legacy: createStartupCapture(secrets),
    neo: createStartupCapture(secrets),
  };
  let failure;
  const command = async (name, args, options = {}) => {
    try {
      return await exec(name, args, {
        cwd: root,
        timeout: 300_000,
        maxBuffer: 2 * 1024 * 1024,
        ...options,
      });
    } catch (error) {
      // Child command lines and raw error output can include sensitive env/SQL.
      const safe = new Error(`Fixture command failed in ${manifest.phase}`);
      safe.code = safeCode(error);
      throw safe;
    }
  };
  const child = (label, entry, env, cwd) => {
    const process = spawn(global.process.execPath, [entry], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    process.on('error', (error) =>
      logs[label].write('error', `child error code ${safeCode(error)}\n`),
    );
    process.stdout.on('data', (chunk) => logs[label].write('stdout', chunk));
    process.stderr.on('data', (chunk) => logs[label].write('stderr', chunk));
    return trackChild(process);
  };
  try {
    redis = new Redis(config.redisUrl, {
      connectTimeout: 3000,
      maxRetriesPerRequest: 1,
    });
    if (Number(await redis.dbsize()) !== 0)
      throw new Error('Fixture Redis DB 14 must start empty');
    controlMysql = await mysql.createConnection({
      host: config.mysqlHost,
      port: config.mysqlPort,
      user: 'root',
      password: '',
      connectTimeout: 3000,
      multipleStatements: true,
      timezone: '+08:00',
    });
    controlPg = new Client({
      host: config.postgresHost,
      port: config.postgresPort,
      user: 'postgres',
      database: 'postgres',
      connectionTimeoutMillis: 3000,
    });
    await controlPg.connect();
    manifest.versions.mysql = (
      await controlMysql.query('SELECT VERSION() AS version')
    )[0][0].version;
    manifest.versions.postgres = (
      await controlPg.query('SELECT version() AS version')
    ).rows[0].version;
    // This change is confined to the job's dedicated MySQL service. No shared
    // integration/control database or arbitrary target is mutated.
    await controlMysql.query(
      "SET GLOBAL sql_mode='STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'",
    );
    await controlMysql.query(
      "SET SESSION sql_mode='STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'",
    );
    manifest.phase = 'fresh-database-bootstrap';
    for (const name of [
      config.names.legacyPrimary,
      config.names.legacyCompetitor,
    ]) {
      await controlMysql.query(
        `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
      createdMysql.push(name);
    }
    for (const name of [config.names.neoPrimary, config.names.neoCompetitor]) {
      await controlPg.query(`CREATE DATABASE "${name}"`);
      createdPg.push(name);
    }
    await controlMysql.query("CREATE USER ?@'%' IDENTIFIED BY ?", [
      credentials.mysqlUser,
      credentials.mysqlPassword,
    ]);
    mysqlUserCreated = true;
    for (const name of createdMysql) {
      await controlMysql.query(
        `GRANT ALL PRIVILEGES ON \`${name}\`.* TO ?@'%'`,
        [credentials.mysqlUser],
      );
    }
    for (const [source, original, target] of [
      ['init.sql', 'amazon_asin_monitor', config.names.legacyPrimary],
      [
        'competitor-init.sql',
        'amazon_competitor_monitor',
        config.names.legacyCompetitor,
      ],
    ]) {
      const ddl = await readFile(
        path.join(root, 'server/database', source),
        'utf8',
      );
      await controlMysql.query(normalizeLegacyDdl(ddl, original, target));
    }

    const container = String(
      process.env.ANALYTICS_TIMESCALE_CONTAINER_ID ?? '',
    );
    if (!/^[0-9a-f]{12,64}$/.test(container))
      throw new Error('Dedicated Timescale container identity is required');
    const inspected = JSON.parse(
      (await command('docker', ['inspect', container])).stdout,
    )[0];
    if (inspected?.Config?.Image !== 'timescale/timescaledb:2.29.2-pg16') {
      throw new Error('Unexpected dedicated Timescale image');
    }
    const psql = (database, extra) =>
      command('docker', [
        'exec',
        container,
        'psql',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '--username',
        'postgres',
        '--dbname',
        database,
        ...extra,
      ]);
    const baseline = '/tmp/analytics-190-baseline.sql';
    await command('docker', [
      'cp',
      path.join(root, 'packages/db/migrations/0000_baseline.sql'),
      `${container}:${baseline}`,
    ]);
    await psql('postgres', [
      '--set',
      `primary_database=${config.names.neoPrimary}`,
      '--set',
      `competitor_database=${config.names.neoCompetitor}`,
      '--file',
      baseline,
    ]);
    for (const { filename, domains } of migrations) {
      const target = `/tmp/analytics-190-${filename}`;
      await command('docker', [
        'cp',
        path.join(root, 'packages/db/migrations', filename),
        `${container}:${target}`,
      ]);
      for (const domain of domains) {
        await psql(
          domain === 'primary'
            ? config.names.neoPrimary
            : config.names.neoCompetitor,
          ['--file', target],
        );
      }
    }
    manifest.fixtureSchema.appliedMigrations = [
      '0000_baseline.sql',
      ...migrations,
    ];

    primaryMysql = await mysql.createConnection({
      host: config.mysqlHost,
      port: config.mysqlPort,
      user: credentials.mysqlUser,
      password: credentials.mysqlPassword,
      database: config.names.legacyPrimary,
      timezone: '+08:00',
      connectTimeout: 3000,
    });
    primaryPg = new Client({
      host: config.postgresHost,
      port: config.postgresPort,
      user: 'postgres',
      database: config.names.neoPrimary,
      connectionTimeoutMillis: 3000,
    });
    await primaryPg.connect();
    await primaryPg.query("SET TIME ZONE 'Asia/Shanghai'");
    manifest.versions.timescale = (
      await primaryPg.query(
        "SELECT extversion FROM pg_extension WHERE extname='timescaledb'",
      )
    ).rows[0].extversion;
    if (manifest.versions.timescale !== '2.29.2')
      throw new Error('Pinned Timescale version is required');
    manifest.phase = 'identical-history-seed';
    for (let sequence = 1; sequence <= 12; sequence++) {
      const row = fixtureRow(sequence);
      const values = [row[0], row[1], row[8], row[5], row[6]];
      await primaryMysql.query(
        'INSERT INTO variant_groups(id,name,country,site,brand) VALUES(?,?,?,?,?)',
        values,
      );
      await primaryPg.query(
        'INSERT INTO public.variant_groups(id,name,country,site,brand) VALUES($1,$2,$3,$4,$5)',
        values,
      );
    }
    for (let sequence = 1; sequence <= 24; sequence++) {
      const row = fixtureRow(sequence);
      const values = [row[2], row[3], row[4], row[8], row[5], row[6], row[0]];
      await primaryMysql.query(
        "INSERT INTO asins(id,asin,name,asin_type,country,site,brand,variant_group_id) VALUES(?,?,?,'MAIN_LINK',?,?,?,?)",
        values,
      );
      await primaryPg.query(
        "INSERT INTO public.asins(id,asin,name,asin_type,country,site,brand,variant_group_id) VALUES($1,$2,$3,'MAIN_LINK',$4,$5,$6,$7)",
        values,
      );
    }
    const digest = createHash('sha256');
    for (const batch of fixtureBatches(config.rows)) {
      for (const row of batch) digest.update(`${JSON.stringify(row)}\n`);
      await primaryMysql.query(
        `INSERT INTO monitor_history(${COLUMNS.join(',')}) VALUES ?`,
        [batch],
      );
      const placeholders = batch
        .map(
          (row, i) =>
            `(${row
              .map((_, column) => `$${i * COLUMNS.length + column + 1}`)
              .join(',')})`,
        )
        .join(',');
      await primaryPg.query(
        `INSERT INTO public.monitor_history(${COLUMNS.join(
          ',',
        )}) VALUES ${placeholders}`,
        batch.flat(),
      );
    }
    manifest.dataset = datasetManifest(config.rows, digest.digest('hex'));
    const mysqlCount = Number(
      (
        await primaryMysql.query(
          'SELECT COUNT(*) AS count FROM monitor_history',
        )
      )[0][0].count,
    );
    const pgCount = Number(
      (
        await primaryPg.query(
          'SELECT COUNT(*) AS count FROM public.monitor_history',
        )
      ).rows[0].count,
    );
    manifest.dataset.persistedRows = { legacy: mysqlCount, neo: pgCount };
    if (mysqlCount !== config.rows || pgCount !== config.rows)
      throw new Error('Persisted fixture row counts differ');
    manifest.dataset.windowRowCounts = {};
    for (const [window, range] of Object.entries(WINDOWS)) {
      const mysqlRows = (
        await primaryMysql.query(
          'SELECT COUNT(*) AS total, SUM(CASE WHEN country=? AND site_snapshot=? AND brand_snapshot=? AND variant_group_id=? THEN 1 ELSE 0 END) AS filtered FROM monitor_history WHERE check_time>=? AND check_time<=?',
          [
            'US',
            'store-0',
            'brand-0',
            'perf-group-0',
            range.startTime,
            range.endTime,
          ],
        )
      )[0][0];
      const pgRows = (
        await primaryPg.query(
          'SELECT COUNT(*) AS total, COUNT(*) FILTER(WHERE country=$1 AND site_snapshot=$2 AND brand_snapshot=$3 AND variant_group_id=$4) AS filtered FROM public.monitor_history WHERE check_time>=$5 AND check_time<=$6',
          [
            'US',
            'store-0',
            'brand-0',
            'perf-group-0',
            range.startTime,
            range.endTime,
          ],
        )
      ).rows[0];
      const counts = {
        legacy: {
          total: Number(mysqlRows.total),
          filtered: Number(mysqlRows.filtered),
        },
        neo: { total: Number(pgRows.total), filtered: Number(pgRows.filtered) },
      };
      manifest.dataset.windowRowCounts[window] = counts;
      if (
        counts.legacy.total !== counts.neo.total ||
        counts.legacy.filtered !== counts.neo.filtered ||
        counts.neo.total === 0 ||
        counts.neo.filtered === 0
      )
        throw new Error(
          'Window row counts or filtered fixture coverage differ',
        );
    }
    manifest.dataset.rawChunkStorage = (
      await primaryPg.query(
        "SELECT COUNT(*) AS chunks, COUNT(*) FILTER(WHERE is_compressed) AS compressed_chunks FROM timescaledb_information.chunks WHERE hypertable_schema='public' AND hypertable_name='monitor_history'",
      )
    ).rows[0];
    manifest.dataset.storageMeaning =
      'fresh future-dated input; actual chunk/compression counts recorded, no claim of historical compressed-chunk performance';
    await primaryMysql.query('ANALYZE TABLE monitor_history');
    await primaryPg.query('ANALYZE public.monitor_history');
    manifest.phase = 'real-cagg-refresh';
    for (const family of ['asin', 'dim', 'variant_group']) {
      for (const granularity of ['hour', 'day', 'month']) {
        await primaryPg.query(
          'CALL public.refresh_continuous_aggregate($1::regclass,$2::timestamp,$3::timestamp,force=>true)',
          [
            `public.monitor_history_cagg_${family}_${granularity}`,
            '2040-01-01 00:00:00',
            '2040-03-01 00:00:00',
          ],
        );
      }
    }
    manifest.dataset.caggRefresh =
      'all nine actual migration-defined CAGGs, full two-month range; HTTP meta.source must still independently prove aggregate execution';

    const userId = randomUUID(),
      sessionId = randomUUID();
    await primaryMysql.query(
      'INSERT INTO users(id,username,password,force_password_change) VALUES(?,?,?,0)',
      [userId, 'analytics-http-fixture', 'unused-fixture-password-hash'],
    );
    await primaryPg.query(
      'INSERT INTO public.users(id,username,password,force_password_change) VALUES($1,$2,$3,false)',
      [userId, 'analytics-http-fixture', 'unused-fixture-password-hash'],
    );
    await primaryMysql.query(
      "INSERT INTO user_roles(user_id,role_id) VALUES(?,'role-001')",
      [userId],
    );
    await primaryPg.query(
      "INSERT INTO public.user_roles(user_id,role_id) VALUES($1,'role-001')",
      [userId],
    );
    await primaryMysql.query(
      "INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,'2099-01-01 08:00:00')",
      [sessionId, userId],
    );
    await primaryPg.query(
      "INSERT INTO public.sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
      [sessionId, userId],
    );
    const token = jwt.sign({ userId, sessionId }, credentials.jwtSecret, {
      expiresIn: '1h',
    });
    secrets.add(token);
    manifest.phase = 'real-http-startup';
    const cwd = await mkdtemp(path.join(tmpdir(), 'analytics-http-190-'));
    const shared = isolatedChildEnvironment(config, credentials, cwd);
    await mkdir(shared.IMPORT_STORAGE_DIRECTORY, { recursive: true });
    child(
      'legacy',
      path.join(root, 'server/src/index.js'),
      { ...shared, PORT: '3301', ANALYTICS_AGG_ENABLED: '0' },
      cwd,
    );
    child(
      'neo',
      path.join(root, 'apps/api/dist/main.js'),
      { ...shared, PORT: '3310', ANALYTICS_AGG_ENABLED: '1' },
      cwd,
    );
    for (const base of [config.legacyBase, config.neoBase]) {
      let healthy = false;
      for (let attempt = 0; attempt < 120; attempt++) {
        if (
          children.some(
            (process) =>
              process.exitCode !== null || process.signalCode !== null,
          )
        )
          throw new Error('API exited before HTTP readiness');
        try {
          const response = await fetch(`${base}/health`, {
            signal: AbortSignal.timeout(2000),
          });
          if (response.status === 200) {
            healthy = true;
            break;
          }
        } catch {
          /* bounded readiness retry */
        }
        await delay(500);
      }
      if (!healthy)
        throw new Error('API did not become ready within the fixture deadline');
      const unauthenticated = await fetch(
        `${base}/api/v1/monitor-history/statistics/all-countries-summary`,
        { signal: AbortSignal.timeout(3000) },
      );
      if (unauthenticated.status !== 401)
        throw new Error('The real HTTP route did not enforce authentication');
    }
    manifest.phase = 'real-http-benchmark';
    await persist();
    const args = [
      path.join(root, 'scripts/benchmark-analytics.js'),
      '--old-base',
      config.legacyBase,
      '--new-base',
      config.neoBase,
      '--label-old',
      'Legacy MySQL raw HTTP',
      '--label-new',
      'Neo Timescale CAGG HTTP',
      '--expected-old-source',
      'raw',
      '--expected-new-source',
      'agg',
      '--cold-start-time',
      WINDOWS.cold.startTime,
      '--cold-end-time',
      WINDOWS.cold.endTime,
      '--hot-start-time',
      WINDOWS.hot.startTime,
      '--hot-end-time',
      WINDOWS.hot.endTime,
      '--country',
      'US',
      '--site',
      'store-0',
      '--brand',
      'brand-0',
      '--variant-group-id',
      'perf-group-0',
      '--environment-label',
      'isolated-github-services-complete-api',
      '--dataset-rows',
      String(config.rows),
      '--dataset-profile',
      PROFILE,
      '--warmup',
      String(config.warmup),
      '--runs',
      String(config.iterations),
      '--min-speedup',
      '3',
      '--timeout-ms',
      String(manifest.gate.requestTimeoutMs),
      '--output-dir',
      output,
    ];
    // Token is an env value in an isolated child, never a shell argument.
    const benchmark = spawn(process.execPath, args, {
      cwd: root,
      env: { ...shared, BENCH_TOKEN: token },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    trackChild(benchmark);
    let deadline;
    const code = await new Promise((resolve, reject) => {
      deadline = setTimeout(() => {
        benchmark.kill('SIGTERM');
        const error = new Error('Benchmark exceeded its isolated deadline');
        error.code = 'BENCHMARK_DEADLINE';
        reject(error);
      }, manifest.gate.benchmarkDeadlineMs);
      benchmark.once('error', reject);
      benchmark.once('close', (code) => resolve(code));
    }).finally(() => clearTimeout(deadline));
    manifest.status = code === 0 ? 'passed' : 'failed';
    manifest.phase = 'completed';
    if (code !== 0)
      throw new Error(
        'HTTP correctness or required 3x P95 gate failed; inspect every case in the report',
      );
  } catch (error) {
    failure = error;
    manifest.status = 'failed';
    manifest.failure = { phase: manifest.phase, code: safeCode(error) };
    logger.error('Isolated analytics performance failed', manifest.failure);
  } finally {
    for (const process of children) {
      if (process.exitCode === null && process.signalCode === null)
        process.kill('SIGTERM');
    }
    for (const process of children) {
      let closed = await Promise.race([
        childClosures.get(process).then(() => true),
        delay(3000).then(() => false),
      ]);
      if (!closed) {
        process.kill('SIGKILL');
        closed = await Promise.race([
          childClosures.get(process).then(() => true),
          delay(3000).then(() => false),
        ]);
      }
      if (!closed) {
        failure ??= Object.assign(
          new Error('Fixture child shutdown uncertain'),
          {
            code: 'CHILD_CLOSE_TIMEOUT',
          },
        );
        manifest.status = 'failed';
        manifest.failure = {
          phase: 'child-cleanup',
          code: 'CHILD_CLOSE_TIMEOUT',
        };
        logger.warn('Fixture child close could not be confirmed', {
          code: 'CHILD_CLOSE_TIMEOUT',
        });
      }
    }
    await primaryMysql?.end().catch(() => undefined);
    await primaryPg?.end().catch(() => undefined);
    for (const name of createdMysql) {
      await controlMysql?.query(`DROP DATABASE \`${name}\``).catch((error) => {
        logger.warn('Owned MySQL fixture cleanup failed', {
          code: safeCode(error),
        });
      });
    }
    for (const name of createdPg) {
      await controlPg
        ?.query(`DROP DATABASE "${name}" WITH (FORCE)`)
        .catch((error) => {
          logger.warn('Owned PG fixture cleanup failed', {
            code: safeCode(error),
          });
        });
    }
    if (mysqlUserCreated)
      await controlMysql
        ?.query("DROP USER ?@'%'", [credentials.mysqlUser])
        .catch(() => undefined);
    await controlMysql?.end().catch(() => undefined);
    await controlPg?.end().catch(() => undefined);
    redis?.disconnect();
    await persist();
    for (const [label, capture] of Object.entries(logs))
      await writeFile(
        path.join(output, `${label}-startup.log`),
        capture.finish(),
      );
  }
  if (failure) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    logger.error('Isolated analytics fixture preflight failed', {
      code: safeCode(error),
    });
    process.exitCode = 1;
  });
}

module.exports = { isolatedChildEnvironment, normalizeLegacyDdl, safeCode };
