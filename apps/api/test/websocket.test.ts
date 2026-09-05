import { loadEnv } from '@asin-monitor/config';
import { wsMessageSchema, type WsMessage } from '@asin-monitor/contracts';
import type {
  AuthDataRepository,
  AuthSessionRecord,
  AuthUserRecord,
} from '@asin-monitor/db';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { AppModule } from '../src/app.module';
import { AUTH_DATA_REPOSITORY } from '../src/auth/auth.constants';
import { AuthenticationService } from '../src/auth/authentication.service';
import { ENV } from '../src/config/config.module';
import { configureHttpApp } from '../src/http-app';
import { AppLogger } from '../src/logger/app-logger.service';
import {
  LocalWebSocketEventBus,
  WS_EVENT_BUS,
} from '../src/websocket/websocket-events';
import { WebSocketService } from '../src/websocket/websocket.service';

const env = loadEnv({
  DATABASE_URL: 'postgresql://localhost/amazon_asin_monitor',
  COMPETITOR_DATABASE_URL: 'postgresql://localhost/amazon_competitor_monitor',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'fixture-secret',
  AUTH_DATA_AUTHORITY: 'postgresql',
  CORS_ORIGIN: 'http://localhost:8000',
});
const session = (userId = 'u-25'): AuthSessionRecord => ({
  id: `session-${userId}`,
  userId,
  userAgent: null,
  ipAddress: null,
  status: 'ACTIVE',
  rememberMe: false,
  createdAt: new Date(),
  lastActiveAt: new Date(),
  expiresAt: new Date('2099-01-01'),
});
const user = (id = 'u-25'): AuthUserRecord => ({
  id,
  username: 'fixture',
  realName: null,
  status: 'ACTIVE',
  lastLoginTime: null,
  lastLoginIp: null,
  passwordExpiresAt: null,
  passwordChangedAt: null,
  forcePasswordChange: false,
  failedLoginAttempts: 0,
  lockedUntil: null,
  createTime: new Date(),
  updateTime: new Date(),
});
const token = (userId = 'u-25', expiresIn = 3600) =>
  jwt.sign({ userId, sessionId: session(userId).id }, env.JWT_SECRET, {
    expiresIn,
  });
const makeLogger = () =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as AppLogger);

