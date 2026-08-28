import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  competitorDrizzleTables,
  competitorTableNames,
  drizzleTableNames,
  primaryDrizzleTables,
  primaryTableNames,
} from './schema-fixtures';

const workspaceRoot = resolve(__dirname, '../../..');
const read = (relativePath: string) =>
  readFileSync(resolve(workspaceRoot, relativePath), 'utf8');
const baselinePath = 'packages/db/migrations/0000_baseline.sql';

describe('PostgreSQL 双库 Schema 基线', () => {
  it('Drizzle 事实源覆盖 Legacy 最终态 21 + 4 张表', () => {
    expect(drizzleTableNames(primaryDrizzleTables)).toEqual([
      ...primaryTableNames,
    ]);
    expect(drizzleTableNames(competitorDrizzleTables)).toEqual([
      ...competitorTableNames,
    ]);
  });

  it('单一 baseline 通过 psql 连接双库且表集合完整', () => {
    const baseline = read(baselinePath);
    const createdTables = [
      ...baseline.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/g),
    ]
      .map((match) => match[1])
      .sort();

    expect(createdTables).toEqual(
      [...primaryTableNames, ...competitorTableNames].sort(),
    );
    expect(baseline).toContain('\\connect :primary_database');
    expect(baseline).toContain('\\connect :competitor_database');
  });

  it('逐项消除 MySQL 专用语法并落地既定 PG 类型映射', () => {
    const baseline = read(baselinePath);

    for (const forbidden of [
      /`/,
      /\bTINYINT\b/i,
      /\bENUM\s*\(/i,
      /\bAUTO_INCREMENT\b/i,
      /\bON DUPLICATE KEY\b/i,
      /\bENGINE\s*=/i,
      /^\s*USE\s+/im,
    ]) {
      expect(baseline).not.toMatch(forbidden);
    }

    expect(baseline.match(/\bCHECK\s*\(/g)).toHaveLength(5);
    expect(baseline.match(/GENERATED ALWAYS AS IDENTITY/g)).toHaveLength(12);
    expect(baseline.match(/GENERATED ALWAYS AS \(date_trunc\(/g)).toHaveLength(
      3,
    );
    expect(baseline).toContain('timestamp without time zone');
    expect(baseline).not.toMatch(/timestamp\s+with\s+time\s+zone/i);
    expect(baseline).toContain(
      `ALTER DATABASE :"primary_database" SET timezone TO 'Asia/Shanghai'`,
    );
    expect(baseline).toContain(
      `ALTER DATABASE :"competitor_database" SET timezone TO 'Asia/Shanghai'`,
    );
    expect(baseline.match(/SET TIME ZONE 'Asia\/Shanghai'/g)).toHaveLength(2);
    expect(baseline.match(/\bjsonb\b/g)).toHaveLength(3);
    expect(baseline).toContain('set_updated_timestamp_column');
    expect(baseline).toContain('TG_ARGV[0]');
    expect(baseline).toContain(
      'ON CONFLICT (role_id, permission_id) DO NOTHING',
    );
    expect(baseline).toContain('EXCLUDED.description');
    expect(baseline).toContain(
      'idx_monitor_history_month_country_asin ON monitor_history (month_ts, country, asin_id, asin_code, is_broken)',
    );
  });

  it('Legacy 33 个迁移文件保持历史冻结', () => {
    const migrationFiles = readdirSync(
      resolve(workspaceRoot, 'server/database/migrations'),
    ).filter((file) => file.endsWith('.sql'));
    const migrationGuide = read('server/database/MIGRATION.md');

    expect(migrationFiles).toHaveLength(33);
    expect(migrationGuide).toContain('历史冻结');
    expect(migrationGuide).toContain(baselinePath);
  });
});
