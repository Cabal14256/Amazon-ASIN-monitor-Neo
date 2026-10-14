import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  catalogOperationPins,
  catalogOperationSlots,
} from '../src/schema/catalog-operation';

const upgrade = readFileSync(
  resolve(__dirname, '../migrations/0017_catalog_operation_fence.sql'),
  'utf8',
);
const rollback = readFileSync(
  resolve(__dirname, '../migrations/0017_catalog_operation_fence.rollback.sql'),
  'utf8',
);
describe('catalog fence typed schema / deployment contract', () => {
  it.each([catalogOperationSlots, catalogOperationPins])(
    'keeps typed columns and named constraints aligned with the actual SQL',
    (table) => {
      const name = getTableName(table);
      const body = upgrade
        .split(`CREATE TABLE public.${name} (`)[1]
        ?.split('\n    );')[0];
      expect(body).toBeDefined();
      const columns = [
        ...body!.matchAll(
          /^      ([a-z_]+) (uuid|varchar\(\d+\)|jsonb|bigint|text|timestamptz)([^\n]*)/gm,
        ),
      ].map((match) => ({
        name: match[1],
        type: match[2],
        notNull: /NOT NULL|PRIMARY KEY/.test(match[3]),
      }));
      expect(columns).toEqual(
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
    },
  );
  it('keeps account deletion independent from live reservations and binds every pin to full immutable identity', () => {
    expect(getTableConfig(catalogOperationSlots).foreignKeys).toHaveLength(0);
    const [fk] = getTableConfig(catalogOperationPins).foreignKeys;
    expect(fk.onDelete).toBe('restrict');
    expect(fk.reference().columns.map((column) => column.name)).toEqual([
      'owner_id',
      'domain',
      'generation',
      'operation_id',
    ]);
    expect(getTableName(fk.reference().foreignTable)).toBe(
      'catalog_operation_slots',
    );
    expect(upgrade).toContain('owner_id varchar(50) COLLATE "C"');
  });
  it('owns only its two tables and refuses unresolved or structurally drifted rollback', () => {
    expect(
      [...upgrade.matchAll(/CREATE TABLE public\.([a-z_]+)/g)].map(
        (match) => match[1],
      ),
    ).toEqual(['catalog_operation_slots', 'catalog_operation_pins']);
    expect(
      [...rollback.matchAll(/DROP TABLE public\.([a-z_]+)/g)].map(
        (match) => match[1],
      ),
    ).toEqual(['catalog_operation_pins', 'catalog_operation_slots']);
    for (const text of [upgrade, rollback]) {
      expect(text).toContain('neo-catalog-operation-fence-v1:');
      expect(text).toContain('pg_get_triggerdef');
      expect(text).toContain('pg_policy');
      expect(text).toContain(
        "obj_description(relation,'pg_class') IS DISTINCT FROM marker",
      );
    }
    expect(rollback).toContain("WHERE state<>'idle'");
    expect(rollback).toContain(
      'OR EXISTS(SELECT 1 FROM public.catalog_operation_pins)',
    );
    expect(rollback).toContain('IN ACCESS EXCLUSIVE MODE');
  });
});
