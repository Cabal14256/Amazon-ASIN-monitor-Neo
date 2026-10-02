import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitorConsumerHeartbeat } from '../src/monitor-consumer-heartbeat';

describe('monitor consumer heartbeat lifecycle', () => {
  const heartbeats: MonitorConsumerHeartbeat[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    await Promise.all(
      heartbeats.splice(0).map((heartbeat) => heartbeat.stop()),
    );
    vi.useRealTimers();
  });
  function fixture() {
    const redis = {
      eval: vi.fn(
        async (
          _script: string,
          _keys: number,
          ..._args: (string | number)[]
        ): Promise<unknown> => 1,
      ),
    };
    const log = { warn: vi.fn() };
    const heartbeat = new MonitorConsumerHeartbeat(redis, 'fixture:ready', log);
    heartbeats.push(heartbeat);
    return { redis, log, heartbeat };
  }
  it('uses a distinct owner per consumer and releases immediately without further renewal', async () => {
    const a = fixture(),
      b = fixture();
    await Promise.all([a.heartbeat.start(), b.heartbeat.start()]);
    const aOwner = a.redis.eval.mock.calls[0][4];
    const bOwner = b.redis.eval.mock.calls[0][4];
    expect(aOwner).not.toBe(bOwner);
    await vi.advanceTimersByTimeAsync(3000);
    expect(a.redis.eval.mock.calls[1].slice(1)).toEqual([
      2,
      'fixture:ready',
      'fixture:ready:owners',
      aOwner,
      'refresh',
      10000,
    ]);
    await a.heartbeat.stop();
    expect(a.redis.eval.mock.calls[2].slice(1)).toEqual([
      2,
      'fixture:ready',
      'fixture:ready:owners',
      aOwner,
      'release',
      10000,
    ]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(a.redis.eval).toHaveBeenCalledTimes(3);
    expect(b.redis.eval).toHaveBeenCalledTimes(4);
  });
  it('waits for an in-flight publication before releasing without a late ready publication', async () => {
    const f = fixture();
    let release!: () => void;
    f.redis.eval.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(1);
        }),
    );
    const started = f.heartbeat.start();
    const stopped = f.heartbeat.stop();
    await vi.advanceTimersByTimeAsync(9000);
    expect(f.redis.eval).toHaveBeenCalledOnce();
    release();
    await Promise.all([started, stopped]);
    expect(f.redis.eval.mock.calls.map((call) => call[5])).toEqual([
      'refresh',
      'release',
    ]);
    expect(vi.getTimerCount()).toBe(0);
    await f.heartbeat.stop();
    expect(f.redis.eval).toHaveBeenCalledTimes(2);
  });
  it('does not accumulate commands while a refresh is pending', async () => {
    const f = fixture();
    await f.heartbeat.start();
    let release!: () => void;
    f.redis.eval.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(1);
        }),
    );
    await vi.advanceTimersByTimeAsync(9000);
    expect(f.redis.eval).toHaveBeenCalledTimes(2);
    const stopped = f.heartbeat.stop();
    release();
    await stopped;
    expect(f.redis.eval.mock.calls.map((call) => call[5])).toEqual([
      'refresh',
      'refresh',
      'release',
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('logs only a fixed reason when release cannot be confirmed', async () => {
    const f = fixture();
    await f.heartbeat.start();
    f.redis.eval.mockRejectedValueOnce(
      new Error('private-redis-driver-details'),
    );
    await f.heartbeat.stop();
    expect(f.log.warn).toHaveBeenCalledWith(
      '监控消费者心跳释放未确认，等待租约到期',
      { reason: 'monitor_heartbeat_release_failed' },
    );
    expect(JSON.stringify(f.log.warn.mock.calls)).not.toContain(
      'private-redis',
    );
  });
});
