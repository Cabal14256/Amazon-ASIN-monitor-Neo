import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
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
        ...migration.matchAll(/CREATE TABLE IF NOT EXISTS public\.([a-z_]+)/g),
      ].map((match) => match[1]),
    ).toEqual([
      `${prefix}_runs`,
      `${prefix}_notifications`,
      `${prefix}_group_receipts`,
    ]);
    for (const table of Object.values(tables)) {
      const name = getTableName(table);
      const body = migration
        .split(`CREATE TABLE IF NOT EXISTS public.${name} (`)[1]
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
    expect(migration).toContain("NOT (job ? 'userId')");
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
    expect(migration).toContain('DO $ledger_preflight$');
    expect(migration).toContain('DO $ledger_postflight$');
    expect(migration).toContain('scheduled ledger version marker mismatch');
    expect(migration).toContain('scheduled ledger catalog drift');
    expect(
      [...rollback.matchAll(/DROP TABLE IF EXISTS public\.([a-z_]+)/g)].map(
        (match) => match[1],
      ),
    ).toEqual([
      `${prefix}_group_receipts`,
      `${prefix}_notifications`,
      `${prefix}_runs`,
    ]);
    expect(rollback).not.toMatch(/\b(?:DELETE|TRUNCATE|ALTER TABLE|CASCADE)\b/);
  });
});
