import { describe, expect, it, vi } from 'vitest';
import { deferred } from '../../lib/transport-fixtures';
import {
  claimImportGate,
  importGateKey,
  readImportGate,
} from '../asin/asin-import-gate';
import { CatalogBatchDeleteRecovery } from './catalog-batch-delete-recovery';
import { writeImportCatalogSafety } from './catalog-operation-lock';
import {
  catalogSafetyKey,
  readCatalogSafetyGate,
  writeCatalogSafetyGate,
} from './catalog-safety-gate';
import {
  claimImportGate as claimMainImport,
  readImportGate as readMainImport,
  writeImportGate as writeMainImport,
} from './fixtures/main-197-asin-import-gate';
import { readCatalogSafetyGate as readMainCatalog } from './fixtures/main-197-catalog-safety-gate';

class MemoryStorage {
  readonly entries = new Map<string, string>();
  getItem = (key: string) => this.entries.get(key) ?? null;
  setItem = (key: string, value: string) => {
    this.entries.set(key, value);
  };
  removeItem = (key: string) => {
    this.entries.delete(key);
  };
}
function locks() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request: (name: string, action: () => unknown) => {
      const result = (tails.get(name) ?? Promise.resolve()).then(action);
      tails.set(
        name,
        result.catch(() => undefined),
      );
      return result;
    },
  } as unknown as Pick<LockManager, 'request'>;
}

