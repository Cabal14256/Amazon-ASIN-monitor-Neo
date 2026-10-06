import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const pagePath = fileURLToPath(
  new URL('../../../../../src/pages/Settings/index.tsx', import.meta.url),
);
const helperPath = fileURLToPath(
  new URL(
    '../../../../../src/pages/Settings/scheduled-backup-history.ts',
    import.meta.url,
  ),
);

// Execute the actual page actions with state/service ports. Importing all Umi
// and ProForm would add unrelated app setup to this compatibility regression.
function pageActions(read: () => Promise<unknown>) {
  const source = readFileSync(pagePath, 'utf8');
  const tree = ts.createSourceFile(
    pagePath,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ['loadBackups', 'loadScheduledBackups'].includes(node.name.text)
    )
      declarations.set(node.name.text, `const ${node.getText(tree)};`);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  let helper: Record<string, unknown> = {};
  if (existsSync(helperPath)) {
    const output = ts.transpileModule(readFileSync(helperPath, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
      },
    }).outputText;
    const exports = {};
    new Function('exports', output)(exports);
    helper = exports;
  }
  const backups = vi.fn(),
    rows = vi.fn(),
    error = vi.fn(),
    unsupported = vi.fn();
  const list = vi.fn(async () => ({ success: true, data: [] }));
  const scheduled = vi.fn(read),
    toast = vi.fn();
  const ports = {
    backupServices: { listBackups: list, listScheduledBackups: scheduled },
    setBackups: backups,
    setScheduledBackups: rows,
    setBackupLoading: vi.fn(),
    message: { error: toast },
    console: { error: vi.fn() },
    setScheduledHistoryError: error,
    setScheduledHistoryUnsupported: unsupported,
    setScheduledHistoryLoading: vi.fn(),
    scheduledHistoryRequest: { current: false },
    ...helper,
  };
  const output = ts.transpileModule(
    [...declarations.values()].join('\n') +
      '\nreturn { loadBackups, retry: typeof loadScheduledBackups === "function" ? loadScheduledBackups : undefined };',
    { compilerOptions: { target: ts.ScriptTarget.ES2020 } },
  ).outputText;
  const actions = new Function(...Object.keys(ports), output)(
    ...Object.values(ports),
  ) as {
    loadBackups(): Promise<void>;
    retry?(): Promise<void>;
  };
  return { ...actions, rows, error, unsupported, list, scheduled, toast };
}
function httpError(
  status: number,
  errorMessage = 'history unavailable',
  code = status,
) {
  return {
    response: { status, data: { errorCode: code, errorMessage } },
    data: { errorCode: code, errorMessage },
  };
}

describe('Legacy Settings scheduled history compatibility with actual page actions', () => {
  it('uses the fallback only for the actual Legacy missing-route response', async () => {
    const f = pageActions(async () => {
      throw httpError(404, '接口不存在');
    });
    await f.loadBackups();
    expect(f.unsupported).toHaveBeenLastCalledWith(true);
    expect(f.error).toHaveBeenLastCalledWith(null);
    expect(f.rows).toHaveBeenLastCalledWith([]);
    expect(f.toast).not.toHaveBeenCalled();
  });
  it('recognizes the parsed Legacy missing-route envelope after Umi loses the HTTP response wrapper', async () => {
    const data = { success: false, errorCode: 404, errorMessage: '接口不存在' };
    const f = pageActions(async () => {
      throw Object.assign(new Error('接口不存在'), { data, response: data });
    });
    await f.loadBackups();
    expect(f.unsupported).toHaveBeenLastCalledWith(true);
    expect(f.error).toHaveBeenLastCalledWith(null);
  });
  it.each([401, 403, 429, 500])(
    'surfaces HTTP %s rather than an empty successful history',
    async (status) => {
      const f = pageActions(async () => {
        throw httpError(status);
      });
      await f.loadBackups();
      expect(
        f.error.mock.calls.some(
          ([value]) => typeof value === 'string' && value.length > 0,
        ),
      ).toBe(true);
      expect(f.unsupported).not.toHaveBeenCalledWith(true);
    },
  );
  it.each([
    httpError(404, '任务记录不存在'),
    httpError(500, '接口不存在', 404),
    new TypeError('network failed'),
  ])('keeps non-route or conflicting failures visible: %j', async (failure) => {
    const f = pageActions(async () => {
      throw failure;
    });
    await f.loadBackups();
    expect(
      f.error.mock.calls.some(
        ([value]) => typeof value === 'string' && value.length > 0,
      ),
    ).toBe(true);
    expect(f.unsupported).not.toHaveBeenCalledWith(true);
  });
  it('distinguishes a successful empty history and retries only the scheduled GET', async () => {
    let fail = true;
    const f = pageActions(async () => {
      if (fail) throw httpError(500);
      return { success: true, data: [] };
    });
    await f.loadBackups();
    expect(f.retry).toBeTypeOf('function');
    fail = false;
    await f.retry!();
    expect(f.rows).toHaveBeenLastCalledWith([]);
    expect(f.error).toHaveBeenLastCalledWith(null);
    expect(f.unsupported).toHaveBeenLastCalledWith(false);
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.scheduled).toHaveBeenCalledTimes(2);
  });
  it.each([
    { success: false, errorCode: 500, errorMessage: 'reconciliation failed' },
    { success: true, data: undefined },
    { success: true, data: {} },
  ])(
    'keeps a failed or malformed success envelope visible: %j',
    async (response) => {
      const f = pageActions(async () => response);
      await f.loadBackups();
      expect(
        f.error.mock.calls.some(
          ([value]) => typeof value === 'string' && value.length > 0,
        ),
      ).toBe(true);
      expect(f.unsupported).not.toHaveBeenCalledWith(true);
    },
  );
});
