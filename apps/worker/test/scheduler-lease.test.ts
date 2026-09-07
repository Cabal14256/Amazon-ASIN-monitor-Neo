import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SchedulerLease,
  type SchedulerLeaseRedis,
} from '../src/scheduler-lease';

describe('Scheduler lease lifecycle', () => {
  const leases: SchedulerLease[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    await Promise.all(leases.splice(0).map((lease) => lease.stop()));
    vi.useRealTimers();
  });
  function fixture() {
    const redis: SchedulerLeaseRedis = {
      set: vi.fn(async () => 'OK'),
      eval: vi.fn(async () => 1),
    };
    const install = vi.fn(async () => undefined);
    const log = { warn: vi.fn() };
    const lease = new SchedulerLease(
      redis,
      'fixture:neo:scheduler:leader',
      install,
      log,
    );
    leases.push(lease);
    return { redis, install, log, lease };
  }
  it('acquires once, renews with the owner token and does not reinstall unchanged plans', async () => {
    const f = fixture();
    await f.lease.start();
    await f.lease.start();
    const token = vi.mocked(f.redis.set).mock.calls[0][1];
    expect(f.redis.set).toHaveBeenCalledWith(
      'fixture:neo:scheduler:leader',
      token,
      'PX',
      15000,
      'NX',
    );
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.install).toHaveBeenCalledOnce();
    expect(f.redis.set).toHaveBeenCalledOnce();
    expect(f.redis.eval).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(f.redis.eval).mock.calls)
      expect(call.slice(1)).toEqual([
        1,
        'fixture:neo:scheduler:leader',
        token,
        15000,
      ]);
  });
  it('a follower stays quiet until a later acquisition succeeds', async () => {
    const f = fixture();
    vi.mocked(f.redis.set).mockResolvedValueOnce(null);
    await f.lease.start();
    expect(f.install).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.install).toHaveBeenCalledOnce();
  });
  it('lost ownership prevents renewal-based work and requires a fresh claim', async () => {
    const f = fixture();
    await f.lease.start();
    vi.mocked(f.redis.eval).mockResolvedValueOnce(0);
    vi.mocked(f.redis.set).mockResolvedValueOnce(null);
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.install).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.install).toHaveBeenCalledTimes(2);
  });
  it('does not overlap pending Redis commands and stops before installing late work', async () => {
    const f = fixture();
    let release!: (value: string) => void;
    vi.mocked(f.redis.set).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const starting = f.lease.start();
    await vi.advanceTimersByTimeAsync(20000);
    expect(f.redis.set).toHaveBeenCalledOnce();
    const stopping = f.lease.stop();
    release('OK');
    await starting;
    await stopping;
    expect(f.install).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('sanitizes failures and retries installation after a fresh successful claim', async () => {
    const f = fixture();
    f.install.mockRejectedValueOnce(new Error('token=fixture-must-not-log'));
    await f.lease.start();
    expect(JSON.stringify(f.log.warn.mock.calls)).not.toContain(
      'fixture-must-not-log',
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.install).toHaveBeenCalledTimes(2);
  });
  it('releases only by owner token, stops polling and can restart', async () => {
    const f = fixture();
    await f.lease.start();
    const token = vi.mocked(f.redis.set).mock.calls[0][1];
    await f.lease.stop();
    expect(vi.mocked(f.redis.eval).mock.calls.at(-1)?.slice(1)).toEqual([
      1,
      'fixture:neo:scheduler:leader',
      token,
    ]);
    await vi.advanceTimersByTimeAsync(20000);
    expect(f.redis.set).toHaveBeenCalledOnce();
    await f.lease.start();
    expect(f.install).toHaveBeenCalledTimes(2);
  });
});
