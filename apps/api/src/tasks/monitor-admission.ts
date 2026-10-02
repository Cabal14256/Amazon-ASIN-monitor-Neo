import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const RENEW_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0`;
const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

export interface MonitorAdmissionOptions {
  redis: Pick<Redis, 'set' | 'eval'>;
  key: string;
  ensureOpen(): void;
  onReleaseFailure(): void;
  waitMs?: number;
  leaseMs?: number;
  renewIntervalMs?: number;
}

/** All API replicas serialize the capacity read and BullMQ add under one
 * renewable Redis lease. The caller rechecks ownership immediately before
 * adding a job. A lost lease after an uncertain add is never a definite
 * rejection: the producer must return the task ID for reconciliation. */
export async function withMonitorAdmission<T>(
  options: MonitorAdmissionOptions,
  action: (assertOwned: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const waitMs = options.waitMs ?? 1500;
  const leaseMs = options.leaseMs ?? 30_000;
  const renewIntervalMs = options.renewIntervalMs ?? 5000;
  if (
    waitMs < 1 ||
    leaseMs < 10 ||
    renewIntervalMs < 1 ||
    renewIntervalMs >= leaseMs
  )
    throw new Error('MONITOR_ADMISSION_CONFIG_INVALID');
  const token = randomUUID();
  const deadline = performance.now() + waitMs;
  while (true) {
    options.ensureOpen();
    if (
      (await options.redis.set(options.key, token, 'PX', leaseMs, 'NX')) ===
      'OK'
    )
      break;
    if (performance.now() >= deadline)
      throw new Error('MONITOR_ADMISSION_BUSY');
    await delay(Math.min(20, Math.max(1, deadline - performance.now())));
  }
  let lost = false;
  let renewal: Promise<boolean> | undefined;
  const renew = (): Promise<boolean> => {
    if (renewal) return renewal;
    renewal = Promise.resolve()
      .then(() =>
        options.redis.eval(RENEW_LOCK, 1, options.key, token, leaseMs),
      )
      .then((value) => {
        if (Number(value) !== 1) lost = true;
        return !lost;
      })
      .catch(() => {
        lost = true;
        return false;
      })
      .finally(() => {
        renewal = undefined;
      });
    return renewal;
  };
  const timer = setInterval(() => {
    void renew();
  }, renewIntervalMs);
  timer.unref();
  const assertOwned = async () => {
    options.ensureOpen();
    if (lost || !(await renew())) throw new Error('MONITOR_ADMISSION_LOST');
    options.ensureOpen();
  };
  try {
    options.ensureOpen();
    const value = await action(assertOwned);
    if (lost) throw new Error('MONITOR_ADMISSION_UNCONFIRMED');
    return value;
  } finally {
    clearInterval(timer);
    await renewal;
    try {
      await options.redis.eval(RELEASE_LOCK, 1, options.key, token);
    } catch {
      options.onReleaseFailure();
    }
  }
}
