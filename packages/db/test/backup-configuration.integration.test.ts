import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPgPool,
  createShanghaiTimestampTypeOverrides,
} from '../src/client';
import { PgBackupConfigRepository } from '../src/repositories/backup-configuration-repository';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'migrated backup configuration on PostgreSQL',
  () => {
    const schema = `backup_configuration_161_${randomUUID().replaceAll(
      '-',
      '',
    )}`;
    let bootstrap: Pool;
    let pool: Pool;
    let installed = false;
    beforeAll(async () => {
      if (!/^backup_configuration_161_[a-f0-9]{32}$/.test(schema))
        throw new Error('Invalid fixture schema');
      bootstrap = createPgPool(process.env.DATABASE_URL!, {
        max: 1,
        connectionTimeoutMillis: 2000,
      });
      await bootstrap.query(`CREATE SCHEMA ${schema}`);
      installed = true;
      await bootstrap.query(
        `CREATE TABLE ${schema}.backup_config (LIKE public.backup_config INCLUDING ALL)`,
      );
      const url = new URL(process.env.DATABASE_URL!);
      url.searchParams.set(
        'options',
        `-c search_path=${schema},public -c timezone=UTC`,
      );
      pool = createPgPool(url.toString(), {
        max: 2,
        connectionTimeoutMillis: 2000,
        types: createShanghaiTimestampTypeOverrides(),
      });
      expect(
        (await pool.query('SELECT current_schema() AS schema')).rows[0].schema,
      ).toBe(schema);
    });
    afterAll(async () => {
      try {
        await pool?.end();
      } finally {
        if (bootstrap) {
          try {
            if (installed)
              await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`);
          } finally {
            await bootstrap.end();
          }
        }
      }
    });
    it('reads and updates the first Legacy row without deleting or changing later rows', async () => {
      // Reverse insertion order proves that physical scan order is irrelevant.
      await pool.query(
        `INSERT INTO backup_config (id,enabled,schedule_type,schedule_value,backup_time) OVERRIDING SYSTEM VALUE VALUES (9,false,'monthly',31,'03:00'),(2,true,'weekly',1,'04:00')`,
      );
      const repo = new PgBackupConfigRepository(pool);
      await expect(
        repo.transaction((unit) => unit.get()),
      ).resolves.toMatchObject({
        id: 2,
        enabled: true,
        scheduleType: 'weekly',
        scheduleValue: 1,
        backupTime: '04:00',
      });
      await expect(
        repo.transaction((unit) =>
          unit.upsert({
            enabled: true,
            scheduleType: 'daily',
            backupTime: '05:00',
          }),
        ),
      ).resolves.toMatchObject({
        id: 2,
        enabled: true,
        scheduleType: 'daily',
        scheduleValue: null,
        backupTime: '05:00',
      });
      // Scheduler and API use this same get path after a hot configuration update.
      await expect(
        repo.transaction((unit) => unit.get()),
      ).resolves.toMatchObject({ id: 2, backupTime: '05:00' });
      expect(
        (
          await pool.query(
            'SELECT id,enabled,schedule_type,schedule_value,backup_time FROM backup_config ORDER BY id',
          )
        ).rows,
      ).toEqual([
        {
          id: 2,
          enabled: true,
          schedule_type: 'daily',
          schedule_value: null,
          backup_time: '05:00',
        },
        {
          id: 9,
          enabled: false,
          schedule_type: 'monthly',
          schedule_value: 31,
          backup_time: '03:00',
        },
      ]);
    });
  },
);
