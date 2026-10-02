import { describe, expect, it } from 'vitest';
import {
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
