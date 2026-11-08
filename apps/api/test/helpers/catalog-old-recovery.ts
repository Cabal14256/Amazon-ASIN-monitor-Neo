import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

/** Execute the frozen pre-deploy closures with their original parser/writer.
 * Only UI/cache/Storage/lock ports are supplied; readAfterWrite uses real HTTP.
 * The original frontend still clears its gate. The server must remain safe. */
export async function runOldCatalogRecovery(
  ownerId: string,
  domain: 'asin' | 'competitor',
  shared: unknown,
  readAfterWrite: () => Promise<void>,
) {
  const root = resolve(__dirname, '../../../..');
  const source = JSON.parse(
    readFileSync(
      resolve(__dirname, 'catalog-old-recovery-source.json'),
      'utf8',
    ),
  ) as { functions: Record<string, string> };
  const originalParser = readFileSync(
    resolve(
      root,
      'apps/web/src/pages/catalog/__fixtures__/catalog-safety-gate-main-197925d.ts',
    ),
    'utf8',
  );
  const module = {
    exports: {} as Record<string, (...args: unknown[]) => unknown>,
  };
  vm.runInNewContext(
    ts.transpileModule(originalParser, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    { module, exports: module.exports },
  );
  const values = new Map<string, string>();
  const key = module.exports.catalogSafetyKey!(ownerId, domain) as string;
  values.set(key, JSON.stringify(shared));
  // The receipt stays independent even when an old tab drops envelope fields.
  const receiptKey = `neo:catalog-check:${encodeURIComponent(
    domain,
  )}:${encodeURIComponent(ownerId)}`;
  const check = (shared as { check: unknown }).check;
  values.set(receiptKey, JSON.stringify(check));
  const storage = {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => values.set(name, value),
    removeItem: (name: string) => values.delete(name),
  };
  const parser = module.exports.readCatalogSafetyGate!;
  const text = ts.transpileModule(
    `(function(ports) {
      const { ownerId,config,runtime,catalogSafetyStorage,
        readCatalogSafetyGate,writeCatalogSafetyGate,catalogSafetyKey,
        setStorageUnavailable,ApiError,navigator,readAfterWrite,
        setNotice,catalogAccessDenied,reportAccessDenied,safetyKey }=ports;
      const safety=readCatalogSafetyGate(catalogSafetyStorage(),ownerId,config.id);
      ${Object.values(source.functions).join('\n')}
      return { reconcileCreate, beginWrite };
    })`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const noop = () => undefined;
  const old = vm.runInNewContext(text)({
    ownerId,
    config: { id: domain },
    runtime: { queryClient: { setQueryData: noop } },
    catalogSafetyStorage: () => storage,
    readCatalogSafetyGate: parser,
    writeCatalogSafetyGate: module.exports.writeCatalogSafetyGate,
    catalogSafetyKey: module.exports.catalogSafetyKey,
    safetyKey: ['catalog-write-safety', ownerId, domain],
    setStorageUnavailable: noop,
    ApiError: Error,
    navigator: {
      locks: {
        request: async (_key: string, work: () => Promise<unknown>) => work(),
      },
    },
    readAfterWrite,
    setNotice: noop,
    catalogAccessDenied: () => false,
    reportAccessDenied: () => {
      throw new Error('Unexpected old recovery authorization failure');
    },
  }) as {
    reconcileCreate(): Promise<void>;
    beginWrite(action: unknown): unknown;
  };
  await old.reconcileCreate();
  const afterRecovery = storage.getItem(key);
  old.beginWrite({ type: 'create-group' });
  return {
    afterRecovery,
    receipt: storage.getItem(receiptKey),
    admitted: parser(storage, ownerId, domain),
  };
}
