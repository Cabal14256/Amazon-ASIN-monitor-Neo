import { randomUUID } from 'node:crypto';
import { logger } from './logger';

interface HeartbeatRedis {
  eval(
    script: string,
    keyCount: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
}

// Redis time keeps consumers on different hosts on the same lease clock. The
// compatibility ready key expires with the newest live consumer, not the one
// that most recently stopped. Both keys disappear when the last lease ends.
const UPDATE = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if ARGV[2] == 'refresh' then
  redis.call('ZADD', KEYS[2], now + tonumber(ARGV[3]), ARGV[1])
else
  redis.call('ZREM', KEYS[2], ARGV[1])
end
local latest = redis.call('ZREVRANGE', KEYS[2], 0, 0, 'WITHSCORES')
if #latest == 0 then
  redis.call('DEL', KEYS[1], KEYS[2])
  return 0
end
local remaining = math.floor(tonumber(latest[2]) - now)
redis.call('PEXPIRE', KEYS[2], remaining)
redis.call('SET', KEYS[1], '1', 'PX', remaining)
return 1
`;

/** Uses the host's fail-fast control client; no owned Redis connection. */
export class MonitorConsumerHeartbeat {
  private readonly owner = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private stopped = true;
  private attempted = false;
  private closing?: Promise<void>;

  constructor(
    private readonly redis: HeartbeatRedis,
    private readonly readyKey: string,
    private readonly log: Pick<typeof logger, 'warn'> = logger,
  ) {}

  async start(): Promise<void> {
    if (!this.stopped) return this.pending;
    if (this.closing) throw new Error('Monitor heartbeat stopped');
    this.stopped = false;
    this.attempted = true;
    await this.refresh();
    if (this.stopped) return;
    this.timer = setInterval(() => {
      void this.refresh().catch(() =>
        this.log.warn('监控消费者心跳未确认', {
          reason: 'monitor_heartbeat_failed',
        }),
      );
    }, 3000);
    this.timer.unref();
  }

  private refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.update('refresh').finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async update(action: 'refresh' | 'release'): Promise<void> {
    await this.redis.eval(
      UPDATE,
      2,
      this.readyKey,
      `${this.readyKey}:owners`,
      this.owner,
      action,
      10_000,
    );
  }

  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.closing ??= (async () => {
      // A heartbeat already in flight must finish before release, otherwise a
      // late acknowledgement could advertise the stopped consumer again.
      await this.pending?.catch(() => undefined);
      if (!this.attempted) return;
      try {
        await this.update('release');
      } catch {
        this.log.warn('监控消费者心跳释放未确认，等待租约到期', {
          reason: 'monitor_heartbeat_release_failed',
        });
      }
    })();
    return this.closing;
  }
}