describe('actual frozen main 197925d catalog and import readers', () => {
  it.each(['asin', 'competitor'] as const)(
    'queues an old %s import behind new deletion and rejects it after the HTTP ACK',
    async (domain) => {
      const local = new MemoryStorage();
      const browserLocks = locks();
      const reply = deferred<{
        mode: 'async';
        taskId: string;
        status: 'pending';
      }>();
      const send = vi.fn(() => reply.promise);
      const recovery = new CatalogBatchDeleteRecovery(
        'owner',
        domain,
        local,
        null,
        browserLocks,
        () => 'deletion-1',
      );
      const deletion = recovery.submit(['group-1'], send, () => true, vi.fn());
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      const oldPost = vi.fn();
      const oldClaim = vi.fn(() => {
        const claim = claimMainImport(local, domain, 'owner');
        if (claim.kind === 'claimed') oldPost();
        return claim;
      });
      const oldUpload = browserLocks.request(
        importGateKey(domain, 'owner'),
        oldClaim,
      );
      await Promise.resolve();
      expect(oldClaim).not.toHaveBeenCalled();
      reply.resolve({ mode: 'async', taskId: 'task-1', status: 'pending' });
      await deletion;
      expect((await oldUpload).kind).toBe('blocked');
      expect(oldPost).not.toHaveBeenCalled();
      expect(readMainCatalog(local, 'owner', domain)?.phase).toBe('inspection');
    },
  );

  it.each(['asin', 'competitor'] as const)(
    'queues new %s deletion behind the actual old import claim and refuses to send after acceptance',
    async (domain) => {
      const local = new MemoryStorage();
      const browserLocks = locks();
      const reply = deferred<void>();
      const oldPost = vi.fn(async () => {
        expect(claimMainImport(local, domain, 'owner').kind).toBe('claimed');
        await reply.promise;
        writeMainImport(local, domain, 'owner', {
          phase: 'accepted',
          taskId: 'b2b5894c-5802-4c9f-a1bd-9a20263d270a',
          savedAt: 100,
        });
      });
      const oldUpload = browserLocks.request(
        importGateKey(domain, 'owner'),
        oldPost,
      );
      await vi.waitFor(() => expect(oldPost).toHaveBeenCalledOnce());
      const recovery = new CatalogBatchDeleteRecovery(
        'owner',
        domain,
        local,
        null,
        browserLocks,
        () => 'deletion-1',
      );
      const newPost = vi.fn(async () => ({
        mode: 'async' as const,
        taskId: 'task-1',
        status: 'pending' as const,
      }));
      const deletion = recovery.submit(
        ['group-1'],
        newPost,
        () => true,
        vi.fn(),
      );
      await Promise.resolve();
      expect(newPost).not.toHaveBeenCalled();
      reply.resolve();
      await oldUpload;
      await expect(deletion).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
      expect(newPost).not.toHaveBeenCalled();
      expect(local.getItem(importGateKey(domain, 'owner'))).toContain(
        'accepted',
      );
    },
  );
  it.each(
    (['asin', 'competitor'] as const).flatMap((domain) =>
      (['accepted', 'unknown'] as const).map((outcome) => ({
        domain,
        outcome,
      })),
    ),
  )(
    'preserves and blocks $domain $outcome deletion in both old readers without losing the new exact receipt',
    async ({ domain, outcome }) => {
      const local = new MemoryStorage();
      const recovery = new CatalogBatchDeleteRecovery(
        'owner',
        domain,
        local,
        null,
        locks(),
        () => 'deletion-1',
      );
      await recovery.submit(
        ['Grüp-1'],
        async () => {
          if (outcome === 'unknown') throw new Error('synthetic lost response');
          return { mode: 'async', taskId: 'task-1', status: 'pending' };
        },
        () => true,
        vi.fn(),
      );
      const key = catalogSafetyKey('owner', domain);
      const before = local.getItem(key);
      expect(JSON.parse(before!)).toMatchObject({
        phase: 'inspection',
        operationId: 'deletion-1',
        batchDelete: { groupIds: ['Grüp-1'] },
      });
      // Execute the main reader itself, rather than a hand-written approximation.
      expect(readMainCatalog(local, 'owner', domain)).toEqual({
        phase: 'inspection',
        operationId: 'deletion-1',
      });
      expect(local.getItem(key)).toBe(before);
      expect(readMainImport(local, domain, 'owner')).toMatchObject({
        phase: 'uncertain',
        taskId: null,
      });
      expect(claimMainImport(local, domain, 'owner').kind).toBe('blocked');
      expect(recovery.read()).toMatchObject({
        phase: 'batch-delete',
        operationId: 'deletion-1',
        state: outcome === 'unknown' ? 'unknown' : 'task',
        groupIds: ['Grüp-1'],
      });
    },
  );

  it.each(['asin', 'competitor'] as const)(
    'preserves %s import keys while blocking the actual main CRUD reader',
    (domain) => {
      const local = new MemoryStorage();
      const claim = claimImportGate(local, domain, 'owner', () => 100);
      if (claim.kind !== 'claimed') throw new Error('fixture');
      expect(
        writeImportCatalogSafety(
          local,
          'owner',
          domain,
          claim.gate,
          claim.gate,
        ),
      ).toBe(true);
      const raw = local.getItem(catalogSafetyKey('owner', domain));
      expect(readMainCatalog(local, 'owner', domain)?.phase).toBe('inspection');
      expect(local.getItem(catalogSafetyKey('owner', domain))).toBe(raw);
      expect(claimMainImport(local, domain, 'owner').kind).toBe('blocked');
      expect(readCatalogSafetyGate(local, 'owner', domain)?.phase).toBe(
        'import',
      );
      expect(readImportGate(local, domain, 'owner')?.savedAt).toBe(100);
      expect(local.getItem(importGateKey(domain, 'other'))).toBeNull();
    },
  );

  it('retains a damaged envelope and prevents one import from clearing another operation', () => {
    const local = new MemoryStorage();
    const key = catalogSafetyKey('owner', 'asin');
    local.setItem(
      key,
      JSON.stringify({
        phase: 'inspection',
        operationId: 'outer-1',
        batchDelete: { phase: 'batch-delete', operationId: 'different-1' },
      }),
    );
    const raw = local.getItem(key);
    expect(readCatalogSafetyGate(local, 'owner', 'asin')).toMatchObject({
      phase: 'inspection',
    });
    expect(readMainCatalog(local, 'owner', 'asin')).toMatchObject({
      phase: 'inspection',
    });
    expect(local.getItem(key)).toBe(raw);
    expect(
      writeImportCatalogSafety(
        local,
        'owner',
        'asin',
        { phase: 'uncertain', taskId: null, savedAt: 100 },
        null,
      ),
    ).toBe(false);
    expect(local.getItem(key)).toBe(raw);
    expect(
      writeCatalogSafetyGate(local, 'other', 'asin', {
        phase: 'import',
        operationId: 'other-1',
        savedAt: 100,
      }),
    ).toBe(true);
    expect(readMainCatalog(local, 'other', 'asin')?.phase).toBe('inspection');
  });
});
