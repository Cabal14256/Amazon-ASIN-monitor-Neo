import type { Env } from '@asin-monitor/config';
import {
  WS_CLOSE_CODES,
  wsClientMessageSchema,
  wsMessageSchema,
  type WsMessage,
} from '@asin-monitor/contracts';
import fastifyCookie from '@fastify/cookie';
import {
  HttpException,
  Inject,
  Injectable,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { AuthenticationService } from '../auth/authentication.service';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import {
  WS_EVENT_BUS,
  type WebSocketEvent,
  type WebSocketEventBus,
} from './websocket-events';

const MAX_CONNECTIONS = 1000;
const MAX_AUTH_PENDING = 64;
const MAX_BUFFER_BYTES = 1024 * 1024;
const timestamp = () =>
  new Date(Date.now() + 8 * 3600_000).toISOString().replace('Z', '+08:00');

@Injectable()
export class WebSocketService implements OnModuleDestroy {
  private wss?: WebSocketServer;
  private readonly users = new Map<WebSocket, string>();
  private authPending = 0;
  private closing = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private lastWarning = -Infinity;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(AuthenticationService) private readonly auth: AuthenticationService,
    @Inject(WS_EVENT_BUS) private readonly events: WebSocketEventBus,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  init(server: Server): void {
    if (this.wss || this.closing)
      throw new Error('WebSocket service already initialized or closed');
    const wss = new WebSocketServer({
      server,
      path: '/ws',
      maxPayload: 4096,
      perMessageDeflate: false,
      verifyClient: (_info, done) => {
        const available =
          !this.closing &&
          this.wss!.clients.size < MAX_CONNECTIONS &&
          this.authPending < MAX_AUTH_PENDING;
        done(available, available ? undefined : 503);
      },
    });
    this.wss = wss;
    this.unsubscribe = this.events.subscribe((event) => this.deliver(event));
    const alive = new WeakSet<WebSocket>();
    wss.on('connection', (socket, request) => {
      alive.add(socket);
      socket.on('pong', () => alive.add(socket));
      socket.on('error', () => {
        this.users.delete(socket);
        this.warn('connection_error');
        socket.terminate();
      });
      socket.once('close', () => this.users.delete(socket));
      let windowStart = Date.now();
      let count = 0;
      socket.on('message', (raw, binary) => {
        if (!this.users.has(socket) || socket.readyState !== WebSocket.OPEN)
          return;
        if (Date.now() - windowStart >= 1000) {
          windowStart = Date.now();
          count = 0;
        }
        if (++count > 10) {
          socket.close(1008, '消息频率超限');
          return;
        }
        if (binary) return;
        try {
          if (
            wsClientMessageSchema.safeParse(JSON.parse(raw.toString())).success
          )
            this.send(socket, JSON.stringify({ type: 'pong' }));
        } catch {
          /* 无效或未知上行消息不执行任何业务操作。 */
        }
      });
      void this.accept(socket, request);
    });
    wss.on('error', () => this.warn('server_error'));
    this.heartbeat = setInterval(() => {
      for (const socket of wss.clients) {
        if (!alive.has(socket)) {
          socket.terminate();
          continue;
        }
        alive.delete(socket);
        if (socket.readyState === WebSocket.OPEN) socket.ping();
      }
    }, 30_000);
    this.heartbeat.unref();
    this.logger.info('WebSocket 网关已启动', 'WebSocketService', {
      path: '/ws',
      transport: 'local',
    });
  }

  private async accept(
    socket: WebSocket,
    request: IncomingMessage,
  ): Promise<void> {
    if (
      this.closing ||
      this.wss!.clients.size > MAX_CONNECTIONS ||
      this.authPending >= MAX_AUTH_PENDING
    ) {
      socket.close(1013, '服务繁忙，请稍后重试');
      return;
    }
    // 浏览器 Cookie 握手不能依赖 HTTP CORS；有 Origin 时必须与前端来源完全一致。
    if (
      request.headers.origin !== undefined &&
      request.headers.origin !== this.allowedOrigin()
    ) {
      socket.close(WS_CLOSE_CODES.FORBIDDEN, '不允许的连接来源');
      return;
    }
    const timeout = setTimeout(
      () => socket.close(1013, '鉴权服务暂时不可用'),
      5000,
    );
    const clearDeadline = () => clearTimeout(timeout);
    socket.once('close', clearDeadline);
    this.authPending += 1;
    try {
      const cookies = fastifyCookie.parse(request.headers.cookie ?? '');
      const header = request.headers.authorization;
      const token =
        cookies[this.env.AUTH_COOKIE_NAME] ||
        (header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined);
      const principal = await this.auth.authenticateToken(token);
      if (this.closing || socket.readyState !== WebSocket.OPEN) return;
      this.users.set(socket, principal.userId);
      this.send(
        socket,
        JSON.stringify({ type: 'connected', message: 'WebSocket连接成功' }),
      );
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 503;
      const code =
        status === 401
          ? WS_CLOSE_CODES.UNAUTHORIZED
          : status === 403
          ? WS_CLOSE_CODES.FORBIDDEN
          : 1013;
      const response =
        error instanceof HttpException ? error.getResponse() : null;
      const reason =
        status < 500 &&
        response &&
        typeof response === 'object' &&
        'errorMessage' in response &&
        typeof response.errorMessage === 'string'
          ? response.errorMessage
          : '鉴权服务暂时不可用';
      socket.close(code, reason);
      this.warn(status >= 500 ? 'auth_dependency_error' : 'auth_rejected');
    } finally {
      clearTimeout(timeout);
      socket.removeListener('close', clearDeadline);
      this.authPending -= 1;
    }
  }

  private allowedOrigin(): string | undefined {
    try {
      const origin = new URL(this.env.CORS_ORIGIN);
      return ['http:', 'https:'].includes(origin.protocol)
        ? origin.origin
        : undefined;
    } catch {
      return undefined;
    }
  }

  private warn(reason: string): void {
    if (Date.now() - this.lastWarning < 60_000) return;
    this.lastWarning = Date.now();
    this.logger.warn('WebSocket 可恢复连接异常', 'WebSocketService', {
      reason,
    });
  }

  private send(socket: WebSocket, message: string): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount + Buffer.byteLength(message) > MAX_BUFFER_BYTES) {
      this.users.delete(socket);
      socket.close(1013, '客户端处理过慢');
      return;
    }
    try {
      socket.send(message, (error) => {
        if (error) {
          this.warn('send_error');
          socket.terminate();
        }
      });
    } catch {
      this.warn('send_error');
      socket.terminate();
    }
  }

  private deliver(event: WebSocketEvent): void {
    const result = wsMessageSchema.safeParse(event.message);
    if (
      !result.success ||
      (event.audience !== 'all' && event.audience !== 'user')
    ) {
      this.warn('invalid_event');
      return;
    }
    const message = JSON.stringify(result.data);
    if (Buffer.byteLength(message) > MAX_BUFFER_BYTES) {
      this.warn('oversized_event');
      return;
    }
    for (const [socket, userId] of this.users) {
      if (
        event.audience === 'all' ||
        (typeof event.userId === 'string' && event.userId === userId)
      )
        this.send(socket, message);
    }
  }

  broadcast(message: WsMessage): void {
    this.events.publish({ audience: 'all', message });
  }
  broadcastToUser(userId: string, message: WsMessage): void {
    if (!userId) return;
    this.events.publish({ audience: 'user', userId, message });
  }
  getClientCount(): number {
    return this.users.size;
  }
  sendMonitorProgress(
    data: Omit<Extract<WsMessage, { type: 'monitor_progress' }>, 'type'>,
  ): void {
    this.broadcast({ ...data, type: 'monitor_progress' } as WsMessage);
  }
  sendMonitorComplete(
    data: Omit<Extract<WsMessage, { type: 'monitor_complete' }>, 'type'>,
  ): void {
    this.broadcast({ ...data, type: 'monitor_complete' } as WsMessage);
  }
  sendStatsUpdate(
    data: Omit<Extract<WsMessage, { type: 'stats_update' }>, 'type'>,
  ): void {
    this.broadcast({ ...data, type: 'stats_update' });
  }
  private task(message: WsMessage, userId?: string | null): void {
    if (userId) this.broadcastToUser(userId, message);
    else this.broadcast(message);
  }
  sendTaskProgress(
    taskId: string,
    progress: number,
    message: string,
    userId?: string | null,
  ): void {
    this.task(
      {
        type: 'task_progress',
        taskId,
        progress,
        message,
        timestamp: timestamp(),
      },
      userId,
    );
  }
  sendTaskComplete(
    taskId: string,
    downloadUrl: string | null,
    filename: string | null,
    userId?: string | null,
  ): void {
    this.task(
      {
        type: 'task_complete',
        taskId,
        downloadUrl,
        filename,
        timestamp: timestamp(),
      },
      userId,
    );
  }
  sendTaskError(taskId: string, error: string, userId?: string | null): void {
    this.task(
      { type: 'task_error', taskId, error, timestamp: timestamp() },
      userId,
    );
  }
  sendTaskCancelled(
    taskId: string,
    message = '任务已取消',
    userId?: string | null,
  ): void {
    this.task(
      { type: 'task_cancelled', taskId, message, timestamp: timestamp() },
      userId,
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.unsubscribe?.();
    this.users.clear();
    const wss = this.wss;
    if (!wss) return;
    const force = setTimeout(() => {
      for (const socket of wss.clients) socket.terminate();
    }, 250);
    for (const socket of wss.clients) socket.close(1001, '服务关闭');
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    clearTimeout(force);
    this.wss = undefined;
  }
}
