import { createConnection, createServer, type Socket } from 'node:net';

// One disposable loopback client, one owned held frame, bounded RESP2 buffers.
// This forwards real commands to Redis; it does not interpret or emulate Lua.
const MAX_BYTES = 2 * 1024 * 1024 + 64 * 1024;
const MAX_ITEMS = 512;
const MAX_IN_FLIGHT = 64;
const MAX_HOLD_MS = 20_000;
export type RedisRespValue =
  | Buffer
  | number
  | null
  | { error: true }
  | RedisRespValue[];
type Mode = 'before-command' | 'after-reply';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  // Teardown can reject a phase that the test did not get to await.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
function parseResp(
  buffer: Buffer,
  offset = 0,
  depth = 0,
): { end: number; value: RedisRespValue } | undefined {
  if (depth > 4) throw new Error('RESP_GATE_DEPTH');
  if (offset >= buffer.length) return undefined;
  const lineEnd = buffer.indexOf('\r\n', offset);
  if (lineEnd < 0) return undefined;
  if (lineEnd - offset > 64 * 1024) throw new Error('RESP_GATE_LINE');
  const kind = buffer[offset];
  const text = buffer.toString('ascii', offset + 1, lineEnd);
  const body = lineEnd + 2;
  if (kind === 43)
    return { end: body, value: buffer.subarray(offset + 1, lineEnd) };
  if (kind === 45) return { end: body, value: { error: true } };
  if (![36, 42, 58].includes(kind) || !/^-?\d+$/.test(text))
    throw new Error('RESP_GATE_PROTOCOL');
  const length = Number(text);
  if (!Number.isSafeInteger(length)) throw new Error('RESP_GATE_INTEGER');
  if (kind === 58) return { end: body, value: length };
  if (length === -1) return { end: body, value: null };
  if (length < 0) throw new Error('RESP_GATE_LENGTH');
  if (kind === 36) {
    if (length > MAX_BYTES) throw new Error('RESP_GATE_BULK');
    const end = body + length + 2;
    if (end > buffer.length) return undefined;
    if (buffer[end - 2] !== 13 || buffer[end - 1] !== 10)
      throw new Error('RESP_GATE_TERMINATOR');
    return { end, value: buffer.subarray(body, body + length) };
  }
  if (length > MAX_ITEMS) throw new Error('RESP_GATE_ITEMS');
  const values: RedisRespValue[] = [];
  let end = body;
  for (let i = 0; i < length; i++) {
    const child = parseResp(buffer, end, depth + 1);
    if (!child) return undefined;
    end = child.end;
    values.push(child.value);
  }
  return { end, value: values };
}

