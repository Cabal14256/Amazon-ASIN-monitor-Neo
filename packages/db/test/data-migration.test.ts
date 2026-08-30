import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  dataMigrationEvidenceManifest,
  dataMigrationReportSchema,
  type DataMigrationReport,
} from '@asin-monitor/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  DeterministicSampler,
  migrationJsonText,
  parseMigrationJsonDocument,
  sha256,
  transformSourceRow,
} from '../src/migration/canonical';
import { runDataMigrationCli } from '../src/migration/cli';
import { parseDataMigrationConfig } from '../src/migration/config';
import {
  isAllowedLegacyBackupTableName,
  runDataMigration,
  targetCommitRiskError,
} from '../src/migration/engine';
import { DataMigrationError } from '../src/migration/errors';
import {
  createMigrationLogger,
  sanitizeMigrationErrorMessage,
} from '../src/migration/logger';
import {
  databaseMigrationSpecs,
  normalizePostgresCheckExpression,
  normalizePostgresExpression,
  normalizePostgresRoutineDefinition,
} from '../src/migration/registry';
import {
  prepareDataMigrationReportDestination,
  writeDataMigrationReport,
} from '../src/migration/report';

const expectedPrimaryTables = dataMigrationEvidenceManifest.primary.tables;

const digest = 'a'.repeat(64);

function passedMigrationReport(): DataMigrationReport {
  return dataMigrationReportSchema.parse({
    schemaVersion: 1,
    runId: '00000000-0000-4000-8000-000000000001',
    strategy: 'full-snapshot-cutover-sync',
    startedAt: '2026-08-28T00:00:00.000Z',
    finishedAt: '2026-08-28T00:00:01.000Z',
    batchSize: 500,
    sampleSize: 20,
    targetResetAuthorized: true,
    databases: (['primary', 'competitor'] as const).map((logicalName) => ({
      logicalName,
      tables: dataMigrationEvidenceManifest[logicalName].tables.map(
        (table) => ({
          table,
          sourceRows: '1',
          targetRows: '1',
          sampledRows: 1,
          sourceSampleDigest: digest,
          targetSampleDigest: digest,
          durationMs: 1,
          status: 'passed',
        }),
      ),
      businessQueries: dataMigrationEvidenceManifest[
        logicalName
      ].businessQueries.map((name) => ({
        name,
        sourceRows: '1',
        targetRows: '1',
        sourceDigest: digest,
        targetDigest: digest,
        status: 'passed',
      })),
      durationMs: 1,
      status: 'passed',
    })),
    status: 'passed',
  });
}

