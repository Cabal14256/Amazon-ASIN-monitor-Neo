import type { SpApiConfigurationRow } from '@asin-monitor/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonitorGroupAdmission } from '../src/monitor-group-admission';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const row = (value: string): SpApiConfigurationRow => ({
  id: 1,
  configKey: 'MONITOR_MAX_CONCURRENT_GROUP_CHECKS',
  configValue: value,
  description: null,
  createTime: null,
  updateTime: null,
});
const gates: MonitorGroupAdmission[] = [];
function fixture(value = '1', autoAdjust = false, maximum = 10) {
  const read = vi.fn(async (_signal: AbortSignal) => [row(value)]);
  const risk = {
    setCurrentConcurrency: vi.fn(),
    calculateOptimalConcurrency: vi.fn((current: number) => current),
  };
  const gate = new MonitorGroupAdmission(
    {
      MONITOR_MAX_CONCURRENT_GROUP_CHECKS: 3,
      MAX_ALLOWED_CONCURRENT_GROUP_CHECKS: maximum,
      AUTO_ADJUST_CONCURRENCY: autoAdjust,
    },
    read,
    risk,
  );
  gates.push(gate);
  return { gate, read, risk };
}
afterEach(() => {
  for (const gate of gates.splice(0)) gate.close();
  vi.useRealTimers();
});

