import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  withMonitorAdmission,
  type MonitorAdmissionOptions,
} from '../src/tasks/monitor-admission';

function fixture() {
  let lock: { token: string; expiresAt: number } | undefined;
  const redis = {
    set: vi.fn(
      async (_key: string, token: string, _px: string, leaseMs: number) => {
        if (lock && lock.expiresAt <= performance.now()) lock = undefined;
        if (lock) return null;
        lock = { token, expiresAt: performance.now() + leaseMs };
        return 'OK';
      },
    ),
    eval: vi.fn(
      async (
        script: string,
        _count: number,
        _key: string,
        token: string,
        leaseMs?: number,
      ) => {
        if (lock && lock.expiresAt <= performance.now()) lock = undefined;
        if (lock?.token !== token) return 0;
        if (script.includes('PEXPIRE')) {
          lock.expiresAt = performance.now() + leaseMs!;
          return 1;
        }
        lock = undefined;
        return 1;
      },
    ),
  };
  const options: MonitorAdmissionOptions = {
    redis: redis as unknown as MonitorAdmissionOptions['redis'],
    key: 'fixture:monitor:admission',
    ensureOpen: () => undefined,
    onReleaseFailure: vi.fn(),
    leaseMs: 120,
    renewIntervalMs: 25,
    waitMs: 60,
  };
  return {
    redis,
    options,
    get lock() {
      return lock;
    },
    steal: () => {
      lock = { token: 'other', expiresAt: performance.now() + 500 };
    },
  };
}

describe('monitor capacity admission lease', () => {
  it('renews across a long add and bounds another producer waiting for the lock', async () => {
    const f = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = withMonitorAdmission(f.options, async (assertOwned) => {
      await assertOwned();
      await held;
      await assertOwned();
    });
    try {
      await vi.waitFor(() => expect(f.lock).toBeDefined());
      await delay(200);
      const started = performance.now();
      await expect(
        withMonitorAdmission(f.options, async () => undefined),
      ).rejects.toThrow('MONITOR_ADMISSION_BUSY');
      expect(performance.now() - started).toBeLessThan(300);
      expect(
        f.redis.eval.mock.calls.some(([script]) => script.includes('PEXPIRE')),
      ).toBe(true);
    } finally {
      release();
      await first;
    }
    await expect(
      withMonitorAdmission(f.options, async (assertOwned) => {
        await assertOwned();
        return 'accepted';
      }),
    ).resolves.toBe('accepted');
    expect(f.options.onReleaseFailure).not.toHaveBeenCalled();
  });

  it('fails closed before adding when another owner steals the lease', async () => {
    const f = fixture();
    await expect(
      withMonitorAdmission(f.options, async (assertOwned) => {
        f.steal();
        await assertOwned();
      }),
    ).rejects.toThrow('MONITOR_ADMISSION_LOST');
  });
});
