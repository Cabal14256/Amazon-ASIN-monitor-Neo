import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgFeishuNotificationConfigReader } from '../src/repositories/feishu-notification-config-reader';

describe('notification credential reader / bounded connection ownership', () => {
  let reader: PgFeishuNotificationConfigReader;
  let rows: { webhook_url: unknown; enabled: unknown }[];
  let client: EventEmitter & {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  let connect: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    rows = [{ webhook_url: 'https://example.invalid/fixture', enabled: true }];
    client = Object.assign(new EventEmitter(), {
      query: vi.fn(async (text: string) => ({
        rows: text.startsWith('SELECT left') ? rows : [],
      })),
      release: vi.fn(),
    });
    connect = vi.fn(async () => client as unknown as PoolClient);
    reader = new PgFeishuNotificationConfigReader(
      { connect } as unknown as Pool,
      'primary',
    );
  });
  afterEach(() => {
    reader.close();
    vi.useRealTimers();
  });
  it('commits a fresh read under the shared administration lock and returns only the webhook', async () => {
    expect(await reader.read('US')).toEqual({
      webhookUrl: 'https://example.invalid/fixture',
    });
    expect(client.query.mock.calls.map(([text]) => text)).toEqual([
      'BEGIN READ ONLY',
      'SET LOCAL statement_timeout = 1500',
      'SELECT pg_advisory_xact_lock_shared(1095977294,1380073795)',
      expect.stringContaining('FROM feishu_config'),
      'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledWith(false);
    expect(reader.getDiagnostics().pendingReads).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([false, null])(
    'does not expose disabled/null enabled credentials (%s)',
    async (enabled) => {
      rows[0]!.enabled = enabled;
      expect(await reader.read('US')).toBeUndefined();
    },
  );
  it.each([
    [{ webhook_url: 'x', enabled: 'true' }],
    [{ webhook_url: 'x'.repeat(501), enabled: true }],
    [
      { webhook_url: 'x', enabled: true },
      { webhook_url: 'y', enabled: false },
    ],
  ])(
    'destroys the transaction on invalid or ambiguous rows (%#)',
    async (...invalid) => {
      rows = invalid;
      await expect(reader.read('US')).rejects.toMatchObject({
        reason: 'invalid-result',
      });
      expect(client.release).toHaveBeenCalledWith(true);
      expect(client.query).not.toHaveBeenCalledWith('COMMIT');
    },
  );
  it('releases a late pool connection without executing SQL after caller cancellation', async () => {
    let release!: (client: PoolClient) => void;
    connect.mockImplementation(
      () =>
        new Promise<PoolClient>((resolve) => {
          release = resolve;
        }),
    );
    const abort = new AbortController(),
      task = reader.read('US', abort.signal),
      rejected = expect(task).rejects.toMatchObject({ reason: 'cancelled' });
    abort.abort('private reason');
    await rejected;
    expect(reader.getDiagnostics().pendingReads).toBe(1);
    release(client as unknown as PoolClient);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(reader.getDiagnostics().pendingReads).toBe(0);
  });
  it('retains bounded acquisition slots after timeouts until the actual acquisitions settle', async () => {
    connect.mockImplementation(() => new Promise<never>(() => {}));
    const tasks = Array.from({ length: 8 }, () =>
      reader.read('US').catch((error) => error),
    );
    await expect(reader.read('US')).rejects.toMatchObject({
      reason: 'capacity',
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await Promise.all(tasks)).toEqual(
      Array.from({ length: 8 }, () =>
        expect.objectContaining({ reason: 'timeout' }),
      ),
    );
    expect(reader.getDiagnostics().pendingReads).toBe(8);
    await expect(reader.read('US')).rejects.toMatchObject({
      reason: 'capacity',
    });
    expect(connect).toHaveBeenCalledTimes(8);
  });
  it('cancels a stalled SQL query and closes the borrowed connection exactly once', async () => {
    let finish!: () => void;
    client.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ rows: [] });
        }),
    );
    const task = reader.read('US'),
      rejected = expect(task).rejects.toMatchObject({ reason: 'closed' });
    await vi.advanceTimersByTimeAsync(0);
    reader.close();
    await rejected;
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await expect(reader.read('US')).rejects.toMatchObject({ reason: 'closed' });
  });
  it('sanitizes SQL and connection errors instead of exposing driver data', async () => {
    client.query.mockRejectedValueOnce(
      new Error('private-webhook-driver-error'),
    );
    const error = await reader.read('US').catch((error) => error as Error);
    expect(error).toMatchObject({ reason: 'dependency' });
    expect(String(error)).not.toContain('private');
    expect(client.release).toHaveBeenCalledWith(true);
  });
  it('rejects invalid domains/regions and pre-aborted work without acquiring a connection', async () => {
    expect(
      () =>
        new PgFeishuNotificationConfigReader(
          { connect } as unknown as Pool,
          'other' as 'primary',
        ),
    ).toThrow();
    for (const region of ['', 'x'.repeat(11), 'US\0'])
      await expect(reader.read(region)).rejects.toMatchObject({
        reason: 'invalid-input',
      });
    const abort = new AbortController();
    abort.abort();
    await expect(reader.read('US', abort.signal)).rejects.toMatchObject({
      reason: 'cancelled',
    });
    expect(connect).not.toHaveBeenCalled();
  });
});