export async function boundedRedisRespGate(upstreamUrl: string) {
  const target = new URL(upstreamUrl);
  if (
    target.protocol !== 'redis:' ||
    target.hostname !== '127.0.0.1' ||
    target.port !== '6379' ||
    target.pathname !== '/15' ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new Error('RESP_GATE_REQUIRES_DISPOSABLE_LOOPBACK_REDIS');
  type Control = {
    mode: Mode;
    match: (arguments_: readonly Buffer[]) => boolean;
    held: ReturnType<typeof deferred<readonly Buffer[]>>;
    executed: ReturnType<typeof deferred<RedisRespValue>>;
    ack: ReturnType<typeof deferred<void>>;
    command?: Buffer;
    reply?: Buffer;
    connection?: Connection;
    done?: boolean;
    timer: ReturnType<typeof setTimeout>;
  };
  type Connection = {
    client: Socket;
    upstream: Socket;
    input: Buffer;
    output: Buffer;
    queue: (Control | undefined)[];
    held?: Control;
    failed: boolean;
    closed: ReturnType<typeof deferred<void>>;
  };
  let control: Control | undefined;
  let closed = false;
  const connections = new Set<Connection>();
  const fail = (connection: Connection, reason: string) => {
    if (connection.failed) return;
    connection.failed = true;
    const error = new Error(reason);
    const owned = connection.held ?? control;
    if (owned) {
      owned.done = true;
      clearTimeout(owned.timer);
      owned.held.reject(error);
      owned.executed.reject(error);
      owned.ack.reject(error);
      if (control === owned) control = undefined;
    }
    connection.client.destroy();
    connection.upstream.destroy();
  };
  const budget = (connection: Connection, extra = 0) => {
    if (
      connection.input.length +
        connection.output.length +
        (connection.held?.command?.length ?? 0) +
        (connection.held?.reply?.length ?? 0) +
        connection.client.writableLength +
        connection.upstream.writableLength +
        extra >
      MAX_BYTES
    )
      throw new Error('RESP_GATE_CAPACITY');
  };
  const sendCommand = (
    connection: Connection,
    frame: Buffer,
    owned?: Control,
  ) => {
    if (connection.queue.length >= MAX_IN_FLIGHT)
      throw new Error('RESP_GATE_PIPELINE');
    connection.queue.push(owned);
    if (!connection.upstream.write(frame)) connection.client.pause();
    budget(connection);
  };
  const pumpCommands = (connection: Connection) => {
    while (!connection.failed && !connection.held) {
      const parsed = parseResp(connection.input);
      if (!parsed) break;
      if (
        !Array.isArray(parsed.value) ||
        !parsed.value.every((item) => Buffer.isBuffer(item))
      )
        throw new Error('RESP_GATE_COMMAND');
      const arguments_ = parsed.value as Buffer[];
      const frame = connection.input.subarray(0, parsed.end);
      connection.input = connection.input.subarray(parsed.end);
      if (control && !control.connection && control.match(arguments_)) {
        const owned = control;
        owned.connection = connection;
        connection.held = owned;
        connection.client.pause();
        owned.held.resolve(arguments_);
        if (owned.mode === 'before-command') owned.command = frame;
        else sendCommand(connection, frame, owned);
        budget(connection);
        break;
      }
      sendCommand(connection, frame);
    }
  };
  const finishReply = (
    connection: Connection,
    frame: Buffer,
    owned?: Control,
  ) => {
    if (!connection.client.write(frame)) connection.upstream.pause();
    if (owned) {
      clearTimeout(owned.timer);
      owned.reply = undefined;
      connection.held = undefined;
      if (control === owned) control = undefined;
      owned.ack.resolve();
      owned.done = true;
      connection.client.resume();
      connection.upstream.resume();
      pumpCommands(connection);
    }
    budget(connection);
  };
  const pumpReplies = (connection: Connection) => {
    while (!connection.failed && !connection.held?.reply) {
      const parsed = parseResp(connection.output);
      if (!parsed) break;
      if (!connection.queue.length) throw new Error('RESP_GATE_RESPONSE_FIFO');
      const owned = connection.queue.shift();
      const frame = connection.output.subarray(0, parsed.end);
      connection.output = connection.output.subarray(parsed.end);
      if (owned) {
        owned.executed.resolve(parsed.value);
        if (owned.mode === 'after-reply') {
          owned.reply = frame;
          connection.upstream.pause();
          budget(connection);
          break;
        }
      }
      finishReply(connection, frame, owned);
    }
  };
  const safely = (connection: Connection, action: () => void) => {
    try {
      action();
    } catch {
      fail(connection, 'RESP_GATE_PROTOCOL_OR_CAPACITY');
    }
  };
  const server = createServer((client) => {
    if (closed || connections.size) {
      client.destroy();
      return;
    }
    const upstream = createConnection({ host: '127.0.0.1', port: 6379 });
    const connection: Connection = {
      client,
      upstream,
      input: Buffer.alloc(0),
      output: Buffer.alloc(0),
      queue: [],
      failed: false,
      closed: deferred<void>(),
    };
    connections.add(connection);
    client.on('data', (chunk: Buffer) =>
      safely(connection, () => {
        budget(connection, chunk.length);
        connection.input = Buffer.concat([connection.input, chunk]);
        pumpCommands(connection);
      }),
    );
    upstream.on('data', (chunk: Buffer) =>
      safely(connection, () => {
        budget(connection, chunk.length);
        connection.output = Buffer.concat([connection.output, chunk]);
        pumpReplies(connection);
      }),
    );
    upstream.on('drain', () => {
      if (!connection.held) client.resume();
    });
    client.on('drain', () => {
      if (!connection.held?.reply) upstream.resume();
    });
    client.on('error', () => fail(connection, 'RESP_GATE_CLIENT_TRANSPORT'));
    upstream.on('error', () =>
      fail(connection, 'RESP_GATE_UPSTREAM_TRANSPORT'),
    );
    let closedSockets = 0;
    const closedSocket = () => {
      if (++closedSockets === 2) {
        connections.delete(connection);
        connection.closed.resolve();
      }
    };
    client.on('close', () => {
      fail(connection, 'RESP_GATE_CLIENT_CLOSED');
      closedSocket();
    });
    upstream.on('close', () => {
      fail(connection, 'RESP_GATE_UPSTREAM_CLOSED');
      closedSocket();
    });
  });
  server.maxConnections = 1;
  server.on('error', () => {
    for (const connection of connections)
      fail(connection, 'RESP_GATE_SERVER_TRANSPORT');
  });
  await new Promise<void>((accept, decline) => {
    server.once('error', decline);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', decline);
      accept();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('RESP_GATE_ADDRESS');
  const proxyUrl = new URL(target.toString());
  proxyUrl.port = String(address.port);
  return {
    url: proxyUrl.toString(),
    arm(match: Control['match'], mode: Mode = 'before-command') {
      if (closed || control) throw new Error('RESP_GATE_ALREADY_ARMED');
      const owned: Control = {
        mode,
        match,
        held: deferred<readonly Buffer[]>(),
        executed: deferred<RedisRespValue>(),
        ack: deferred<void>(),
        timer: setTimeout(() => {
          if (owned.connection)
            fail(owned.connection, 'RESP_GATE_HOLD_TIMEOUT');
          else {
            const error = new Error('RESP_GATE_MATCH_TIMEOUT');
            owned.held.reject(error);
            owned.executed.reject(error);
            owned.ack.reject(error);
            if (control === owned) control = undefined;
          }
        }, MAX_HOLD_MS),
      };
      control = owned;
      return {
        held: owned.held.promise,
        executed: owned.executed.promise,
        ackForwarded: owned.ack.promise,
        forward() {
          const connection = owned.connection;
          if (!connection || !owned.command)
            throw new Error('RESP_GATE_NO_HELD_COMMAND');
          const frame = owned.command;
          owned.command = undefined;
          safely(connection, () => sendCommand(connection, frame, owned));
        },
        releaseAcknowledgement() {
          const connection = owned.connection;
          if (!connection || !owned.reply)
            throw new Error('RESP_GATE_NO_HELD_REPLY');
          const frame = owned.reply;
          safely(connection, () => {
            finishReply(connection, frame, owned);
            pumpReplies(connection);
          });
        },
        async destroy() {
          if (owned.done) return;
          if (owned.connection) {
            fail(owned.connection, 'RESP_GATE_TEARDOWN');
            await owned.connection.closed.promise;
          } else {
            clearTimeout(owned.timer);
            const error = new Error('RESP_GATE_TEARDOWN');
            owned.held.reject(error);
            owned.executed.reject(error);
            owned.ack.reject(error);
            if (control === owned) control = undefined;
          }
        },
      };
    },
    async close() {
      closed = true;
      if (control) {
        clearTimeout(control.timer);
        const error = new Error('RESP_GATE_TEARDOWN');
        control.held.reject(error);
        control.executed.reject(error);
        control.ack.reject(error);
        control = undefined;
      }
      const closing = [...connections].map(
        (connection) => connection.closed.promise,
      );
      for (const connection of connections)
        fail(connection, 'RESP_GATE_TEARDOWN');
      await new Promise<void>((accept, decline) =>
        server.close((error) => (error ? decline(error) : accept())),
      );
      await Promise.all(closing);
    },
  };
}
