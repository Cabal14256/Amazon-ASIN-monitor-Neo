import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scheduledMonitorTables } from '../src/schema/scheduled-monitor-tables';

const domains = [
  { domain: 'primary' as const },
  { domain: 'competitor' as const },
];
const read = (name: string) =>
  readFileSync(resolve(__dirname, '../migrations', name), 'utf8');

describe.each(domains)('private $domain scheduled schema', ({ domain }) => {
  const prefix = `${domain}_scheduled_monitor`;
  const tables = scheduledMonitorTables(domain);
  const migration = read(`0016_scheduled_monitor_${domain}.sql`);
  const rollback = read(`0016_scheduled_monitor_${domain}.rollback.sql`);
  it('keeps every typed column and named constraint aligned with its isolated SQL upgrade', () => {
    expect(
      [
        ...migration.matchAll(
          /CREATE TABLE(?: IF NOT EXISTS)? public\.([a-z_]+)/g,
        ),
      ].map((match) => match[1]),
    ).toEqual([
      `${prefix}_runs`,
      `${prefix}_notifications`,
      `${prefix}_group_receipts`,
    ]);
    for (const table of Object.values(tables)) {
      const name = getTableName(table);
      const body = migration
        .split(
          new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? public\\.${name} \\(`),
        )[1]
        ?.split('\n);')[0];
      expect(body).toBeDefined();
      const actual = [
        ...body!.matchAll(
          /^  ([a-z_]+) (uuid|varchar\(\d+\)|jsonb|integer|timestamptz)([^\n]*)/gm,
        ),
      ].map((match) => ({
        name: match[1],
        type: match[2],
        notNull: /NOT NULL|PRIMARY KEY/.test(match[3]),
      }));
      expect(actual).toEqual(
        Object.values(getTableColumns(table)).map((column) => ({
          name: column.name,
          type:
            column.getSQLType() === 'timestamp with time zone'
              ? 'timestamptz'
              : column.getSQLType(),
          notNull: column.notNull,
        })),
      );
      const config = getTableConfig(table);
      for (const check of config.checks)
        expect(body).toContain(`CONSTRAINT ${check.name} CHECK`);
      for (const key of config.uniqueConstraints)
        expect(body).toContain(`CONSTRAINT ${key.name} UNIQUE`);
      for (const key of config.foreignKeys)
        expect(body).toContain(`CONSTRAINT ${key.getName()} FOREIGN KEY`);
    }
  });
  it('has no user or session identity, and binds child records to original run digest and country', () => {
    for (const table of Object.values(tables)) {
      expect(Object.keys(getTableColumns(table))).not.toContain('userId');
      expect(Object.keys(getTableColumns(table))).not.toContain('sessionId');
    }
    for (const table of [tables.notifications, tables.groupReceipts]) {
      const [key] = getTableConfig(table).foreignKeys;
      expect(key.onDelete).toBe('cascade');
      expect(key.reference().columns.map((column) => column.name)).toEqual([
        'task_id',
        'job_digest',
        'country',
      ]);
      expect(getTableName(key.reference().foreignTable)).toBe(`${prefix}_runs`);
    }
    expect(migration).toContain(`domain='${domain}' AND actor_kind='system'`);
    expect(migration).toContain(
      "job - ARRAY['version','source','taskType','actor','taskId','jobId'",
    );
  });
  it('protects bounded snapshots, frozen ordinal and notification acknowledgement states', () => {
    expect(migration).toContain('jsonb_array_length(groups)<=1000');
    expect(migration).toContain('octet_length(groups::text)<=16777216');
    expect(migration).toContain('total_members BETWEEN 0 AND 20000');
    expect(migration).toContain('UNIQUE(task_id,ordinal)');
    expect(migration).toContain('UNIQUE(task_id,group_id)');
    expect(migration).toContain(
      'octet_length(result::text) BETWEEN 1 AND 33554432',
    );
    expect(migration).toContain("state='claimed' AND completed_at IS NULL");
    expect(migration).toContain(
      "state IN ('sent','failed') AND completed_at IS NOT NULL",
    );
    expect(migration).toContain(
      "domain='primary' AND country='US' AND business_completed_at IS NOT NULL",
    );
    expect(migration).toContain('follow_up_requested_at IS NOT NULL');
  });
  it('requires matching logical catalog prerequisites and rolls back only its private ledgers in child-first order', () => {
    expect(migration).toContain(
      `to_regclass('public.${domain}_monitor_runs') IS NULL`,
    );
    expect(migration).toContain(
      `to_regclass('public.${
        domain === 'primary' ? 'competitor_variant_groups' : 'variant_groups'
      }') IS NOT NULL`,
    );
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(migration).toContain("SET LOCAL statement_timeout = '30s'");
    expect(migration).toContain('DO $ledger_upgrade$');
    expect(migration).toContain('scheduled ledger version marker mismatch');
    expect(migration).toContain('scheduled ledger catalog drift');
    expect(
      [...rollback.matchAll(/DROP TABLE public\.([a-z_]+)/g)].map(
        (match) => match[1],
      ),
    ).toEqual([
      `${prefix}_group_receipts`,
      `${prefix}_notifications`,
      `${prefix}_runs`,
    ]);
    expect(rollback).not.toMatch(/\b(?:DELETE|TRUNCATE|ALTER TABLE|CASCADE)\b/);
  });
  it('rejects borrowed identities and unknown root, actor or batch keys with complete strict JSON shape checks', () => {
    for (const column of ['job', 'follow_up_job']) {
      expect(migration).toContain(
        `${column} - ARRAY['version','source','taskType','actor','taskId','jobId','domain','country','plannedSlot','intervalMinutes','batchConfig','requestedAt','createdAt','expiresAt']`,
      );
      expect(migration).toContain(
        `(${column}->'actor') - ARRAY['kind','purpose']`,
      );
      expect(migration).toContain(
        `(${column}->'batchConfig') - ARRAY['batchIndex','totalBatches']`,
      );
      for (const field of [
        'taskId',
        'jobId',
        'plannedSlot',
        'requestedAt',
        'createdAt',
        'expiresAt',
      ])
        expect(migration).toContain(
          `jsonb_typeof(${column}->'${field}')='string'`,
        );
    }
    expect(migration).toContain(') IS TRUE)');
    expect(migration).toContain('follow_up_requested_at=business_completed_at');
    expect(migration).toContain(
      "(follow_up_job->>'createdAt')::timestamptz=business_completed_at",
    );
    expect(migration).toContain(
      "(follow_up_job->>'expiresAt')::timestamptz=expires_at",
    );
  });
  it('creates preflight-missing objects without skip-or-stamp and validates owned upgrades before updating their fingerprints', () => {
    expect(migration).not.toMatch(/CREATE (?:TABLE|INDEX) IF NOT EXISTS/);
    expect(migration).toContain(
      'preflight_relations := array_append(preflight_relations,relation)',
    );
    expect(migration).toContain('IF preflight_relations[1] IS NULL THEN');
    expect(migration).toContain('IF preflight_relations[2] IS NULL THEN');
    expect(migration).toContain('IF preflight_relations[3] IS NULL THEN');
    expect(migration).toContain(
      `ALTER TABLE public.${prefix}_runs DROP CONSTRAINT ck_${prefix}_job, DROP CONSTRAINT ck_${prefix}_follow_up`,
    );
    expect(migration.indexOf('scheduled ledger catalog drift')).toBeLessThan(
      migration.indexOf('ALTER TABLE public.'),
    );
    expect(migration.indexOf('ALTER TABLE public.')).toBeLessThan(
      migration.indexOf('COMMENT ON TABLE'),
    );
    expect(migration).toContain('owned_relations[ordinal] <> relation');
  });
  it('keeps Drizzle strict JSON checks identical to both the new-table and owned-table upgrade predicates', () => {
    const dialect = new PgDialect();
    for (const suffix of ['job', 'follow_up']) {
      const name = `ck_${prefix}_${suffix}`;
      const check = getTableConfig(tables.runs).checks.find(
        (value) => value.name === name,
      );
      expect(check).toBeDefined();
      const query = dialect.sqlToQuery(check!.value);
      expect(query.params).toEqual([]);
      const normalize = (value: string) =>
        value
          .replace(new RegExp(`"${prefix}_runs"\\."([a-z_]+)"`, 'g'), '$1')
          .replace(/\s+/g, '');
      const predicates = [
        ...migration.matchAll(
          new RegExp(`CONSTRAINT ${name} CHECK \\(([^\\n]*)\\)`, 'g'),
        ),
      ];
      expect(predicates).toHaveLength(2);
      for (const predicate of predicates)
        expect(normalize(predicate[1])).toBe(normalize(query.sql));
    }
  });
  it('verifies every existing ledger ownership marker under locks before any rollback drop', () => {
    expect(rollback).toContain('DO $ledger_rollback_preflight$');
    const preflight = rollback
      .split('DO $ledger_rollback_preflight$')[1]
      ?.split('$ledger_rollback_preflight$;')[0];
    expect(preflight).toBeDefined();
    expect(preflight).toContain(
      `amazon-asin-monitor:scheduled-ledger:${domain}`,
    );
    expect(preflight).toContain('pg_advisory_xact_lock');
    expect(preflight).toContain('IN ACCESS EXCLUSIVE MODE');
    expect(preflight).toContain("obj_description(relation,'pg_class')");
    expect(preflight).toContain(
      `amazon-asin-monitor:scheduled-ledger:v1:${domain}:`,
    );
    expect(preflight).toContain("'[a-f0-9]{32}$'");
    expect(preflight).toContain("relkind <> 'r'");
    expect(preflight).toContain('scheduled ledger version marker mismatch');
    expect(preflight).toContain(
      'owned_relations := array_append(owned_relations,relation)',
    );
    for (const table of Object.values(tables))
      expect(preflight).toContain(
        `to_regclass('public.${getTableName(table)}')=ANY(owned_relations)`,
      );
    expect(
      rollback.indexOf('scheduled ledger version marker mismatch'),
    ).toBeLessThan(rollback.indexOf('DROP TABLE public.'));
  });
  it('rejects wrong logical catalogs for present ledgers while missing ledgers are a no-op', () => {
    expect(rollback).toContain('IF NOT ledger_present THEN RETURN; END IF');
    expect(rollback).toContain(
      `to_regclass('public.${domain}_monitor_runs') IS NULL`,
    );
    expect(rollback).toContain(
      `to_regclass('public.${
        domain === 'primary' ? 'competitor_variant_groups' : 'variant_groups'
      }') IS NOT NULL`,
    );
    expect(rollback).toContain(
      'scheduled monitor target prerequisite mismatch',
    );
    expect(rollback).toContain('SET LOCAL search_path = pg_catalog, public');
  });
});
