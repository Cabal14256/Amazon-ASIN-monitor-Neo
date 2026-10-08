import { describe, expect, it } from 'vitest';
import {
  catalogImportBlocksWrite,
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
  it.each(['asin', 'competitor'] as const)(
    'keeps %s imports mutually exclusive by literal owner and domain even when damaged',
    (domain) => {
      const storage = new MemoryStorage();
      const key =
        domain === 'asin'
          ? 'neo:asin-import:owner'
          : 'neo:competitor-import:owner';
      for (const raw of [
        'invalid',
        '',
        JSON.stringify({ phase: 'accepted', taskId: 'fixture' }),
      ]) {
        storage.setItem(key, raw);
        expect(catalogImportBlocksWrite(storage, 'owner', domain)).toBe(true);
        expect(catalogImportBlocksWrite(storage, 'other', domain)).toBe(false);
        expect(
          catalogImportBlocksWrite(
            storage,
            'owner',
            domain === 'asin' ? 'competitor' : 'asin',
          ),
        ).toBe(false);
        expect(storage.getItem(key)).toBe(raw);
      }
      expect(
        catalogImportBlocksWrite(
          {
            getItem: () => {
              throw new Error('denied');
            },
          },
          'owner',
          domain,
        ),
      ).toBe(true);
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
