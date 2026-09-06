import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeClient, webSocketURL } from './realtime';
import { FakeSocket } from './transport-fixtures';

const clients: RealtimeClient[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
  vi.useRealTimers();
});
function setup() {
  const sockets: FakeSocket[] = [];
  const socket = vi.fn(() => {
    const value = new FakeSocket();
    sockets.push(value);
    return value;
  });
  const hasSession = vi.fn(() => true);
  const diagnostic = vi.fn();
  const onAuthClose = vi.fn();
  const client = new RealtimeClient({
    url: 'wss://app.test/ws',
    socket,
    hasSession,
    diagnostic,
    onAuthClose,
  });
  clients.push(client);
  return { client, sockets, socket, hasSession, diagnostic, onAuthClose };
}
describe('browser WebSocket lifecycle', () => {
  it('uses the Vite same-origin proxy by default and strips the configured API suffix', () => {
    expect(webSocketURL(undefined, 'http://localhost:5173')).toBe(
      'ws://localhost:5173/ws',
    );
    expect(
      webSocketURL('https://api.test/gateway/api/v1/', 'https://app.test'),
    ).toBe('wss://api.test/gateway/ws');
    expect(() => webSocketURL('http://api.test', 'https://app.test')).toThrow();
    expect(() =>
      webSocketURL('https://user:pass@api.test', 'https://app.test'),
    ).toThrow();
    expect(() => webSocketURL('/api?x=1', 'https://app.test')).toThrow();
  });
  it('is inert until explicitly connected and never opens without a session hint', () => {
    const f = setup();
    expect(f.socket).not.toHaveBeenCalled();
    f.hasSession.mockReturnValue(false);
    expect(f.client.connect()).toBe(false);
    expect(f.socket).not.toHaveBeenCalled();
    f.hasSession.mockReturnValue(true);
    f.client.connect();
    f.client.connect();
    expect(f.socket).toHaveBeenCalledTimes(1);
    f.sockets[0].open();
    expect(f.client.isConnected()).toBe(true);
  });
  it('sends a contract-validated ping every 30 seconds and stops on disconnect', async () => {
    const f = setup();
    f.client.connect();
    const socket = f.sockets[0];
    socket.open();
    await vi.advanceTimersByTimeAsync(29999);
    expect(socket.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.send).toHaveBeenCalledWith('{"type":"ping"}');
    f.client.disconnect();
    await vi.advanceTimersByTimeAsync(60000);
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(f.client.getReadyState()).toBe(3);
  });
  it('reconnects at 1/2/4/8/16 seconds and stops after five consecutive failed reconnects', async () => {
    const f = setup();
    f.client.connect();
    for (let i = 0; i < 5; i++) {
      f.sockets[i].ended();
      await vi.advanceTimersByTimeAsync(1000 * 2 ** i - 1);
      expect(f.socket).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.socket).toHaveBeenCalledTimes(i + 2);
    }
    f.sockets[5].ended();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.socket).toHaveBeenCalledTimes(6);
  });
  it.each([4401, 4403] as const)(
    'never automatically reconnects after auth close %s',
    async (code) => {
      const f = setup();
      f.client.connect();
      f.sockets[0].open();
      f.sockets[0].ended(code);
      await vi.advanceTimersByTimeAsync(60000);
      expect(f.socket).toHaveBeenCalledTimes(1);
      expect(f.onAuthClose).toHaveBeenCalledWith(code);
    },
  );
  it('cancels a pending reconnect on explicit logout', async () => {
    const f = setup();
    f.client.connect();
    f.sockets[0].ended();
    f.client.disconnect();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.socket).toHaveBeenCalledTimes(1);
  });
  it('ignores old socket open/message/close after a replacement without clearing the new ping', async () => {
    const f = setup();
    f.client.connect();
    const old = f.sockets[0];
    const listener = vi.fn();
    f.client.onMessage(listener);
    f.client.disconnect();
    f.client.connect();
    const fresh = f.sockets[1];
    fresh.open();
    f.client.onMessage(listener);
    old.open();
    old.message({ type: 'pong' });
    old.ended(4401);
    expect(listener).not.toHaveBeenCalled();
    expect(f.onAuthClose).not.toHaveBeenCalled();
    fresh.message({ type: 'pong' });
    expect(listener).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(fresh.send).toHaveBeenCalledTimes(1);
    expect(f.socket).toHaveBeenCalledTimes(2);
  });
  it('rejects malformed, oversized and unsupported messages and isolates subscribers', () => {
    const f = setup();
    f.client.connect();
    f.sockets[0].open();
    const good = vi.fn();
    f.client.onMessage(() => {
      throw new Error('private callback state');
    });
    f.client.onMessage(good);
    for (const value of [
      'not json',
      'x'.repeat(1024 * 1024 + 1),
      { type: 'unknown' },
      { type: 'task_progress', taskId: 'x', progress: 101 },
    ])
      f.sockets[0].message(value);
    expect(good).not.toHaveBeenCalled();
    f.sockets[0].message({
      type: 'task_complete',
      taskId: 'fixture',
      filename: null,
      downloadUrl: null,
      timestamp: 'fixture-time',
    });
    expect(good).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.diagnostic.mock.calls)).not.toContain('private');
    expect(f.diagnostic).toHaveBeenCalledWith('subscriber_failed');
  });
  it('honors unsubscription during dispatch and clears old subscriptions on logout', () => {
    const f = setup();
    f.client.connect();
    f.sockets[0].open();
    const other = vi.fn();
    let remove = () => {};
    f.client.onMessage(() => remove());
    remove = f.client.onMessage(other);
    f.sockets[0].message({ type: 'pong' });
    expect(other).not.toHaveBeenCalled();
    f.client.disconnect();
    f.client.connect();
    f.sockets[1].open();
    f.sockets[1].message({ type: 'pong' });
    expect(other).not.toHaveBeenCalled();
  });
  it('closes a hung handshake and schedules a bounded retry', async () => {
    const f = setup();
    f.client.connect();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.sockets[0].close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.socket).toHaveBeenCalledTimes(2);
    f.sockets[0].open();
    expect(f.sockets[0].close).toHaveBeenCalledTimes(2);
  });
  it('bounds actual not-yet-closed sockets across repeated manual reconnects', () => {
    const f = setup();
    for (let i = 0; i < 8; i++) {
      f.client.connect();
      f.client.disconnect();
    }
    expect(f.client.connect()).toBe(false);
    expect(f.socket).toHaveBeenCalledTimes(8);
    f.sockets[0].ended();
    expect(f.client.connect()).toBe(true);
    expect(f.socket).toHaveBeenCalledTimes(9);
  });
  it('handles constructor failures with the same bounded retry schedule', async () => {
    const f = setup();
    f.socket.mockImplementation(() => {
      throw new Error('fixture');
    });
    f.client.connect();
    await vi.advanceTimersByTimeAsync(31000);
    expect(f.socket).toHaveBeenCalledTimes(6);
  });
  it('does not send unsupported or backlogged frames and closes when the hint disappears', async () => {
    const f = setup();
    f.client.connect();
    f.sockets[0].open();
    expect(f.client.send({ type: 'unknown' } as never)).toBe(false);
    f.sockets[0].bufferedAmount = 65537;
    expect(f.client.send({ type: 'ping' })).toBe(false);
    f.hasSession.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.sockets[0].close).toHaveBeenCalled();
    expect(f.client.isConnected()).toBe(false);
  });
});