/** 立即注册事件监听，避免握手期间 connected/close 消息早于 await 丢失。 */
class Client {
  readonly socket: WebSocket;
  readonly messages: WsMessage[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly first: Promise<WsMessage>;
  readonly rejected: Promise<number>;
  constructor(url: string, headers: Record<string, string> = {}) {
    this.socket = new WebSocket(url, { headers });
    this.socket.on('error', () => undefined);
    this.rejected = new Promise((resolve) =>
      this.socket.once('unexpected-response', (_req, response) => {
        resolve(response.statusCode!);
        this.socket.terminate();
      }),
    );
    this.closed = new Promise((resolve) =>
      this.socket.once('close', (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      ),
    );
    this.first = new Promise((resolve) =>
      this.socket.once('message', (data) =>
        resolve(wsMessageSchema.parse(JSON.parse(data.toString()))),
      ),
    );
    this.socket.on('message', (data) =>
      this.messages.push(wsMessageSchema.parse(JSON.parse(data.toString()))),
    );
  }
}

describe('Neo /ws real network gateway', () => {
  let app: NestFastifyApplication;
  let gateway: WebSocketService;
  let repository: AuthDataRepository;
  let logger: AppLogger;
  let url: string;
  const clients: Client[] = [];
  function connect(
    headers: Record<string, string> = { authorization: `Bearer ${token()}` },
    path = '/ws',
  ) {
    const client = new Client(url + path, headers);
    clients.push(client);
    return client;
  }
  beforeEach(async () => {
    repository = {
      findSessionById: vi.fn(async (id: string) =>
        session(id.slice('session-'.length)),
      ),
      findUserById: vi.fn(async (id: string) => user(id)),
      revokeSession: vi.fn(),
      touchSession: vi.fn(),
      markPasswordChangeRequired: vi.fn(),
      getRoles: vi.fn(),
      getPermissionCodes: vi.fn(),
    };
    logger = makeLogger();
    const moduleRef = await Test.createTestingModule({
      providers: [
        WebSocketService,
        AuthenticationService,
        { provide: ENV, useValue: env },
        { provide: AUTH_DATA_REPOSITORY, useValue: repository },
        { provide: WS_EVENT_BUS, useClass: LocalWebSocketEventBus },
        { provide: AppLogger, useValue: logger },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false }),
    );
    configureHttpApp(app, { logger });
    gateway = moduleRef.get(WebSocketService);
    gateway.init(app.getHttpServer());
    await app.listen(0, '127.0.0.1');
    url = (await app.getUrl()).replace(/^http/, 'ws');
  });
  afterEach(async () => {
    for (const client of clients) client.socket.terminate();
    await Promise.all(clients.map((client) => client.closed));
    clients.length = 0;
    await app.close();
    vi.restoreAllMocks();
  });

  it('authenticates Cookie before Bearer, returns connected and responds only to JSON ping', async () => {
    const client = connect({
      cookie: `${env.AUTH_COOKIE_NAME}=${token()}`,
      authorization: 'Bearer invalid',
      origin: env.CORS_ORIGIN,
    });
    expect(await client.first).toEqual({
      type: 'connected',
      message: 'WebSocket连接成功',
    });
    client.socket.send('invalid JSON');
    client.socket.send(
      JSON.stringify({ type: 'broadcast', userId: 'other', data: 'malicious' }),
    );
    client.socket.send(JSON.stringify({ type: 'ping' }));
    await vi.waitFor(() => expect(client.messages).toHaveLength(2));
    expect(client.messages[1]).toEqual({ type: 'pong' });
    expect(repository.touchSession).toHaveBeenCalledWith(session().id);
    expect(gateway.getClientCount()).toBe(1);
  });

  it.each([
    ['missing', {}, 4401],
    ['query token ignored', {}, 4401],
    ['invalid JWT', { authorization: 'Bearer invalid' }, 4403],
    ['expired JWT', { authorization: `Bearer ${token('u-25', -1)}` }, 4401],
    [
      'future JWT',
      {
        authorization: `Bearer ${jwt.sign(
          { userId: 'u-25', sessionId: session().id },
          env.JWT_SECRET,
          { notBefore: '1h' },
        )}`,
      },
      4403,
    ],
    [
      'cross-origin',
      {
        cookie: `${env.AUTH_COOKIE_NAME}=${token()}`,
        origin: 'https://evil.invalid',
      },
      4403,
    ],
    [
      'opaque origin',
      { cookie: `${env.AUTH_COOKIE_NAME}=${token()}`, origin: 'null' },
      4403,
    ],
    [
      'lookalike origin',
      {
        authorization: `Bearer ${token()}`,
        origin: 'http://localhost:8000.evil.invalid',
      },
      4403,
    ],
  ] as const)(
    'rejects %s with frozen close code',
    async (label, headers, code) => {
      const client = connect(
        headers,
        label === 'query token ignored' ? `/ws?token=${token()}` : '/ws',
      );
      expect((await client.closed).code).toBe(code);
      expect(client.messages).toEqual([]);
      expect(gateway.getClientCount()).toBe(0);
      expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
        token(),
      );
    },
  );

  it.each([
    ['missing session', undefined, 4401],
    ['wrong user', { ...session(), userId: 'other' }, 4403],
    ['revoked', { ...session(), status: 'REVOKED' }, 4403],
    [
      'expired session',
      { ...session(), expiresAt: new Date('2000-01-01') },
      4401,
    ],
  ] as const)('rejects %s', async (_label, record, code) => {
    vi.mocked(repository.findSessionById).mockResolvedValueOnce(record);
    const client = connect();
    expect((await client.closed).code).toBe(code);
    expect(client.messages).toHaveLength(0);
  });

  it.each([
    ['missing user', undefined, 4401],
    ['inactive', { ...user(), status: 'INACTIVE' }, 4403],
    ['suspended', { ...user(), status: 'SUSPENDED' }, 4403],
    ['pending', { ...user(), status: 'PENDING' }, 4403],
    ['locked', { ...user(), lockedUntil: new Date('2099-01-01') }, 4403],
  ] as const)('rejects %s', async (_label, record, code) => {
    vi.mocked(repository.findUserById).mockResolvedValueOnce(record);
    const client = connect();
    expect((await client.closed).code).toBe(code);
  });

  it('maps authentication dependency failures to retryable 1013 without leaking details', async () => {
    vi.mocked(repository.findSessionById).mockRejectedValueOnce(
      new Error('password=private-value'),
    );
    const client = connect();
    expect(await client.closed).toEqual({
      code: 1013,
      reason: '鉴权服务暂时不可用',
    });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(
      'private-value',
    );
  });

  it('isolates targeted messages across users and fans out to multiple sessions of the same user', async () => {
    const one = connect();
    const two = connect();
    const other = connect({ authorization: `Bearer ${token('other')}` });
    await Promise.all([one.first, two.first, other.first]);
    gateway.sendTaskProgress('task-1', 50, 'half', 'u-25');
    gateway.sendTaskComplete(
      'task-1',
      '/api/v1/tasks/t/file',
      'report.csv',
      'u-25',
    );
    gateway.sendTaskError('task-2', '失败', 'u-25');
    gateway.sendTaskCancelled('task-3', undefined, 'u-25');
    gateway.sendStatsUpdate({ data: { groups: 1 } });
    await vi.waitFor(() => expect(other.messages).toHaveLength(2));
    expect(one.messages.map((message) => message.type)).toEqual([
      'connected',
      'task_progress',
      'task_complete',
      'task_error',
      'task_cancelled',
      'stats_update',
    ]);
    expect(two.messages).toEqual(one.messages);
    expect(other.messages.map((message) => message.type)).toEqual([
      'connected',
      'stats_update',
    ]);
    expect(one.messages[1]).toMatchObject({
      timestamp: expect.stringMatching(/\+08:00$/),
    });
    one.socket.close();
    await one.closed;
    await vi.waitFor(() => expect(gateway.getClientCount()).toBe(2));
  });

  it('broadcasts monitor and task helper payloads through the shared message contracts', async () => {
    const client = connect();
    await client.first;
    gateway.sendMonitorProgress({
      status: 'started',
      countries: ['US'],
      timestamp: 'now',
    });
    gateway.sendMonitorComplete({
      success: true,
      totalChecked: 1,
      totalBroken: 0,
      totalNormal: 1,
      duration: 1,
      countryResults: {},
      timestamp: 'now',
    });
    gateway.sendTaskCancelled('t-1');
    gateway.broadcast({
      type: 'task_progress',
      taskId: 'invalid',
      progress: 101,
      message: 'invalid',
      timestamp: 'now',
    });
    gateway.sendStatsUpdate({});
    await vi.waitFor(() => expect(client.messages).toHaveLength(5));
    expect(client.messages.map((message) => message.type)).toEqual([
      'connected',
      'monitor_progress',
      'monitor_complete',
      'task_cancelled',
      'stats_update',
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      'WebSocket 可恢复连接异常',
      'WebSocketService',
      { reason: 'invalid_event' },
    );
  });

  it('does not expose broadcasts during async authentication and cleans up an early disconnect', async () => {
    let resolve!: (value: AuthSessionRecord) => void;
    vi.mocked(repository.findSessionById).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = connect();
    await vi.waitFor(() =>
      expect(repository.findSessionById).toHaveBeenCalled(),
    );
    gateway.sendStatsUpdate({ data: 'private' });
    expect(gateway.getClientCount()).toBe(0);
    pending.socket.close();
    await pending.closed;
    resolve(session());
    await vi.waitFor(() => expect(repository.findUserById).toHaveBeenCalled());
    expect(gateway.getClientCount()).toBe(0);
    expect(pending.messages).toEqual([]);
  });

  it('rejects oversized inbound messages with protocol 1009', async () => {
    const client = connect();
    await client.first;
    client.socket.send('x'.repeat(4097));
    expect((await client.closed).code).toBe(1009);
  });

  it('bounds pending authentication before accepting further upgrade requests', async () => {
    let release!: (value: AuthSessionRecord) => void;
    vi.mocked(repository.findSessionById).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    for (let i = 0; i < 64; i++) connect();
    await vi.waitFor(() =>
      expect(repository.findSessionById).toHaveBeenCalledTimes(64),
    );
    const overflow = connect();
    expect(await overflow.rejected).toBe(503);
    expect(repository.findSessionById).toHaveBeenCalledTimes(64);
    release(session());
    await vi.waitFor(() => expect(gateway.getClientCount()).toBe(64));
  });

  it('bounds total sockets before HTTP upgrade', async () => {
    vi.spyOn(gateway['wss']!.clients, 'size', 'get').mockReturnValue(1000);
    const overflow = connect();
    expect(await overflow.rejected).toBe(503);
    expect(repository.findSessionById).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('closes stalled authentication after its deadline and never registers a late result', async () => {
    let release!: (value: AuthSessionRecord) => void;
    vi.mocked(repository.findSessionById).mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const stalled = connect();
    expect((await stalled.closed).code).toBe(1013);
    release(session());
    await vi.waitFor(() => expect(repository.findUserById).toHaveBeenCalled());
    expect(gateway.getClientCount()).toBe(0);
    expect(stalled.messages).toHaveLength(0);
  }, 10_000);

  it('limits client message bursts', async () => {
    const client = connect();
    await client.first;
    for (let i = 0; i < 11; i++)
      client.socket.send(JSON.stringify({ type: 'ping' }));
    expect((await client.closed).code).toBe(1008);
  });

  it('closes slow readers without buffering unbounded output', async () => {
    const client = connect();
    await client.first;
    const serverSocket = [...gateway['wss']!.clients][0]!;
    vi.spyOn(serverSocket, 'bufferedAmount', 'get').mockReturnValue(
      1024 * 1024,
    );
    gateway.sendStatsUpdate({ data: 'some data' });
    expect((await client.closed).code).toBe(1013);
    expect(gateway.getClientCount()).toBe(0);
  });

  it('shuts down established connections and releases the HTTP server', async () => {
    const client = connect();
    await client.first;
    await app.close();
    expect((await client.closed).code).toBe(1001);
    expect(gateway.getClientCount()).toBe(0);
  });

  it('does not accept a duplicated API prefix as a websocket route', async () => {
    const client = connect(undefined, '/api/v1/ws');
    expect(await client.rejected).toBe(400);
  });
});

it('local event bus preserves targeted audience and supports unsubscribing', () => {
  const bus = new LocalWebSocketEventBus();
  const listener = vi.fn();
  const unsubscribe = bus.subscribe(listener);
  const event = {
    audience: 'user',
    userId: 'u-25',
    message: { type: 'pong' },
  } as const;
  bus.publish(event);
  expect(listener).toHaveBeenCalledWith(event);
  unsubscribe();
  bus.publish(event);
  expect(listener).toHaveBeenCalledOnce();
});

it('AppModule resolves websocket dependencies without opening network listeners', async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(AppLogger)
    .useValue(makeLogger())
    .compile();
  expect(moduleRef.get(WebSocketService)).toBeInstanceOf(WebSocketService);
  await moduleRef.close();
});
