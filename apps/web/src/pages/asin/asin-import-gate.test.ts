import { describe, expect, it } from 'vitest';
import {
  claimAsinImportGate,
  readAsinImportGate,
  writeAsinImportGate,
} from './asin-import-gate';

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
    expect(readAsinImportGate(storage, 'user-a')).toEqual({
      phase: 'uncertain',
      taskId: null,
      savedAt: time,
    });
    expect(readAsinImportGate(storage, 'user-b')).toBeNull();
  });

  it('keeps an accepted task ID until explicit reconciliation and discards invalid entries', () => {
    const storage = new MemoryStorage();
    const time = Date.UTC(2026, 8, 27);
    const taskId = 'b2b5894c-5802-4c9f-a1bd-9a20263d270a';
    writeAsinImportGate(storage, 'user-a', {
      phase: 'accepted',
      taskId,
      savedAt: time,
    });
    expect(readAsinImportGate(storage, 'user-a')?.taskId).toBe(taskId);
    expect(readAsinImportGate(storage, 'user-a')).toMatchObject({
      phase: 'accepted',
      taskId,
    });
    storage.setItem(
      'neo:asin-import:user-a',
      JSON.stringify({ phase: 'accepted', taskId: '../unsafe', savedAt: time }),
    );
    expect(readAsinImportGate(storage, 'user-a')).toBeNull();
  });

  it('keeps a valid gate when the local clock is behind its saved timestamp', () => {
    const storage = new MemoryStorage();
    writeAsinImportGate(storage, 'user-a', {
      phase: 'accepted',
      taskId: 'b2b5894c-5802-4c9f-a1bd-9a20263d270a',
      savedAt: Date.now() + 86400_000,
    });
    expect(readAsinImportGate(storage, 'user-a')?.phase).toBe('accepted');
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

  it('serializes two tabs claiming the same user import', async () => {
    const storage = new MemoryStorage();
    let prior = Promise.resolve();
    const exclusive = async <T>(_name: string, action: () => T): Promise<T> => {
      const before = prior;
      let release!: () => void;
      prior = new Promise<void>((resolve) => {
        release = resolve;
      });
      await before;
      try {
        return action();
      } finally {
        release();
      }
    };
    const results = await Promise.all([
      exclusive('user-a', () => claimAsinImportGate(storage, 'user-a')),
      exclusive('user-a', () => claimAsinImportGate(storage, 'user-a')),
    ]);
    expect(results.map((result) => result.kind)).toEqual([
      'claimed',
      'blocked',
    ]);
    expect(results[1]).toMatchObject({
      gate: { phase: 'uncertain', taskId: null },
    });
  });

  it('uses the time after waiting for the lock when reading another tab claim', async () => {
    const storage = new MemoryStorage();
    let time = 100;
    const exclusive = async <T>(_name: string, action: () => T) => {
      await Promise.resolve();
      writeAsinImportGate(storage, 'user-a', {
        phase: 'accepted',
        taskId: 'b2b5894c-5802-4c9f-a1bd-9a20263d270a',
        savedAt: 200,
      });
      time = 201;
      return action();
    };
    expect(
      await exclusive('user-a', () =>
        claimAsinImportGate(storage, 'user-a', () => time),
      ),
    ).toMatchObject({ kind: 'blocked', gate: { phase: 'accepted' } });
  });
});
