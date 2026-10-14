import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { CatalogOperationError } from '../src/domain/catalog-operation';
import { PgCatalogOperationRepository } from '../src/repositories/catalog-operation-repository';

function fixture(stage: 'insert' | 'slot' | 'administration', error?: Error) {
  const statements: string[] = [];
  const query = vi.fn(async (raw: string | { text: string }) => {
    const text = typeof raw === 'string' ? raw : raw.text;
    statements.push(text);
    const target =
      stage === 'insert'
        ? /INSERT INTO catalog_operation_slots/.test(text)
        : stage === 'slot'
        ? /SELECT[\s\S]*FROM catalog_operation_slots/.test(text)
        : /pg_advisory_xact_lock_shared/.test(text);
    if (target && error) throw error;
    return {
      rows: /SELECT[\s\S]*FROM catalog_operation_slots/.test(text)
        ? [{ state: 'idle', generation: '0' }]
        : [],
    };
  });
  const client = Object.assign(new EventEmitter(), { query, release: vi.fn() });
  const pool = { connect: vi.fn(async () => client) };
  const repository = new PgCatalogOperationRepository(pool as unknown as Pool);
  const authorize = vi.fn(async () => undefined);
  const reserve = () =>
    repository.reserve(
      { ownerId: 'fixture-owner', domain: 'competitor', kind: 'write' },
      authorize,
    );
  return { reserve, authorize, statements, client };
}

// Exercises the production Pg repository and its real bounded transaction/
// Drizzle chain at the driver seam. Real held PostgreSQL locks remain a separate
// opt-in integration gate; these mocks do not claim physical rollback proof.
describe('catalog reservation / PostgreSQL contention classification', () => {
  it.each(['55P03', '57014'])(
    'reports %s from its slot lock as BUSY before authorization or a business mutation',
    async (code) => {
      const f = fixture(
        'slot',
        Object.assign(new Error('private native diagnostic'), { code }),
      );
      await expect(f.reserve()).rejects.toMatchObject({
        code: 'CATALOG_OPERATION_BUSY',
      });
      expect(f.authorize).not.toHaveBeenCalled();
      expect(
        f.statements.some((text) =>
          /UPDATE catalog_operation_slots/.test(text),
        ),
      ).toBe(false);
      expect(f.client.release).toHaveBeenCalledExactlyOnceWith(true);
    },
  );
  it('reports the first absent-slot INSERT arbitration timeout as BUSY without publishing an owner', async () => {
    const f = fixture(
      'insert',
      Object.assign(new Error('private native diagnostic'), { code: '57014' }),
    );
    await expect(f.reserve()).rejects.toMatchObject({
      code: 'CATALOG_OPERATION_BUSY',
    });
    expect(f.authorize).not.toHaveBeenCalled();
    expect(
      f.statements.some((text) =>
        /SELECT[\s\S]*FROM catalog_operation_slots/.test(text),
      ),
    ).toBe(false);
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('preserves an IO failure instead of presenting it as a busy catalog', async () => {
    const error = Object.assign(new Error('private IO diagnostic'), {
      code: 'ECONNRESET',
    });
    const f = fixture('slot', error);
    const rejected = await f.reserve().catch((reason: unknown) => reason);
    expect(rejected).not.toBeInstanceOf(CatalogOperationError);
    expect(rejected).toMatchObject({ cause: error });
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('does not classify a shared administration lock failure as slot contention', async () => {
    const error = Object.assign(
      new Error('private administration diagnostic'),
      { code: '55P03' },
    );
    const f = fixture('administration', error);
    const rejected = await f.reserve().catch((reason: unknown) => reason);
    expect(rejected).not.toBeInstanceOf(CatalogOperationError);
    expect(rejected).toMatchObject({ cause: error });
    expect(
      f.statements.some((text) =>
        /INSERT INTO catalog_operation_slots/.test(text),
      ),
    ).toBe(false);
    expect(f.authorize).not.toHaveBeenCalled();
  });
  it('preserves a current authorization rejection even if its error carries a PostgreSQL code', async () => {
    const f = fixture('slot');
    const error = Object.assign(new Error('current authorization rejected'), {
      code: '57014',
    });
    f.authorize.mockRejectedValueOnce(error);
    await expect(f.reserve()).rejects.toBe(error);
    expect(f.authorize).toHaveBeenCalledOnce();
    expect(
      f.statements.some((text) => /UPDATE catalog_operation_slots/.test(text)),
    ).toBe(false);
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('keeps successful reservation authorization and transaction deadlines intact', async () => {
    const f = fixture('slot');
    await expect(f.reserve()).resolves.toMatchObject({
      ownerId: 'fixture-owner',
      domain: 'competitor',
      generation: '1',
      kind: 'write',
    });
    expect(f.authorize).toHaveBeenCalledOnce();
    expect(f.statements).toContain('SET LOCAL statement_timeout = 1500');
    expect(f.statements.at(-1)).toBe('COMMIT');
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith();
  });
});
