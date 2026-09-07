import { randomUUID } from 'node:crypto';
import { logger } from './logger';

export interface SchedulerLeaseRedis {
  set(
    key: string,
    value: string,
    expiry: 'PX',
    ttl: number,
    condition: 'NX',
  ): Promise<string | null>;
  eval(
    script: string,
    keyCount: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
}

const RENEW = `if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) end return 0`;
const RELEASE = `if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0`;
const LEASE_MS = 15_000;
const REFRESH_MS = 5_000;

/** The control Redis client must use finite command timeouts and no offline queue. */
export class SchedulerLease {
  private readonly token = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private stopped = true;
  private ownsLease = false;
  private installed = false;
  constructor(
    private readonly redis: SchedulerLeaseRedis,
    private readonly key: string,
    private readonly installSchedules: () => Promise<void>,
    private readonly log: Pick<typeof logger, 'warn'> = logger,
  ) {}

  start(): Promise<void> {
    if (!this.stopped) return this.pending ?? Promise.resolve();
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.refresh();
    }, REFRESH_MS);
    return this.refresh();
  }
  private refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.poll().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async poll() {
    try {
      if (this.ownsLease) {
        this.ownsLease =
          (await this.redis.eval(RENEW, 1, this.key, this.token, LEASE_MS)) ===
          1;
      } else {
        this.ownsLease =
          (await this.redis.set(this.key, this.token, 'PX', LEASE_MS, 'NX')) ===
          'OK';
      }
      if (!this.ownsLease) {
        this.installed = false;
        return;
      }
      if (this.stopped) return;
      if (!this.installed) {
        // Stable BullMQ scheduler IDs make installation idempotent, including
        // an in-flight command that settles after this lease has expired.
        await this.installSchedules();
        this.installed = true;
      }
    } catch {
      this.ownsLease = false;
      this.installed = false;
      this.log.warn('调度器租约或计划同步失败，将重试', {
        reason: 'scheduler_lease_refresh_failed',
      });
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
    try {
      await this.redis.eval(RELEASE, 1, this.key, this.token);
    } catch {
      this.log.warn('调度器租约释放失败，等待租约到期', {
        reason: 'scheduler_lease_release_failed',
      });
    }
    this.ownsLease = false;
    this.installed = false;
  }
}
