import { describe, expect, it } from 'vitest';
import {
  catalogSafetyKey,
  readCatalogSafetyGate,
  writeCatalogSafetyGate,
} from './catalog-safety-gate';

class MemoryStorage {
  private readonly entries = new Map<string, string>();
  getItem(key: string) {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.entries.set(key, value);
  }
  removeItem(key: string) {
    this.entries.delete(key);
  }
}

describe('catalog write safety across page loads', () => {
  it('binds original-session recovery to the current user and exact operation without trimming the source group', () => {
    const storage = new MemoryStorage();
    const gate = {
      phase: 'refresh' as const,
      message: '已知部分回执',
      detailId: ' source group ',
      createUncertain: false,
      batchCreate: true,
      batchCreateOwner: JSON.stringify(['asin', 'owner', 'session-1']),
      operationId: 'original-operation',
    };
    expect(writeCatalogSafetyGate(storage, 'owner', 'asin', gate)).toBe(true);
    expect(readCatalogSafetyGate(storage, 'owner', 'asin')).toEqual(gate);
  });

  it.each([
    JSON.stringify(['asin', 'other', 'session-1']),
    JSON.stringify(['competitor', 'owner', 'session-1']),
    JSON.stringify(['asin', 'owner', {}]),
    'broken',
  ])(
    'retains write protection while rejecting an invalid original-session owner %s',
    (batchCreateOwner) => {
      const storage = new MemoryStorage();
      const key = catalogSafetyKey('owner', 'asin');
      storage.setItem(
        key,
        JSON.stringify({
          phase: 'refresh',
          message: null,
          detailId: ' group ',
          createUncertain: true,
          batchCreate: true,
          batchCreateOwner,
          operationId: 'original-operation',
        }),
      );
      const gate = readCatalogSafetyGate(storage, 'owner', 'asin');
      expect(gate).toMatchObject({
        phase: 'refresh',
        createUncertain: false,
        batchCreate: true,
        detailId: ' group ',
        operationId: 'original-operation',
      });
      expect(gate).not.toHaveProperty('batchCreateOwner');
      expect(storage.getItem(key)).not.toBeNull();
    },
  );
  it.each(['asin', 'competitor'])(
    'preserves fifty-codepoint detail IDs while rejecting fifty-one in the %s catalog',
    (source) => {
      const storage = new MemoryStorage();
      const detailId = ` ${'😀'.repeat(48)} `;
      const gate = {
        phase: 'refresh' as const,
        message: null,
        detailId,
        createUncertain: false,
        operationId: 'fixture-operation',
      };
      expect([...detailId]).toHaveLength(50);
      expect(detailId.length).toBeGreaterThan(50);
      expect(writeCatalogSafetyGate(storage, 'owner', source, gate)).toBe(true);
      expect(readCatalogSafetyGate(storage, 'owner', source)).toEqual(gate);
      expect(storage.getItem(catalogSafetyKey('owner', source))).not.toBeNull();

      storage.setItem(
        catalogSafetyKey('owner', source),
        JSON.stringify({ ...gate, detailId: `${detailId}x` }),
      );
      expect(readCatalogSafetyGate(storage, 'owner', source)).toBeNull();
      expect(storage.getItem(catalogSafetyKey('owner', source))).toBeNull();
    },
  );

  it('keeps uncertain creation locked for the same user and catalog until explicit reconciliation', () => {
    const storage = new MemoryStorage();
    const gate = {
      phase: 'refresh' as const,
      message: null,
      detailId: null,
      createUncertain: true,
    };
    expect(writeCatalogSafetyGate(storage, 'owner', 'competitor', gate)).toBe(
      true,
    );
    expect(readCatalogSafetyGate(storage, 'owner', 'competitor')).toEqual(gate);
    expect(readCatalogSafetyGate(storage, 'other', 'competitor')).toBeNull();
    expect(readCatalogSafetyGate(storage, 'owner', 'asin')).toBeNull();
    expect(
      writeCatalogSafetyGate(storage, 'owner', 'competitor', {
        phase: 'inspection',
      }),
    ).toBe(true);
    expect(readCatalogSafetyGate(storage, 'owner', 'competitor')).toEqual({
      phase: 'inspection',
    });
    expect(writeCatalogSafetyGate(storage, 'owner', 'competitor', null)).toBe(
      true,
    );
    expect(readCatalogSafetyGate(storage, 'owner', 'competitor')).toBeNull();
  });

  it('rejects malformed stored gates and reports storage failures', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'neo:catalog-write-safety:owner:competitor',
      JSON.stringify({ phase: 'refresh', createUncertain: true }),
    );
    expect(readCatalogSafetyGate(storage, 'owner', 'competitor')).toBeNull();
    expect(
      writeCatalogSafetyGate(
        {
          setItem: () => {
            throw new Error('denied');
          },
          removeItem: () => undefined,
        },
        'owner',
        'competitor',
        { phase: 'inspection' },
      ),
    ).toBe(false);
  });
});
