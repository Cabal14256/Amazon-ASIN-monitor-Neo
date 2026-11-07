import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { importGateKey } from '../asin/asin-import-gate';
import { CatalogBatchDeleteRecovery } from './catalog-batch-delete-recovery';
import { catalogSafetyKey } from './catalog-safety-gate';
import {
  claimImportGate as claimOldImport,
  readImportGate as readOldImport,
  writeImportGate as writeOldImport,
} from './fixtures/main-197-asin-import-gate';
import {
  readCatalogSafetyGate as readOldCatalog,
  writeCatalogSafetyGate as writeOldCatalog,
} from './fixtures/main-197-catalog-safety-gate';
import frozen from './fixtures/main-197-unlock-handlers.json';

class MemoryStorage {
  readonly entries = new Map<string, string>();
  getItem = (key: string) => this.entries.get(key) ?? null;
  setItem = (key: string, value: string) => this.entries.set(key, value);
  removeItem = (key: string) => this.entries.delete(key);
}
const immediateLocks = {
  request: async (_key: string, action: () => unknown) => action(),
} as unknown as Pick<LockManager, 'request'>;

function oldHandlers(
  kind: 'catalog' | 'import',
  context: Record<string, unknown>,
) {
  const declarations = Object.values(frozen.sources[kind].declarations).map(
    ({ text, sha256 }) => {
      expect(createHash('sha256').update(text).digest('hex')).toBe(sha256);
      return text;
    },
  );
  const names = Object.keys(context);
  const output = ts.transpileModule(
    `const { ${names.join(',')} } = context;\n${declarations.join('\n')}\n` +
      (kind === 'catalog'
        ? 'result = { reconcileCreate, beginWrite };'
        : 'result = { canReconcile, unlockAfterReconciliation };'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const sandbox = { context, result: {} as Record<string, unknown> };
  runInNewContext(output, sandbox, { timeout: 1000 });
  return sandbox.result as {
    reconcileCreate(): Promise<void>;
    beginWrite(candidate: unknown): unknown;
    canReconcile: boolean;
    unlockAfterReconciliation(): Promise<void>;
  };
}

async function pendingDeletion(domain: 'asin' | 'competitor') {
  const local = new MemoryStorage();
  const recovery = new CatalogBatchDeleteRecovery(
    'owner',
    domain,
    local,
    null,
    immediateLocks,
    () => 'deletion-1',
  );
  await recovery.submit(
    ['group-1'],
    async () => ({ mode: 'async', taskId: 'task-1', status: 'pending' }),
    () => true,
    vi.fn(),
  );
  expect(recovery.read()).toMatchObject({
    phase: 'batch-delete',
    state: 'task',
    taskId: 'task-1',
  });
  return { local, recovery };
}

/** Negative controls: passing these reproduces the two still-blocking P1s.
 * They are not evidence that old bundles are safe before server fence #229. */
describe('frozen main 197925d old unlock paths require the server operation fence', () => {
  it.each(['asin', 'competitor'] as const)(
    'reproduces the old %s catalog inspection unlock replacing an active deletion guard',
    async (domain) => {
      const { local } = await pendingDeletion(domain);
      const readAfterWrite = vi.fn(async () => undefined);
      const handlers = oldHandlers('catalog', {
        safety: readOldCatalog(local, 'owner', domain),
        catalogSafetyStorage: () => local,
        ownerId: 'owner',
        config: { id: domain },
        readCatalogSafetyGate: readOldCatalog,
        writeCatalogSafetyGate: writeOldCatalog,
        setStorageUnavailable: vi.fn(),
        runtime: { queryClient: { setQueryData: vi.fn() } },
        safetyKey: ['catalog-safety', domain],
        readAfterWrite,
        runWithCatalogLock: async (action: () => Promise<void>) => action(),
        setNotice: vi.fn(),
        catalogAccessDenied: () => false,
        reportAccessDenied: vi.fn(),
      });
      await handlers.reconcileCreate();
      expect(readAfterWrite).toHaveBeenCalledOnce();
      expect(local.getItem(catalogSafetyKey('owner', domain))).toBeNull();
      expect(handlers.beginWrite({ type: 'create-group' })).toMatchObject({
        phase: 'refresh',
      });
      // The old catalog never consults this still-present deletion bridge.
      expect(readOldImport(local, domain, 'owner')).toMatchObject({
        phase: 'uncertain',
        taskId: null,
      });
    },
  );

  it.each(['asin', 'competitor'] as const)(
    'reproduces the old %s import unlock admitting another claim during deletion',
    async (domain) => {
      const { local } = await pendingDeletion(domain);
      const handlers = oldHandlers('import', {
        gate: readOldImport(local, domain, 'owner'),
        activeTask: false,
        terminalTask: false,
        matchingTask: undefined,
        task: { isError: false },
        access: { canReadASIN: true },
        storage: (kind?: string) => (kind === 'session' ? null : local),
        navigator: { locks: immediateLocks },
        domain,
        userId: 'owner',
        owner: { current: 'owner' },
        mounted: { current: true },
        latestTask: { current: undefined },
        isActiveTask: () => false,
        isTerminalTask: () => false,
        importGateKey,
        readImportGate: readOldImport,
        writeImportGate: writeOldImport,
        restoredGate: readOldImport,
        setNotice: vi.fn(),
        setGate: vi.fn(),
        setLastTaskId: vi.fn(),
        setFile: vi.fn(),
        fileInput: { current: null },
      });
      expect(handlers.canReconcile).toBe(true);
      await handlers.unlockAfterReconciliation();
      expect(local.getItem(importGateKey(domain, 'owner'))).toBeNull();
      expect(claimOldImport(local, domain, 'owner').kind).toBe('claimed');
      // The old import panel never consults the shared catalog envelope.
      expect(readOldCatalog(local, 'owner', domain)).toMatchObject({
        phase: 'inspection',
        operationId: 'deletion-1',
      });
    },
  );
});
