import type { PrimaryMonitorJob } from '@asin-monitor/contracts';
import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogOperationIdentity } from '../src/domain/catalog-operation';
import {
  withCatalogOperationExecution,
  withCatalogOperationExemptExecution,
} from '../src/repositories/catalog-operation-execution';
import type { PgCatalogOperationRepository } from '../src/repositories/catalog-operation-repository';
import { PgPrimaryMonitorRepository } from '../src/repositories/primary-monitor-repository';

const identity: CatalogOperationIdentity = {
  ownerId: 'synthetic-owner',
  domain: 'asin',
  kind: 'monitor',
  generation: '1',
  operationId: '00000000-0000-4000-8000-000000000224',
};
const job = {
  taskId: '00000000-0000-4000-8000-000000000225',
  userId: identity.ownerId,
  createdAt: '2026-10-07T00:00:00.000Z',
  expiresAt: '2026-10-08T00:00:00.000Z',
  countries: ['US'],
} as PrimaryMonitorJob;
const methods = ['groups', 'claim', 'complete'] as const;
function fixture() {
  const events: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (sql: string) => {
      events.push(sql);
      if (sql.startsWith('SELECT user_id')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('SELECT id,'))
        return { rows: [{ id: 'literal group ', country: 'US' }], rowCount: 1 };
      return { rows: [{ state: 'claimed' }], rowCount: 1 };
    }),
    release: vi.fn((_discard?: boolean) => {
      events.push('release');
    }),
  });
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async () => ({ rowCount: 2 })),
  };
  const pin = { identity, pinId: job.taskId };
  const fence = {
    beginPin: vi.fn(async () => {
      events.push('pin');
      return pin;
    }),
    assertPin: vi.fn(async () => {
      events.push('guard');
    }),
    finishPin: vi.fn(async () => {
      events.push('settle');
    }),
  };
  const repo = new PgPrimaryMonitorRepository(pool as unknown as Pool);
  const run = (method: (typeof methods)[number]) =>
    method === 'groups'
      ? repo.groups(job)
      : method === 'claim'
      ? repo.claimNotification(job.taskId, 'US')
      : repo.completeNotification(job.taskId, 'US', true);
  const scoped = (action: () => Promise<unknown>, operation = identity) =>
    withCatalogOperationExecution(
      fence as unknown as PgCatalogOperationRepository,
      operation,
      action,
    );
  return { events, client, pool, fence, repo, run, scoped, pin };
}