describe('P1-T3 migration registry', () => {
  it('按 FK 安全顺序覆盖 21 + 4 张 Drizzle 表', () => {
    expect(
      databaseMigrationSpecs.map(({ logicalName }) => logicalName),
    ).toEqual(['primary', 'competitor']);
    expect(databaseMigrationSpecs[0].tables.map(({ name }) => name)).toEqual(
      expectedPrimaryTables,
    );
    expect(databaseMigrationSpecs[1].tables.map(({ name }) => name)).toEqual([
      ...dataMigrationEvidenceManifest.competitor.tables,
    ]);
    for (const database of databaseMigrationSpecs) {
      expect(database.businessQueries.map(({ name }) => name)).toEqual([
        ...dataMigrationEvidenceManifest[database.logicalName].businessQueries,
      ]);
    }
  });

  it('从 Drizzle 推导 PK、BOOLEAN、JSONB、生成列与 identity', () => {
    const monitorHistory = databaseMigrationSpecs[0].tables.find(
      ({ name }) => name === 'monitor_history',
    );
    expect(monitorHistory).toBeDefined();
    expect(monitorHistory?.primaryKeyColumns).toEqual(['id']);
    expect([...monitorHistory!.booleanColumns]).toEqual([
      'is_broken',
      'notification_sent',
    ]);
    expect([...monitorHistory!.jsonColumns]).toEqual(['check_result']);
    expect([...monitorHistory!.generatedColumns]).toEqual([
      'hour_ts',
      'day_ts',
      'month_ts',
    ]);
    expect(monitorHistory?.insertColumns).not.toContain('month_ts');
    expect(monitorHistory?.identityColumns).toEqual(['id']);
    expect(monitorHistory?.targetColumnSignatures).toContain(
      'id|bigint|not-null|a||',
    );
    expect(monitorHistory?.targetColumnSignatures).toContain(
      "hour_ts|timestamp without time zone|nullable||s|date_trunc('hour',check_time)",
    );
    expect(monitorHistory?.targetConstraintSignatures).toContain(
      'p|monitor_history_pkey|id',
    );
    expect(monitorHistory?.targetIndexSignatures).toContain(
      'monitor_history_pkey|unique|btree|id||valid|ready',
    );
    expect(monitorHistory?.targetIndexSignatures).toContain(
      'idx_monitor_history_status_interval_refresh|non-unique|btree|check_type,check_time,id||valid|ready',
    );

    const asins = databaseMigrationSpecs[0].tables.find(
      ({ name }) => name === 'asins',
    )!;
    expect(asins.targetConstraintSignatures).toContain(
      'u|uk_asins_asin_country|asin,country',
    );
    expect(asins.targetConstraintSignatures).toContain(
      'f|fk_asins_variant_group|variant_group_id|public|variant_groups|id|no action|cascade',
    );
    expect(asins.targetColumnSignatures).toContain(
      'manual_broken|boolean|nullable|||false',
    );
    expect(asins.targetTriggerSignatures).toEqual([
      'trg_asins_update_time|19|O|public|set_updated_timestamp_column|7570646174655f74696d6500|||',
    ]);

    const aggregate = databaseMigrationSpecs[0].tables.find(
      ({ name }) => name === 'monitor_history_agg',
    )!;
    expect(aggregate.targetConstraintSignatures).toContain(
      "c|ck_monitor_history_agg_granularity|granularity|in|'hour','day','month'",
    );
    expect(aggregate.sourceKeysetColumns[0]).toEqual({
      column: 'granularity',
      enumOrder: ['hour', 'day', 'month'],
    });
    expect(asins.targetIndexSignatures).toContain(
      'uq_asins_asin_country_ci|unique|btree|lower(asin),lower(country)||valid|ready',
    );
    for (const database of databaseMigrationSpecs) {
      expect(database.targetFunctionSignatures).toHaveLength(1);
      expect(database.targetFunctionSignatures[0]).toContain(
        'set_updated_timestamp_column|f|trigger||plpgsql|v|not-strict|invoker|not-leakproof|not-set|unsafe||',
      );
    }
  });

  it('将 PG catalog 重写的 CHECK 和表达式索引归一到 Drizzle 定义', () => {
    expect(
      normalizePostgresCheckExpression(
        "CHECK (((granularity)::text = ANY ((ARRAY['hour'::character varying, 'day'::character varying, 'month'::character varying])::text[])))",
      ),
    ).toBe("granularity|in|'hour','day','month'");
    expect(normalizePostgresExpression('lower((asin)::text)')).toBe(
      'lower(asin)',
    );
    expect(
      normalizePostgresRoutineDefinition(
        'BEGIN NEW.update_time := LOCALTIMESTAMP; RETURN NEW; END;',
      ),
    ).toBe('begin new.update_time := localtimestamp; return new; end;');
    expect(
      normalizePostgresRoutineDefinition(
        'BEGIN OLD.update_time := LOCALTIMESTAMP; RETURN NEW; END;',
      ),
    ).not.toBe('begin new.update_time := localtimestamp; return new; end;');
  });

  it('仅忽略两个现有维护脚本产生的持久化备份表', () => {
    expect(
      [
        'mh_bak_20260828_123456',
        'mha_bak_20260828_123456',
        'mhad_bak_20260828_123456',
        'mhavg_bak_20260828_123456',
        'monitor_history_agg_bak_20260828_123456',
        'monitor_history_agg_dim_bak_20260828_123456',
        'monitor_history_agg_variant_group_bak_20260828_123456',
        'monitor_history_status_interval_bak_20260828_123456',
      ].every(isAllowedLegacyBackupTableName),
    ).toBe(true);
    expect(isAllowedLegacyBackupTableName('users_bak_20260828_123456')).toBe(
      false,
    );
    expect(isAllowedLegacyBackupTableName('mh_bak_latest')).toBe(false);
  });

  it('历史对拍将 NULL 和空 check_type 归为同一确定性分组', () => {
    for (const database of databaseMigrationSpecs) {
      const query = database.businessQueries.find(({ name }) =>
        name.includes('history'),
      );
      expect(query?.sourceSql).toContain(
        "GROUP BY country, COALESCE(check_type, '')",
      );
      expect(query?.targetSql).toContain(
        "GROUP BY country, COALESCE(check_type, '')",
      );
    }
  });

  it('聚合 keyset 与业务对拍共享 hour/day/month 的显式顺序', () => {
    const aggregateTables = databaseMigrationSpecs[0].tables.filter(
      ({ name }) => name.startsWith('monitor_history_agg'),
    );
    expect(aggregateTables).toHaveLength(3);
    for (const table of aggregateTables) {
      expect(table.sourceKeysetColumns[0].enumOrder).toEqual([
        'hour',
        'day',
        'month',
      ]);
    }
    const query = databaseMigrationSpecs[0].businessQueries.find(
      ({ name }) => name === 'analytics_rows_by_granularity',
    );
    expect(query?.sourceSql).toContain(
      "FIELD(granularity, 'hour', 'day', 'month')",
    );
    expect(query?.targetSql).toContain(
      "CASE granularity WHEN 'hour' THEN 1 WHEN 'day' THEN 2 WHEN 'month' THEN 3 END",
    );
  });
});

