const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const filename = path.join(__dirname, '../src/utils/unknown-task-lookup.ts');
const source = fs.readFileSync(filename, 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: filename,
}).outputText;
const loaded = { exports: {} };
new Function('module', 'exports', output)(loaded, loaded.exports);
const { retryUnknownTaskLookup, UnknownTaskLookupTimeoutError } =
  loaded.exports;

test('uncertain submit retries an initial 404 and retains the same task lookup', async () => {
  const taskId = '10000000-0000-4000-8000-000000000166';
  let calls = 0;
  const result = await retryUnknownTaskLookup(
    async () => {
      calls++;
      if (calls < 3) throw { response: { status: 404 } };
      return { taskId, status: 'pending' };
    },
    1000,
    1,
  );
  assert.deepEqual(result, { taskId, status: 'pending' });
  assert.equal(calls, 3);
});

test('permission refusal is not retried as a delayed task', async () => {
  let calls = 0;
  await assert.rejects(
    retryUnknownTaskLookup(
      async () => {
        calls++;
        throw { response: { status: 403 } };
      },
      1000,
      1,
    ),
    { response: { status: 403 } },
  );
  assert.equal(calls, 1);
});

test('unconfirmed status exhausts a bounded grace period', async () => {
  let calls = 0;
  await assert.rejects(
    retryUnknownTaskLookup(
      async () => {
        calls++;
        throw { response: { status: 404 } };
      },
      10,
      2,
    ),
    UnknownTaskLookupTimeoutError,
  );
  assert.ok(calls >= 2);
});
