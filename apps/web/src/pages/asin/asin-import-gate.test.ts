import { describe, expect, it } from 'vitest';
import { readAsinImportGate, writeAsinImportGate } from './asin-import-gate';

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

describe('ASIN import retry gate', () => {
  it('survives route remount, scopes by owner and makes interrupted sending uncertain', () => {
    const storage = new MemoryStorage();
    const time = Date.UTC(2026, 8, 27);
    writeAsinImportGate(storage, 'user-a', {
      phase: 'sending',
      taskId: null,
      savedAt: time,
    });
    expect(readAsinImportGate(storage, 'user-a', time + 1000)).toEqual({
      phase: 'uncertain',
      taskId: null,
      savedAt: time,
    });
    expect(readAsinImportGate(storage, 'user-b', time + 1000)).toBeNull();
  });

  it('keeps an accepted task ID and discards expired or invalid entries', () => {
    const storage = new MemoryStorage();
    const time = Date.UTC(2026, 8, 27);
    const taskId = 'b2b5894c-5802-4c9f-a1bd-9a20263d270a';
    writeAsinImportGate(storage, 'user-a', {
      phase: 'accepted',
      taskId,
      savedAt: time,
    });
    expect(readAsinImportGate(storage, 'user-a', time + 1000)?.taskId).toBe(
      taskId,
    );
    expect(
      readAsinImportGate(storage, 'user-a', time + 8 * 86400_000),
    ).toBeNull();
    storage.setItem(
      'neo:asin-import:user-a',
      JSON.stringify({ phase: 'accepted', taskId: '../unsafe', savedAt: time }),
    );
    expect(readAsinImportGate(storage, 'user-a', time + 1000)).toBeNull();
  });

  it('refuses an upload when the browser cannot persist its retry gate', () => {
    const denied = {
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => undefined,
    };
    expect(
      writeAsinImportGate(denied, 'user-a', {
        phase: 'sending',
        taskId: null,
        savedAt: Date.now(),
      }),
    ).toBe(false);
  });
});
