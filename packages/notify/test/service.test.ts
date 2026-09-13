import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationError, notificationDelay } from '../src/errors';
import type {
  NotificationConfigSource,
  NotificationTransport,
} from '../src/ports';
import { FeishuNotifications } from '../src/service';
import type { NotificationData, NotificationDomain } from '../src/types';
import { legacyNotifyRuntime } from './helpers/legacy-notify';

const start = Date.parse('2026-09-14T00:00:00Z');
const webhook = 'https://example.invalid/private-notify-117';
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
type Reply = { status: number; code?: unknown; thrown?: boolean } | 'network';
describe('notification service / actual Legacy execution and results', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  async function compare(
    domain: NotificationDomain,
    mode: 'once' | 'country' | 'batch',
    replies: Reply[],
    configs: (string | undefined)[] = [webhook],
    countries: Record<string, NotificationData> = {
      US: {},
      UK: {},
      DE: {},
      FR: {},
      IT: {},
      ES: {},
    },
  ) {
    async function run(legacy: boolean) {
      vi.setSystemTime(start);
      const trace: unknown[] = [];
      let reads = 0,
        posts = 0;
      const read = async (region: string) => {
        trace.push(['read', region, Date.now() - start]);
        const url = configs[Math.min(reads++, configs.length - 1)];
        return url ? { webhook_url: url } : undefined;
      };
      const post = async (url: string, body: unknown) => {
        trace.push(['post', url, json(body), Date.now() - start]);
        const result = replies[Math.min(posts++, replies.length - 1)]!;
        if (result === 'network')
          throw new Error('fixture-private-network-error');
        if (legacy && result.thrown)
          throw {
            response: { status: result.status, data: { code: result.code } },
          };
        return { status: result.status, data: { code: result.code } };
      };
      const pause = (ms: number) => {
        trace.push(['wait', ms, Date.now() - start]);
      };
      const old = legacyNotifyRuntime(domain, {
        read,
        post,
        random: () => 0.25,
        onDelay: pause,
      });
      const neo = new FeishuNotifications({
        source: {
          read: async (_domain, region) => {
            const row = await read(region);
            return row && { webhookUrl: row.webhook_url };
          },
        },
        transport: {
          send: async (url, card) => {
            const response = await post(url, { msg_type: 'interactive', card });
            return { statusCode: response.status, code: response.data.code };
          },
          close() {},
        },
        logger: logger(),
        random: () => 0.25,
        delay: (ms, signal) => {
          pause(ms);
          return notificationDelay(ms, signal);
        },
      });
      const data: NotificationData = {
        country: 'US',
        brokenGroups: 1,
        brokenASINs: [
          { asin: 'B000000001', groupName: '完整组', statusSource: 'MANUAL' },
        ],
      };
      const task = legacy
        ? mode === 'once'
          ? old.sendOnce('US', data)
          : mode === 'country'
          ? old.sendCountry!('UK', data)
          : old.sendBatch(countries)
        : mode === 'once'
        ? neo.sendOnce(domain, 'US', data)
        : mode === 'country'
        ? neo.sendCountry(domain, 'UK', data)
        : neo.sendBatch(domain, countries);
      const observed = task.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await vi.runAllTimersAsync();
      const result = await observed;
      expect(result).not.toHaveProperty('error');
      const outcome = json(result);
      expect(neo.getDiagnostics()).toMatchObject({
        activeOperations: 0,
        pendingDependencies: 0,
      });
      neo.close();
      expect(vi.getTimerCount()).toBe(0);
      return { outcome, trace };
    }
    const expected = await run(true),
      actual = await run(false);
    expect(actual).toEqual(expected);
    return actual;
  }
  for (const domain of ['primary', 'competitor'] as const) {
    it.each<Reply[]>([
      [{ status: 200, code: 0 }],
      [{ status: 201, code: 0 }],
      [{ status: 200, code: '0' }],
      [{ status: 200 }],
      [{ status: 400, code: 11233, thrown: true }],
      ['network'],
    ])(
      `${domain} preserves single-attempt complete results (%j)`,
      async (reply) => {
        await compare(domain, 'once', [reply]);
      },
    );
    it(`${domain} limits retries to three total attempts and preserves all batch results`, async () => {
      const result = await compare(domain, 'batch', [
        { status: 429, code: 11232, thrown: true },
      ]);
      expect(
        result.trace.filter((row) => (row as unknown[])[0] === 'post'),
      ).toHaveLength(18);
    });
    it(`${domain} retries numeric string limits and re-reads rotated credentials`, async () => {
      await compare(
        domain,
        'batch',
        [
          { status: 200, code: ' 11232 ' },
          { status: 200, code: '11232' },
          { status: 200, code: 0 },
        ],
        [webhook, `${webhook}/rotated`],
      );
    });
    it(`${domain} stops after configuration deletion and preserves missing-config failed/skipped flags`, async () => {
      await compare(
        domain,
        'batch',
        [{ status: 200, code: 11232 }],
        [webhook, undefined],
      );
      await compare(domain, 'batch', [{ status: 200, code: 0 }], [undefined]);
    });
    it(`${domain} preserves exact country mapping and a trailing single-country batch`, async () => {
      await compare(domain, 'batch', [{ status: 200, code: 0 }], [webhook], {
        US: {},
        uk: {},
        'UK ': {},
        JP: {},
        EU: {},
      });
    });
    it(`${domain} returns the complete empty batch without reading configuration`, async () => {
      expect(
        (
          await compare(
            domain,
            'batch',
            [{ status: 200, code: 0 }],
            [webhook],
            {},
          )
        ).trace,
      ).toEqual([]);
    });
  }
  it('preserves primary single-country mapping and retry result', async () => {
    await compare('primary', 'country', [
      { status: 200, code: 11232 },
      { status: 200, code: 0 },
    ]);
  });
});

