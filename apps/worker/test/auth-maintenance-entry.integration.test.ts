import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  eventually,
  maintenanceFixture,
} from './helpers/auth-maintenance-fixture';

interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
}
interface FixtureChild {
  ready(pattern: RegExp): Promise<void>;
  output(): string;
  finished(): Promise<ChildOutcome | undefined>;
  stop(): Promise<ChildOutcome | undefined>;
}

describe.skipIf(
  process.env.RUN_INTEGRATION_TESTS !== 'true' || process.platform === 'win32',
)('Compiled maintenance process entry on Linux CI', () => {
  let f: Awaited<ReturnType<typeof maintenanceFixture>>;
  const children: FixtureChild[] = [];
  beforeEach(async () => {
    f = await maintenanceFixture();
  });
  afterEach(async () => {
    for (const child of children.splice(0)) await child.stop();
    if (f) await f.close();
  });
  function startChild(
    file = 'main.js',
    args: string[] = [],
    overrides: NodeJS.ProcessEnv = {},
  ): FixtureChild {
    const child = spawn(
      process.execPath,
      [resolve(__dirname, '../dist', file), ...args],
      {
        cwd: resolve(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PROCESS_ROLE: 'worker',
          AUTH_DATA_AUTHORITY: 'postgresql',
          DATABASE_URL: f.env.DATABASE_URL,
          REDIS_URL: f.env.REDIS_URL,
          BULL_PREFIX: f.env.BULL_PREFIX,
          WORKER_ENABLED_QUEUES: 'maintenance',
          SCHEDULER_ENABLED: 'true',
          LOG_LEVEL: 'INFO',
          ...overrides,
        },
      },
    );
    let output = '';
    let exited = false;
    let outcome: ChildOutcome | undefined;
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-64000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', () => {
      output += '\nfixture child start error';
    });
    child.once('exit', (code, signal) => {
      exited = true;
      outcome = { code, signal };
    });
    const handle = {
      async ready(pattern: RegExp) {
        await eventually(async () => {
          if (exited)
            throw new Error(`Fixture entry exited before readiness: ${output}`);
          return pattern.test(output);
        }, 10_000);
      },
      output: () => output,
      async finished() {
        await eventually(async () => exited, 12_000);
        return outcome;
      },
      async stop() {
        if (!exited) child.kill('SIGTERM');
        try {
          await eventually(async () => exited, 12_000);
        } catch {
          child.kill('SIGKILL');
          await eventually(async () => exited, 2000);
          throw new Error('Fixture child required forced shutdown');
        }
        return outcome;
      },
    };
    children.push(handle);
    return handle;
  }

  it('the actual entry consumes both operations, shuts down, and the compiled CLI stops and resumes its queue', async () => {
    const child = startChild();
    await child.ready(/registeredProcessors:\s*1/);
    expect(child.output()).toContain("mode: 'auth-maintenance'");
    expect(child.output()).toContain('queueCount: 1');
    await f.session('actual-entry-session');
    await f.audit(69);
    const jobs = await f.queue.addBulk(
      ['session-cleanup', 'audit-archive'].map((name) => ({
        name,
        data: { schemaVersion: 1 },
      })),
    );
    const results = await Promise.all(
      jobs.map((job) => job.waitUntilFinished(f.events, 8000)),
    );
    expect(results.map((result) => result.processed)).toEqual([1, 1]);
    expect(
      (await f.pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n,
    ).toBe(0);
    expect(
      (await f.pool.query('SELECT count(*)::int AS n FROM audit_logs_archive'))
        .rows[0].n,
    ).toBe(1);
    expect(await child.stop()).toEqual({ code: 0, signal: null });
    expect(await f.redis.exists(f.leaseKey)).toBe(0);
    expect(await f.queue.getJobSchedulers()).toHaveLength(2);
    const stop = startChild('auth-maintenance-control.js', ['stop']);
    expect(await stop.finished()).toEqual({ code: 0, signal: null });
    expect(await f.queue.isPaused()).toBe(true);
    expect(await f.queue.getJobSchedulers()).toHaveLength(0);
    const resume = startChild('auth-maintenance-control.js', ['resume']);
    expect(await resume.finished()).toEqual({ code: 0, signal: null });
    expect(await f.queue.isPaused()).toBe(false);
    const restarted = startChild();
    await restarted.ready(/registeredProcessors:\s*1/);
    expect(await f.queue.getJobSchedulers()).toHaveLength(2);
    expect(await restarted.stop()).toEqual({ code: 0, signal: null });
    expect(await f.redis.lrange(f.legacyKey, 0, -1)).toEqual([
      'legacy-fixture',
    ]);
  }, 40_000);

  it.each(['none', 'legacy-maintenance'])(
    'the actual %s selection remains idle even with unavailable dependencies',
    async (selection) => {
      const child = startChild('main.js', [], {
        WORKER_ENABLED_QUEUES: selection === 'none' ? 'none' : 'maintenance',
        AUTH_DATA_AUTHORITY:
          selection === 'none' ? 'postgresql' : 'legacy-mysql',
        REDIS_URL: 'redis://127.0.0.1:1/15',
        DATABASE_URL: 'postgresql://fixture@127.0.0.1:1/fixture',
      });
      await child.ready(/跳过 Redis 连接与看门狗/);
      expect(await child.stop()).toEqual({ code: 0, signal: null });
      expect(await f.queue.getJobSchedulers()).toHaveLength(0);
    },
    15_000,
  );

  it('exits with a fixed error when database initialization fails and leaks no supplied credentials', async () => {
    const child = startChild('main.js', [], {
      DATABASE_URL:
        'postgresql://fixture:fixture-startup-secret@127.0.0.1:1/fixture',
    });
    expect(await child.finished()).toEqual({ code: 1, signal: null });
    expect(child.output()).toContain(
      'Authentication maintenance initialization failed',
    );
    expect(child.output()).not.toContain('fixture-startup-secret');
    expect(await f.redis.exists(f.leaseKey)).toBe(0);
    expect(await f.queue.getJobSchedulers()).toHaveLength(0);
  }, 15_000);
});
