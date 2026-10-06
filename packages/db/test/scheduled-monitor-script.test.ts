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

// The deployment wrapper is POSIX. Actual fixture invocation runs on Linux CI.
const suite = process.platform === 'win32' ? describe.skip : describe;
const script = resolve(__dirname, '../docker/apply-scheduled-monitor.sh');
const invalidDatabases: Record<string, string>[] = [
  { POSTGRES_DB: 'same', COMPETITOR_DATABASE: 'same' },
  { POSTGRES_DB: 'primary bad' },
  { COMPETITOR_DATABASE: 'competitor;bad' },
];
const fixture = (
  test: (
    invoke: (
      domain: string,
      env?: Record<string, string>,
      migration?: string,
    ) => string[],
  ) => void,
) => {
  const parent = realpathSync(tmpdir());
  const folder = mkdtempSync(join(parent, 'neo-scheduled-script-'));
  const args = join(folder, 'args');
  const migration = join(folder, 'fixture.sql');
  const psql = join(folder, 'psql');
  writeFileSync(migration, '-- isolated fixture SQL');
  writeFileSync(
    psql,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$NEO_SCHEDULED_ARGS"\n',
  );
  chmodSync(psql, 0o700);
  const invoke = (
    domain: string,
    env: Record<string, string> = {},
    file = migration,
  ) => {
    if (existsSync(args)) rmSync(args);
    execFileSync('sh', [script, domain, file], {
      env: {
        PATH: `${folder}${process.platform === 'win32' ? ';' : ':'}${
          process.env.PATH ?? ''
        }`,
        POSTGRES_USER: 'fixture_only',
        POSTGRES_DB: 'primary_fixture',
        COMPETITOR_DATABASE: 'competitor_fixture',
        NEO_SCHEDULED_ARGS: args,
        ...env,
      },
      stdio: 'pipe',
    });
    return readFileSync(args, 'utf8').trimEnd().split('\n');
  };
  try {
    test(invoke);
  } finally {
    const target = realpathSync(folder);
    if (!target.startsWith(`${parent}${sep}neo-scheduled-script-`))
      throw new Error('Scheduled script cleanup escaped fixture folder');
    rmSync(target, { recursive: true });
  }
};
suite('scheduled upgrade wrapper admission', () => {
  it.each([
    { domain: 'primary', database: 'primary_fixture' },
    { domain: 'competitor', database: 'competitor_fixture' },
  ])(
    'dispatches only $domain to its logical database without contacting PostgreSQL',
    ({ domain, database }) =>
      fixture((invoke) => {
        const args = invoke(domain);
        expect(args.slice(0, 7)).toEqual([
          '-X',
          '-v',
          'ON_ERROR_STOP=1',
          '--username',
          'fixture_only',
          '--dbname',
          database,
        ]);
        expect(args[7]).toBe('--file');
      }),
  );
  it.each([{ domain: '' }, { domain: 'manual' }, { domain: 'primary;other' }])(
    'rejects unknown or injected domain before psql %#',
    ({ domain }) =>
      fixture((invoke) => {
        expect(() => invoke(domain)).toThrow();
      }),
  );
  it.each(invalidDatabases)(
    'rejects aliased or malformed logical databases before psql %#',
    (env) =>
      fixture((invoke) => {
        expect(() => invoke('primary', env)).toThrow();
      }),
  );
  it('rejects an unreadable migration before psql', () =>
    fixture((invoke) => {
      expect(() =>
        invoke('primary', {}, '/neo-missing-scheduled-fixture.sql'),
      ).toThrow();
    }));
});
