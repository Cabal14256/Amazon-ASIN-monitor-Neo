import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const suite = process.platform === 'win32' ? describe.skip : describe;
const script = resolve(__dirname, '../docker/apply-catalog-operation-fence.sh');
const invalidDatabases: Record<string, string>[] = [
  { POSTGRES_DB: 'bad;db' },
  { COMPETITOR_DATABASE: 'bad db' },
  { POSTGRES_DB: 'same', COMPETITOR_DATABASE: 'same' },
];
function fixture(
  action: (
    invoke: (env?: Record<string, string>, migration?: string) => string[],
  ) => void,
) {
  const parent = realpathSync(tmpdir()),
    folder = mkdtempSync(join(parent, 'neo-catalog-script-'));
  const args = join(folder, 'args'),
    file = join(folder, 'fixture.sql'),
    psql = join(folder, 'psql');
  writeFileSync(file, '-- synthetic SQL only');
  writeFileSync(
    psql,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$NEO_CATALOG_ARGS"\nexit "${NEO_CATALOG_EXIT:-0}"\n',
  );
  chmodSync(psql, 0o700);
  const invoke = (env: Record<string, string> = {}, migration = file) => {
    if (existsSync(args)) rmSync(args);
    execFileSync('sh', [script, migration], {
      env: {
        PATH: `${folder}:${process.env.PATH ?? ''}`,
        POSTGRES_USER: 'fixture',
        POSTGRES_DB: 'primary_fixture',
        COMPETITOR_DATABASE: 'competitor_fixture',
        NEO_CATALOG_ARGS: args,
        ...env,
      },
      stdio: 'pipe',
    });
    return readFileSync(args, 'utf8').trimEnd().split('\n');
  };
  try {
    action(invoke);
  } finally {
    const target = realpathSync(folder);
    if (!target.startsWith(`${parent}${sep}neo-catalog-script-`))
      throw new Error('Cleanup escaped isolated fixture');
    rmSync(target, { recursive: true });
  }
}
suite('catalog fence POSIX wrapper admission (no database connection)', () => {
  it.each(['', '.rollback'])(
    'dispatches real upgrade/rollback %j only to primary with ON_ERROR_STOP',
    (suffix) =>
      fixture((invoke) => {
        const file = resolve(
          __dirname,
          `../migrations/0017_catalog_operation_fence${suffix}.sql`,
        );
        expect(invoke({}, file)).toEqual([
          '-X',
          '-v',
          'ON_ERROR_STOP=1',
          '--username',
          'fixture',
          '--dbname',
          'primary_fixture',
          '--file',
          file,
        ]);
      }),
  );
  it.each(invalidDatabases)(
    'rejects aliased/injected database %j before psql',
    (env) => fixture((invoke) => expect(() => invoke(env)).toThrow()),
  );
  it('propagates failed SQL instead of reporting migration success', () =>
    fixture((invoke) => {
      try {
        invoke({ NEO_CATALOG_EXIT: '23' });
        throw new Error('SQL failure did not propagate');
      } catch (error) {
        expect(error).toMatchObject({ status: 23 });
      }
    }));
  it('refuses an unreadable migration', () =>
    fixture((invoke) =>
      expect(() => invoke({}, '/neo-catalog-fixture-missing.sql')).toThrow(),
    ));
});