describe('migration canonical conversion', () => {
  const monitorHistory = databaseMigrationSpecs[0].tables.find(
    ({ name }) => name === 'monitor_history',
  )!;

  it('转换 BOOLEAN/JSON 且保留 D8 时间文本和生成列样本', () => {
    const transformed = transformSourceRow(monitorHistory, {
      id: '9007199254740993',
      variant_group_id: null,
      variant_group_name: null,
      asin_id: null,
      asin_code: 'B000TEST',
      asin_name: 'Sample',
      site_snapshot: '12',
      brand_snapshot: 'Brand',
      check_type: 'GROUP',
      country: 'US',
      is_broken: 1,
      check_time: '2026-08-28 15:42:37',
      hour_ts: '2026-08-28 15:00:00',
      day_ts: '2026-08-28 00:00:00',
      month_ts: '2026-08-01 00:00:00',
      check_result: '{"nested":{"b":2,"a":1}}',
      notification_sent: 0,
      create_time: '2026-08-28 15:42:38',
    });

    expect(transformed).toMatchObject({
      id: '9007199254740993',
      is_broken: true,
      notification_sent: false,
      check_time: '2026-08-28 15:42:37',
      month_ts: '2026-08-01 00:00:00',
    });
    expect(migrationJsonText(transformed.check_result)).toBe(
      '{"nested":{"a":1e0,"b":2e0}}',
    );
  });

  it('JSON 数值全程无损并按数学值生成稳定摘要', () => {
    const unsafe = parseMigrationJsonDocument(
      '{"unsafe":9007199254740993,"same":1e2}',
    );
    const equivalent = parseMigrationJsonDocument(
      '{"same":100.0,"unsafe":9007199254740993}',
    );
    const rounded = parseMigrationJsonDocument(
      '{"same":100,"unsafe":9007199254740992}',
    );

    expect(migrationJsonText(unsafe)).toContain('9007199254740993');
    expect(sha256(unsafe)).toBe(sha256(equivalent));
    expect(sha256(unsafe)).not.toBe(sha256(rounded));
  });

  it('空 JSON 归一为 NULL，非空非法 JSON 以行哈希失败', () => {
    const base = Object.fromEntries(
      monitorHistory.columns.map((column) => [column, null]),
    );
    base.id = '42';
    base.country = 'US';
    base.check_time = '2026-08-28 00:00:00';
    base.is_broken = 0;
    base.notification_sent = 0;

    expect(
      transformSourceRow(monitorHistory, {
        ...base,
        check_result: '   ',
      }).check_result,
    ).toBeNull();

    let failure: unknown;
    try {
      transformSourceRow(monitorHistory, {
        ...base,
        check_result: '{invalid',
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DataMigrationError);
    expect(failure).toMatchObject({
      code: 'SOURCE_JSON_INVALID',
      scope: 'monitor_history.check_result',
    });
    expect((failure as Error).message).not.toContain('42');
  });

  it('确定性抽样与输入顺序无关且只保留最小哈希排名', () => {
    const forward = new DeterministicSampler('asins', 2);
    const reverse = new DeterministicSampler('asins', 2);
    const rows = [1, 2, 3, 4].map((id) => ({ id: String(id), name: `n${id}` }));
    for (const row of rows) forward.add([row.id], row);
    for (const row of [...rows].reverse()) reverse.add([row.id], row);

    expect(forward.digest(['id', 'name'])).toBe(reverse.digest(['id', 'name']));
    expect(forward.samples()).toHaveLength(2);
    expect(forward.digest(['id'])).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256({ b: 2, a: 1 })).toBe(sha256({ a: 1, b: 2 }));
  });
});

describe('migration config and logging safety', () => {
  const validEnvironment = {
    MIGRATION_MYSQL_HOST: '127.0.0.1',
    MIGRATION_MYSQL_USER: 'root',
    MIGRATION_MYSQL_PASSWORD: '',
    MIGRATION_MYSQL_PRIMARY_DATABASE: 'source_primary',
    MIGRATION_MYSQL_COMPETITOR_DATABASE: 'source_competitor',
    DATABASE_URL: 'postgresql://user:secret@127.0.0.1:5432/target_primary',
    COMPETITOR_DATABASE_URL:
      'postgresql://user:secret@127.0.0.1:5432/target_competitor',
    MIGRATION_ALLOW_TARGET_RESET: 'true',
  };

  it('解析显式双库和安全上限但不暴露凭据', () => {
    const config = parseDataMigrationConfig(validEnvironment, 'D:/workspace');
    expect(config).toMatchObject({
      batchSize: 500,
      sampleSize: 20,
      allowTargetReset: true,
      mysql: {
        primaryDatabase: 'source_primary',
        competitorDatabase: 'source_competitor',
      },
    });
    expect(config.reportPath.replaceAll('\\', '/')).toContain(
      '/artifacts/data-migration/report.json',
    );
  });

  it('拒绝同名双库和越界批次', () => {
    expect(() =>
      parseDataMigrationConfig({
        ...validEnvironment,
        MIGRATION_MYSQL_COMPETITOR_DATABASE: 'source_primary',
      }),
    ).toThrow(/must be different/);
    expect(() =>
      parseDataMigrationConfig({
        ...validEnvironment,
        MIGRATION_BATCH_SIZE: '5000',
      }),
    ).toThrow(/between 1 and 1000/);
  });

  it('按主机、端口和库名识别 PG 目标，而不是只比较库名', () => {
    expect(() =>
      parseDataMigrationConfig({
        ...validEnvironment,
        DATABASE_URL: 'postgresql://one:secret@pg-a:5432/shared',
        COMPETITOR_DATABASE_URL: 'postgresql://two:secret@pg-b:5432/shared',
      }),
    ).not.toThrow();
    expect(() =>
      parseDataMigrationConfig({
        ...validEnvironment,
        DATABASE_URL: 'postgresql://one:secret@PG-A/shared',
        COMPETITOR_DATABASE_URL: 'postgresql://two:other@pg-a:5432/shared',
      }),
    ).toThrow(/must be different/);
  });

  it('脱敏连接串和敏感键值', () => {
    const message = sanitizeMigrationErrorMessage(
      'connect postgresql://user:secret@db:5432/name password=secret token=abc',
    );
    expect(message).not.toContain('user:secret');
    expect(message).not.toContain('password=secret');
    expect(message).not.toContain('token=abc');
  });

  it('结构化日志递归屏蔽连接串与敏感上下文', () => {
    const writer = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      createMigrationLogger('INFO').info('migration.test', {
        databaseUrl:
          'postgresql://integration-user:integration-password@db:5432/primary',
        nested: { password: 'integration-password', note: 'token=fixture' },
      });
      const line = String(writer.mock.calls[0][0]);
      expect(line).not.toContain('integration-user');
      expect(line).not.toContain('integration-password');
      expect(line).not.toContain('token=fixture');
      expect(line).toContain('[REDACTED]');
    } finally {
      writer.mockRestore();
    }
  });

  it('未显式授权重置时在建立任何连接前拒绝执行', async () => {
    const config = parseDataMigrationConfig({
      ...validEnvironment,
      MIGRATION_ALLOW_TARGET_RESET: 'false',
    });
    await expect(runDataMigration(config)).rejects.toMatchObject({
      code: 'TARGET_RESET_NOT_AUTHORIZED',
      scope: 'config.migration_allow_target_reset',
    });
  });

  it('把无响应的 COMMIT 归类为结果不确定而非普通回滚失败', () => {
    const cause = new DataMigrationError(
      'UNEXPECTED_MIGRATION_ERROR',
      'migration',
      'fixture',
    );
    expect(
      targetCommitRiskError(
        [
          { logicalName: 'primary', attempted: true, committed: false },
          { logicalName: 'competitor', attempted: false, committed: false },
        ],
        cause,
      ),
    ).toMatchObject({
      code: 'TARGET_COMMIT_INDETERMINATE',
      scope: 'target.commit',
    });
    expect(
      targetCommitRiskError(
        [
          { logicalName: 'primary', attempted: false, committed: false },
          { logicalName: 'competitor', attempted: false, committed: false },
        ],
        cause,
      ),
    ).toBeUndefined();
  });

  it('原子写入经过契约校验的脱敏失败报告', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'asin-migration-report-'));
    const reportPath = join(directory, 'nested', 'report.json');
    const report = dataMigrationReportSchema.parse({
      schemaVersion: 1,
      runId: '00000000-0000-4000-8000-000000000001',
      strategy: 'full-snapshot-cutover-sync',
      startedAt: '2026-08-28T00:00:00.000Z',
      finishedAt: '2026-08-28T00:00:01.000Z',
      batchSize: 500,
      sampleSize: 20,
      targetResetAuthorized: false,
      databases: [],
      status: 'failed',
      failure: {
        code: 'TARGET_RESET_NOT_AUTHORIZED',
        scope: 'config.migration_allow_target_reset',
      },
    });

    try {
      await prepareDataMigrationReportDestination(reportPath);
      expect(await readdir(join(directory, 'nested'))).toEqual([]);
      await writeDataMigrationReport(report, reportPath);
      await writeDataMigrationReport(report, reportPath);
      expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual(report);
      expect(await readdir(join(directory, 'nested'))).toEqual(['report.json']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('CLI 在未授权重置时非零退出并落下契约化失败报告', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'asin-migration-cli-'));
    const reportPath = join(directory, 'report.json');
    vi.stubEnv('MIGRATION_MYSQL_HOST', '127.0.0.1');
    vi.stubEnv('MIGRATION_MYSQL_USER', 'integration-reader');
    vi.stubEnv('MIGRATION_MYSQL_PASSWORD', 'non-secret-fixture');
    vi.stubEnv('MIGRATION_MYSQL_PRIMARY_DATABASE', 'source_primary');
    vi.stubEnv('MIGRATION_MYSQL_COMPETITOR_DATABASE', 'source_competitor');
    vi.stubEnv(
      'DATABASE_URL',
      'postgresql://integration:fixture@127.0.0.1:5432/target_primary',
    );
    vi.stubEnv(
      'COMPETITOR_DATABASE_URL',
      'postgresql://integration:fixture@127.0.0.1:5432/target_competitor',
    );
    vi.stubEnv('MIGRATION_ALLOW_TARGET_RESET', 'false');
    vi.stubEnv('MIGRATION_REPORT_PATH', reportPath);
    const silentLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    try {
      expect(await runDataMigrationCli(directory, silentLogger)).toBe(1);
      const report = dataMigrationReportSchema.parse(
        JSON.parse(await readFile(reportPath, 'utf8')),
      );
      expect(report).toMatchObject({
        targetResetAuthorized: false,
        databases: [],
        status: 'failed',
        failure: {
          code: 'TARGET_RESET_NOT_AUTHORIZED',
          scope: 'config.migration_allow_target_reset',
        },
      });
      expect(JSON.stringify(silentLogger.info.mock.calls)).not.toContain(
        reportPath,
      );
      expect(JSON.stringify(silentLogger.error.mock.calls)).not.toContain(
        reportPath,
      );
      expect(silentLogger.info).toHaveBeenCalledWith(
        'data_migration.report_written',
        expect.objectContaining({
          reportDestination: 'data-migration-report',
          status: 'failed',
        }),
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('CLI 在加载 .env.migration 后才按 LOG_LEVEL 创建 logger', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'asin-migration-env-'));
    const reportPath = join(directory, 'report.json');
    await writeFile(join(directory, '.env.migration'), 'LOG_LEVEL=ERROR\n');
    vi.stubEnv('LOG_LEVEL', undefined);
    vi.stubEnv('MIGRATION_MYSQL_HOST', '127.0.0.1');
    vi.stubEnv('MIGRATION_MYSQL_USER', 'integration-reader');
    vi.stubEnv('MIGRATION_MYSQL_PASSWORD', 'non-secret-fixture');
    vi.stubEnv('MIGRATION_MYSQL_PRIMARY_DATABASE', 'source_primary');
    vi.stubEnv('MIGRATION_MYSQL_COMPETITOR_DATABASE', 'source_competitor');
    vi.stubEnv(
      'DATABASE_URL',
      'postgresql://integration:fixture@127.0.0.1:5432/target_primary',
    );
    vi.stubEnv(
      'COMPETITOR_DATABASE_URL',
      'postgresql://integration:fixture@127.0.0.1:5432/target_competitor',
    );
    vi.stubEnv('MIGRATION_ALLOW_TARGET_RESET', 'true');
    vi.stubEnv('MIGRATION_REPORT_PATH', reportPath);
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    try {
      expect(
        await runDataMigrationCli(directory, undefined, {
          prepareReportDestination: vi.fn().mockResolvedValue(undefined),
          runMigration: vi.fn(async (_config, logger) => {
            logger.info('fixture.info');
            logger.error('fixture.error');
            return passedMigrationReport();
          }),
          writeReport: vi.fn().mockResolvedValue(undefined),
        }),
      ).toBe(0);
      expect(stdout.mock.calls.flat().join('')).not.toContain('fixture.info');
      expect(stderr.mock.calls.flat().join('')).toContain('fixture.error');
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('CLI 明确区分双库已提交后的成功报告写入失败', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'asin-migration-commit-'));
    const reportPath = join(directory, 'report.json');
    vi.stubEnv('MIGRATION_MYSQL_HOST', '127.0.0.1');
    vi.stubEnv('MIGRATION_MYSQL_USER', 'integration-reader');
    vi.stubEnv('MIGRATION_MYSQL_PASSWORD', 'non-secret-fixture');
    vi.stubEnv('MIGRATION_MYSQL_PRIMARY_DATABASE', 'source_primary');
    vi.stubEnv('MIGRATION_MYSQL_COMPETITOR_DATABASE', 'source_competitor');
    vi.stubEnv(
      'DATABASE_URL',
      'postgresql://integration:fixture@127.0.0.1:5432/target_primary',
    );
    vi.stubEnv(
      'COMPETITOR_DATABASE_URL',
      'postgresql://integration:fixture@127.0.0.1:5432/target_competitor',
    );
    vi.stubEnv('MIGRATION_ALLOW_TARGET_RESET', 'true');
    vi.stubEnv('MIGRATION_REPORT_PATH', reportPath);
    const silentLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const writeReport = vi
      .fn()
      .mockRejectedValueOnce(new Error('fixture write failure'))
      .mockRejectedValueOnce(new Error(`cannot write ${reportPath}`));

    try {
      expect(
        await runDataMigrationCli(directory, silentLogger, {
          prepareReportDestination: vi.fn().mockResolvedValue(undefined),
          runMigration: vi.fn().mockResolvedValue(passedMigrationReport()),
          writeReport,
        }),
      ).toBe(1);
      expect(writeReport).toHaveBeenCalledTimes(2);
      expect(writeReport.mock.calls[1][0]).toMatchObject({
        targetResetAuthorized: true,
        status: 'failed',
        failure: {
          code: 'POST_COMMIT_REPORT_WRITE_FAILED',
          scope: 'report.write',
        },
      });
      expect(silentLogger.error).toHaveBeenCalledWith(
        'data_migration.report_write_failed',
        expect.objectContaining({ code: 'REPORT_WRITE_FAILED' }),
      );
      expect(silentLogger.error).toHaveBeenCalledWith(
        'data_migration.cli_failed',
        expect.objectContaining({
          code: 'POST_COMMIT_REPORT_WRITE_FAILED',
          scope: 'report.write',
        }),
      );
      expect(JSON.stringify(silentLogger.error.mock.calls)).not.toContain(
        reportPath,
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
