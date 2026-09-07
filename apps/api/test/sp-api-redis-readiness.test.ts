import { SpApiError } from '@asin-monitor/sp-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpApiRedisReadiness } from '../src/sp-api-runtime/sp-api-redis-readiness';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const resources: SpApiRedisReadiness[] = [];
afterEach(() => {
  resources.splice(0).forEach((resource) => resource.close());
  vi.useRealTimers();
});
function fixture() {
  const owner = {
    client: { status: 'wait' },
    ping: vi.fn(async () => {
      owner.client.status = 'ready';
    }),
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const readiness = new SpApiRedisReadiness(owner, logger, 100);
  resources.push(readiness);
  return { owner, logger, readiness };
}
describe('bounded host Redis readiness and recovery', () => {
  it('does no constructor I/O and shares one connection attempt among simultaneous users', async () => {
    const f = fixture(),
      pending = deferred<void>();
    f.owner.ping.mockImplementationOnce(async () => {
      await pending.promise;
      f.owner.client.status = 'ready';
    });
    expect(f.owner.ping).not.toHaveBeenCalled();
    const first = f.readiness.ensure(),
      second = f.readiness.ensure();
    await Promise.resolve();
    expect(f.owner.ping).toHaveBeenCalledTimes(1);
    pending.resolve();
    await Promise.all([first, second]);
    await f.readiness.ensure();
    expect(f.owner.ping).toHaveBeenCalledTimes(1);
  });
  it('finishes the bounded visible probe but does not launch more work when the real ping ignores its deadline', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      pending = deferred<void>();
    f.owner.ping.mockReturnValueOnce(pending.promise);
    const first = f.readiness.ensure();
    await vi.advanceTimersByTimeAsync(100);
    await expect(first).resolves.toBeUndefined();
    for (let index = 0; index < 100; index++) await f.readiness.ensure();
    expect(f.owner.ping).toHaveBeenCalledTimes(1);
    expect(f.logger.warn).toHaveBeenCalledTimes(1);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await f.readiness.ensure();
    expect(f.owner.ping).toHaveBeenCalledTimes(2);
    expect(f.owner.client.status).toBe('ready');
  });
  it('reconnects a failed/end client on a later use without exposing raw dependency messages', async () => {
    const f = fixture();
    f.owner.ping.mockRejectedValueOnce(
      new Error('redis://private:secret@fixture.invalid'),
    );
    await f.readiness.ensure();
    f.owner.client.status = 'end';
    await f.readiness.ensure();
    expect(f.owner.ping).toHaveBeenCalledTimes(2);
    expect(f.logger.info).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain('private');
  });
  it('recognizes recovery by another host user and reports a later outage again', async () => {
    const f = fixture();
    f.owner.ping.mockRejectedValueOnce(new Error('Fixture unavailable'));
    await f.readiness.ensure();
    f.owner.client.status = 'ready';
    await f.readiness.ensure();
    f.owner.client.status = 'end';
    f.owner.ping.mockRejectedValueOnce(new Error('Fixture unavailable again'));
    await f.readiness.ensure();
    expect(f.logger.info).toHaveBeenCalledTimes(1);
    expect(f.logger.warn).toHaveBeenCalledTimes(2);
  });
  it('cancels one waiter while preserving the single shared ping for other users', async () => {
    const f = fixture(),
      pending = deferred<void>(),
      controller = new AbortController();
    f.owner.ping.mockReturnValueOnce(pending.promise);
    const first = f.readiness.ensure(controller.signal).catch((error) => error);
    const second = f.readiness.ensure();
    controller.abort(new SpApiError('CANCELLED'));
    expect(await first).toMatchObject({ code: 'CANCELLED' });
    expect(f.owner.ping).toHaveBeenCalledTimes(1);
    pending.resolve();
    await second;
  });
  it('closes visible waits promptly and ignores late failures without restarting connections', async () => {
    const f = fixture(),
      pending = deferred<void>();
    f.owner.ping.mockReturnValueOnce(pending.promise);
    const result = f.readiness.ensure().catch((error) => error);
    await Promise.resolve();
    f.readiness.close();
    expect(await result).toMatchObject({ code: 'CLOSED' });
    await expect(f.readiness.ensure()).rejects.toMatchObject({
      code: 'CLOSED',
    });
    pending.reject(new Error('private-late-error'));
    await Promise.resolve();
    await Promise.resolve();
    expect(f.logger.warn).not.toHaveBeenCalled();
  });
  it('rejects a pre-cancelled caller before touching Redis', async () => {
    const f = fixture(),
      controller = new AbortController();
    controller.abort();
    await expect(f.readiness.ensure(controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(f.owner.ping).not.toHaveBeenCalled();
  });
});