describe('primary monitor / real repository with synthetic SQL transport', () => {
  it.each(methods)(
    'refuses an unscoped %s before its business SQL',
    async (method) => {
      const f = fixture();
      await expect(f.run(method)).rejects.toThrow('CATALOG_OPERATION_MISSING');
      expect(f.client.query.mock.calls.map(([sql]) => sql)).toEqual([
        'BEGIN',
        'ROLLBACK',
      ]);
    },
  );
  it.each(methods)(
    'holds an actual %s pin until COMMIT and returns the client before settlement',
    async (method) => {
      const f = fixture();
      await f.scoped(() => f.run(method));
      expect(f.fence.beginPin).toHaveBeenCalledExactlyOnceWith(identity);
      expect(f.fence.assertPin).toHaveBeenCalledOnce();
      expect(f.fence.finishPin).toHaveBeenCalledExactlyOnceWith(
        f.pin,
        'committed',
      );
      expect(f.events[0]).toBe('pin');
      expect(f.events.indexOf('guard')).toBeLessThan(
        f.events.findIndex((sql) =>
          /^(INSERT|UPDATE|SELECT pg_advisory)/.test(sql),
        ),
      );
      expect(f.events.slice(-3)).toEqual(['COMMIT', 'release', 'settle']);
      expect(f.client.release).toHaveBeenCalledExactlyOnceWith(false);
    },
  );
  it.each(methods)(
    'allows trusted scheduled %s but rejects anonymous-check exemption',
    async (method) => {
      const f = fixture();
      await withCatalogOperationExemptExecution(
        'scheduled-system',
        async () => {
          await f.run(method);
        },
      );
      expect(f.fence.beginPin).not.toHaveBeenCalled();
      f.client.query.mockClear();
      await expect(
        withCatalogOperationExemptExecution('anonymous-check', async () => {
          await f.run(method);
        }),
      ).rejects.toThrow('CATALOG_OPERATION_IDENTITY');
      expect(f.client.query.mock.calls.map(([sql]) => sql)).toEqual([
        'BEGIN',
        'ROLLBACK',
      ]);
    },
  );
  it('rejects a closed generation and wrong domain before business writes, recording definite rollback', async () => {
    const f = fixture();
    f.fence.assertPin.mockRejectedValueOnce(
      new Error('CATALOG_OPERATION_CLOSED'),
    );
    await expect(f.scoped(() => f.run('groups'))).rejects.toThrow(
      'CATALOG_OPERATION_CLOSED',
    );
    expect(f.fence.finishPin).toHaveBeenLastCalledWith(f.pin, 'rolled-back');
    expect(f.client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'ROLLBACK',
    ]);
    f.client.query.mockClear();
    await expect(
      f.scoped(() => f.run('complete'), { ...identity, domain: 'competitor' }),
    ).rejects.toThrow('CATALOG_OPERATION_IDENTITY');
    expect(f.client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'ROLLBACK',
    ]);
  });
  it('records definite rollback only after its actual ACK', async () => {
    const f = fixture();
    f.client.query.mockImplementation(async (sql) => {
      f.events.push(sql);
      if (sql.startsWith('INSERT'))
        throw new Error('synthetic write rejection');
      return { rowCount: 1, rows: [] };
    });
    await expect(f.scoped(() => f.run('claim'))).rejects.toThrow(
      'synthetic write rejection',
    );
    expect(f.events.slice(-3)).toEqual(['ROLLBACK', 'release', 'settle']);
    expect(f.fence.finishPin).toHaveBeenCalledExactlyOnceWith(
      f.pin,
      'rolled-back',
    );
  });
  it.each(['COMMIT', 'ROLLBACK'])(
    'keeps an uncertain pin when the %s ACK is lost',
    async (lost) => {
      const f = fixture();
      f.client.query.mockImplementation(async (sql) => {
        f.events.push(sql);
        if (sql === lost || (lost === 'ROLLBACK' && sql.startsWith('INSERT')))
          throw new Error('synthetic lost ACK');
        return { rowCount: 1, rows: [] };
      });
      await expect(f.scoped(() => f.run('claim'))).rejects.toThrow(
        'synthetic lost ACK',
      );
      expect(f.fence.finishPin).toHaveBeenCalledExactlyOnceWith(
        f.pin,
        'uncertain',
      );
      expect(f.client.release).toHaveBeenCalledExactlyOnceWith(true);
      if (lost === 'COMMIT') expect(f.events).not.toContain('ROLLBACK');
    },
  );
  it('keeps connection failure uncertain even if a later query promise resolves', async () => {
    const f = fixture();
    f.client.query.mockImplementation(async (sql) => {
      f.events.push(sql);
      if (sql.startsWith('INSERT'))
        f.client.emit('error', new Error('synthetic connection loss'));
      return { rowCount: 1, rows: [] };
    });
    await expect(f.scoped(() => f.run('claim'))).rejects.toThrow(
      'MONITOR_DATABASE_CONNECTION_LOST',
    );
    expect(f.events).not.toContain('COMMIT');
    expect(f.events).not.toContain('ROLLBACK');
    expect(f.fence.finishPin).toHaveBeenCalledExactlyOnceWith(
      f.pin,
      'uncertain',
    );
  });
  it('settles a failed connection acquisition as rolled back without starting SQL', async () => {
    const f = fixture();
    f.pool.connect.mockRejectedValueOnce(
      new Error('synthetic acquisition failure'),
    );
    await expect(f.scoped(() => f.run('claim'))).rejects.toThrow(
      'synthetic acquisition failure',
    );
    expect(f.client.query).not.toHaveBeenCalled();
    expect(f.fence.finishPin).toHaveBeenCalledExactlyOnceWith(
      f.pin,
      'rolled-back',
    );
  });
  it('does not mistake an outer cancellation for physical COMMIT settlement', async () => {
    const f = fixture();
    let commit!: () => void;
    const ack = new Promise<void>((resolve) => {
      commit = resolve;
    });
    f.client.query.mockImplementation(async (sql) => {
      f.events.push(sql);
      if (sql === 'COMMIT') await ack;
      return { rowCount: 1, rows: [] };
    });
    const actual = f.scoped(() => f.run('claim'));
    await vi.waitFor(() => expect(f.events).toContain('COMMIT'));
    await expect(
      Promise.race([actual, Promise.reject(new Error('outer cancelled'))]),
    ).rejects.toThrow('outer cancelled');
    expect(f.fence.finishPin).not.toHaveBeenCalled();
    expect(f.client.release).not.toHaveBeenCalled();
    commit();
    await actual;
    expect(f.fence.finishPin).toHaveBeenCalledExactlyOnceWith(
      f.pin,
      'committed',
    );
  });
  it('retains raw maintenance readiness/purge without a catalog operation', async () => {
    const f = fixture();
    await f.repo.assertReady();
    expect(await f.repo.purgeExpiredRuns()).toBe(2);
    expect(f.pool.query).toHaveBeenCalledTimes(2);
    expect(f.pool.connect).not.toHaveBeenCalled();
    expect(f.fence.beginPin).not.toHaveBeenCalled();
  });
});