describe('notification lifetime, bounds and secrecy', () => {
  let service: FeishuNotifications,
    log: ReturnType<typeof logger>,
    source: NotificationConfigSource,
    transport: NotificationTransport;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    log = logger();
    source = { read: vi.fn(async () => ({ webhookUrl: webhook })) };
    transport = {
      send: vi.fn(async () => ({ statusCode: 200, code: 0 })),
      close: vi.fn(),
    };
    service = new FeishuNotifications({ source, transport, logger: log });
  });
  afterEach(() => {
    service.close();
    vi.useRealTimers();
  });
  it('cancels a pending configuration read, discards its late credential and never posts', async () => {
    let release!: (value: { webhookUrl: string }) => void;
    source.read = vi.fn(
      () =>
        new Promise<{ webhookUrl: string }>((resolve) => {
          release = resolve;
        }),
    );
    const abort = new AbortController(),
      task = service.sendCountry('primary', 'US', {}, abort.signal);
    const rejected = expect(task).rejects.toMatchObject({
      reason: 'cancelled',
    });
    await vi.advanceTimersByTimeAsync(0);
    abort.abort('secret abort reason');
    await rejected;
    expect(service.getDiagnostics().pendingDependencies).toBe(1);
    release({ webhookUrl: `${webhook}/late` });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.send).not.toHaveBeenCalled();
    expect(service.getDiagnostics().pendingDependencies).toBe(0);
  });
  it('stops a 11232 retry delay and rejects future work after close', async () => {
    transport.send = vi.fn(async () => ({ statusCode: 200, code: 11232 }));
    const task = service.sendCountry('primary', 'US', {}),
      rejected = expect(task).rejects.toMatchObject({ reason: 'closed' });
    await vi.advanceTimersByTimeAsync(0);
    service.close();
    await rejected;
    await vi.runAllTimersAsync();
    expect(transport.send).toHaveBeenCalledTimes(1);
    await expect(service.sendOnce('primary', 'US', {})).rejects.toMatchObject({
      reason: 'closed',
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('stops batch waits without dispatching the next pair', async () => {
    const abort = new AbortController(),
      task = service.sendBatch(
        'primary',
        { US: {}, UK: {}, DE: {}, FR: {} },
        abort.signal,
      );
    const rejected = expect(task).rejects.toMatchObject({
      reason: 'cancelled',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.send).toHaveBeenCalledTimes(2);
    abort.abort();
    await rejected;
    await vi.runAllTimersAsync();
    expect(transport.send).toHaveBeenCalledTimes(2);
  });
  it('retains slots for noncooperative dependencies and rejects excess active work', async () => {
    source.read = vi.fn(() => new Promise<never>(() => {}));
    const tasks = Array.from({ length: 4 }, () =>
      service.sendOnce('primary', 'US', {}),
    );
    await expect(service.sendOnce('primary', 'US', {})).rejects.toMatchObject({
      reason: 'capacity',
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await Promise.all(tasks)).toEqual(
      Array.from({ length: 4 }, () => ({
        success: false,
        errorCode: undefined,
      })),
    );
    const next = Array.from({ length: 4 }, () =>
      service.sendOnce('primary', 'US', {}),
    );
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(next);
    expect(service.getDiagnostics().pendingDependencies).toBe(8);
    expect(await service.sendOnce('primary', 'US', {})).toEqual({
      success: false,
      errorCode: undefined,
    });
    expect(source.read).toHaveBeenCalledTimes(8);
  });
  it('bounds total operation time even during an otherwise valid retry', async () => {
    service.close();
    service = new FeishuNotifications({
      source,
      transport,
      logger: log,
      operationTimeoutMs: 10,
    });
    transport.send = vi.fn(async () => ({ statusCode: 200, code: 11232 }));
    const task = service.sendCountry('primary', 'US', {}),
      rejected = expect(task).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('snapshots the complete input before asynchronous configuration and retries', async () => {
    const data = {
      country: 'US',
      brokenGroups: 1,
      brokenASINs: [{ asin: 'ORIGINAL', groupName: 'old' }],
    };
    transport.send = vi.fn(async () => ({ statusCode: 200, code: 11232 }));
    const task = service.sendCountry('primary', 'US', data);
    data.brokenASINs[0]!.asin = 'CHANGED';
    data.brokenGroups = 0;
    await vi.runAllTimersAsync();
    await task;
    expect(JSON.stringify(vi.mocked(transport.send).mock.calls)).toContain(
      'ORIGINAL',
    );
    expect(JSON.stringify(vi.mocked(transport.send).mock.calls)).not.toContain(
      'CHANGED',
    );
  });
  it.each([
    null,
    [],
    { brokenGroups: -1 },
    { brokenASINs: Array(10_001).fill({}) },
    { title: 'x'.repeat(1_048_577) },
    { brokenByType: { NO_VARIANTS: NaN } },
    { checkTime: 7 },
  ])(
    'rejects invalid or unbounded input before touching credentials (%#)',
    async (data) => {
      await expect(
        service.sendOnce('primary', 'US', data as NotificationData),
      ).rejects.toMatchObject({ reason: 'invalid-input' });
      expect(source.read).not.toHaveBeenCalled();
    },
  );
  it('rejects accessors without running them and bounds country batch count', async () => {
    const getter = vi.fn(() => webhook),
      data = Object.defineProperty({}, 'title', { get: getter });
    await expect(service.sendOnce('primary', 'US', data)).rejects.toMatchObject(
      { reason: 'invalid-input' },
    );
    await expect(
      service.sendBatch(
        'primary',
        Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`C${i}`, {}])),
      ),
    ).rejects.toMatchObject({ reason: 'invalid-input' });
    expect(getter).not.toHaveBeenCalled();
    expect(source.read).not.toHaveBeenCalled();
  });
  it('keeps credentials, raw upstream text, driver errors and abort reasons out of logs/results', async () => {
    source.read = vi.fn(async () => {
      throw new Error(webhook);
    });
    const first = await service.sendOnce('primary', 'US', {});
    source.read = vi.fn(async () => ({ webhookUrl: webhook }));
    transport.send = vi.fn(async () => ({
      statusCode: 200,
      code: `private upstream ${webhook}`,
    }));
    const second = await service.sendOnce('primary', 'US', {});
    expect(
      JSON.stringify([
        first,
        second,
        log.info.mock.calls,
        log.warn.mock.calls,
        log.error.mock.calls,
      ]),
    ).not.toContain(webhook);
    expect(second).toEqual({ success: false, errorCode: 200 });
  });
  it('does not accept a user-controlled cancellation reason', async () => {
    const abort = new AbortController();
    abort.abort(new Error(webhook));
    await expect(
      service.sendOnce('primary', 'US', {}, abort.signal),
    ).rejects.toEqual(new NotificationError('cancelled'));
  });
});