describe('shared monitor group admission', () => {
  it('shares one FIFO limit across primary and competitor callers and releases only once', async () => {
    const f = fixture();
    await f.gate.start();
    const order: string[] = [];
    const primary = await f.gate.acquire(
      new AbortController().signal,
      async () => {},
    );
    const competitor = f.gate
      .acquire(new AbortController().signal, async () => {})
      .then((release) => {
        order.push('competitor');
        return release;
      });
    const secondPrimary = f.gate
      .acquire(new AbortController().signal, async () => {})
      .then((release) => {
        order.push('primary');
        return release;
      });
    await flush();
    expect(f.gate.getDiagnostics()).toMatchObject({
      active: 1,
      waiting: 2,
      limit: 1,
    });
    expect(order).toEqual([]);
    primary();
    primary();
    const competitorRelease = await competitor;
    expect(order).toEqual(['competitor']);
    competitorRelease();
    (await secondPrimary)();
    expect(order).toEqual(['competitor', 'primary']);
    expect(f.gate.getDiagnostics()).toMatchObject({ active: 0, waiting: 0 });
  });
  it('shrinks hot configuration without preempting active groups and grows to wake FIFO waiters', async () => {
    vi.useFakeTimers();
    const f = fixture('2');
    await f.gate.start();
    const first = await f.gate.acquire(
      new AbortController().signal,
      async () => {},
    );
    const second = await f.gate.acquire(
      new AbortController().signal,
      async () => {},
    );
    f.read.mockResolvedValue([row('1')]);
    await vi.advanceTimersByTimeAsync(5000);
    const third = f.gate.acquire(new AbortController().signal, async () => {});
    void third.catch(() => {});
    await flush();
    expect(f.gate.getDiagnostics()).toMatchObject({
      active: 2,
      waiting: 1,
      limit: 1,
    });
    first();
    await flush();
    expect(f.gate.getDiagnostics()).toMatchObject({ active: 1, waiting: 1 });
    f.read.mockResolvedValue([row('2')]);
    await vi.advanceTimersByTimeAsync(5000);
    const thirdRelease = await third;
    expect(f.gate.getDiagnostics()).toMatchObject({
      active: 2,
      waiting: 0,
      limit: 2,
    });
    second();
    thirdRelease();
  });
  it('removes cancelled or expired waiting identities without starting their group', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.gate.start();
    const occupied = await f.gate.acquire(
      new AbortController().signal,
      async () => {},
    );
    const stop = new AbortController();
    const cancelled = f.gate.acquire(stop.signal, async () => {});
    const cancelledResult = expect(cancelled).rejects.toThrow('cancel fixture');
    stop.abort(new Error('cancel fixture'));
    await cancelledResult;
    let live = true;
    const checkpoint = vi.fn(async () => {
      if (!live) throw new Error('identity fixture');
    });
    const expired = f.gate.acquire(new AbortController().signal, checkpoint);
    const expiredResult = expect(expired).rejects.toThrow('identity fixture');
    await flush();
    live = false;
    await vi.advanceTimersByTimeAsync(1000);
    await expiredResult;
    expect(f.gate.getDiagnostics()).toMatchObject({ active: 1, waiting: 0 });
    occupied();
  });
  it('closes queued admissions and ignores late checkpoints while active work retains its slot', async () => {
    const f = fixture();
    await f.gate.start();
    const occupied = await f.gate.acquire(
      new AbortController().signal,
      async () => {},
    );
    const checkpoint = deferred<void>();
    const waiting = f.gate.acquire(
      new AbortController().signal,
      () => checkpoint.promise,
    );
    const failure = expect(waiting).rejects.toThrow('CLOSED');
    await flush();
    f.gate.close();
    await failure;
    checkpoint.resolve();
    await flush();
    expect(f.gate.getDiagnostics()).toMatchObject({
      active: 1,
      waiting: 0,
      closed: true,
    });
    occupied();
    await expect(
      f.gate.acquire(new AbortController().signal, async () => {}),
    ).rejects.toThrow('CLOSED');
  });
  it('bounds waiting identities and removes them at the waiting deadline', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.gate.start();
    const occupied = await f.gate.acquire(
      new AbortController().signal,
      async () => {},
    );
    const waits = Array.from({ length: 100 }, () => {
      const waiting = f.gate.acquire(
        new AbortController().signal,
        async () => {},
      );
      return expect(waiting).rejects.toThrow('TIMEOUT');
    });
    await expect(
      f.gate.acquire(new AbortController().signal, async () => {}),
    ).rejects.toThrow('CAPACITY');
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all(waits);
    expect(f.gate.getDiagnostics()).toMatchObject({ active: 1, waiting: 0 });
    occupied();
  });
  it('retains a timed-out configuration read slot, ignores its late value, and retries with backoff', async () => {
    vi.useFakeTimers();
    const f = fixture('4');
    const pending = deferred<SpApiConfigurationRow[]>();
    f.read.mockImplementationOnce(async () => pending.promise);
    const started = f.gate.start();
    await vi.advanceTimersByTimeAsync(2000);
    await started;
    expect(f.gate.getDiagnostics()).toMatchObject({
      limit: 1,
      pendingConfiguration: true,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.read).toHaveBeenCalledTimes(1);
    pending.resolve([row('8')]);
    await flush();
    expect(f.gate.getDiagnostics()).toMatchObject({
      limit: 1,
      pendingConfiguration: false,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.gate.getDiagnostics().limit).toBe(4);
  });
  it('uses one group for invalid or failed configuration and resets only after a valid read', async () => {
    vi.useFakeTimers();
    const f = fixture('invalid');
    await f.gate.start();
    expect(f.gate.getDiagnostics().limit).toBe(1);
    f.read.mockRejectedValueOnce(new Error('fixture unreachable'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.read).toHaveBeenCalledTimes(2);
    f.read.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.gate.getDiagnostics().limit).toBe(3);
  });
  it('keeps risk adjustment across identical reloads and clamps risk to deployment and pipeline limits', async () => {
    vi.useFakeTimers();
    const f = fixture('3', true, 4);
    await f.gate.start();
    f.risk.calculateOptimalConcurrency.mockReturnValueOnce(2);
    (await f.gate.acquire(new AbortController().signal, async () => {}))();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.risk.setCurrentConcurrency).toHaveBeenCalledTimes(1);
    expect(f.gate.getDiagnostics().limit).toBe(2);
    f.risk.calculateOptimalConcurrency.mockReturnValueOnce(1000);
    (await f.gate.acquire(new AbortController().signal, async () => {}))();
    expect(f.gate.getDiagnostics().limit).toBe(4);
    const capacity = fixture('1000', false);
    await capacity.gate.start();
    expect(capacity.gate.getDiagnostics().limit).toBe(8);
  });
});
