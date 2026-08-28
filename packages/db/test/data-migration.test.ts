import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dataMigrationReportSchema } from '@asin-monitor/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  canonicalJson,
  DeterministicSampler,
  sha256,
  transformSourceRow,
} from '../src/migration/canonical';
import { runDataMigrationCli } from '../src/migration/cli';
import { parseDataMigrationConfig } from '../src/migration/config';
import { runDataMigration } from '../src/migration/engine';
import { DataMigrationError } from '../src/migration/errors';
import {
  createMigrationLogger,
  sanitizeMigrationErrorMessage,
} from '../src/migration/logger';
import { databaseMigrationSpecs } from '../src/migration/registry';
import { writeDataMigrationReport } from '../src/migration/report';

const expectedPrimaryTables = [
  'variant_groups',
  'users',
  'roles',
  'permissions',
  'feishu_config',
  'sp_api_config',
  'backup_config',
  'asins',
  'monitor_history',
  'monitor_history_agg',
  'monitor_history_agg_dim',
  'monitor_history_agg_variant_group',
  'analytics_refresh_watermark',
  'monitor_history_status_interval',
  'password_history',
  'login_attempts',
  'user_status_history',
  'sessions',
  'user_roles',
  'role_permissions',
  'audit_logs',
];

describe('P1-T3 migration registry', () => {
  it('按 FK 安全顺序覆盖 21 + 4 张 Drizzle 表', () => {
    expect(
      databaseMigrationSpecs.map(({ logicalName }) => logicalName),
    ).toEqual(['primary', 'competitor']);
    expect(databaseMigrationSpecs[0].tables.map(({ name }) => name)).toEqual(
      expectedPrimaryTables,
    );
    expect(databaseMigrationSpecs[1].tables.map(({ name }) => name)).toEqual([
      'competitor_variant_groups',
      'competitor_asins',
      'competitor_monitor_history',
      'competitor_feishu_config',
    ]);
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
      check_result: { nested: { b: 2, a: 1 } },
    });
    expect(canonicalJson(transformed.check_result)).toBe(
      '{"nested":{"a":1,"b":2}}',
    );
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
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
