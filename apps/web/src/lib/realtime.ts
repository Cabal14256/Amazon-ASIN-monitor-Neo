import {
  wsClientMessageSchema,
  wsMessageSchema,
  type WsClientMessage,
  type WsMessage,
} from '@asin-monitor/contracts';
import { resolveApiBaseURL } from './api-url';
import { ApiError } from './http';

export interface BrowserSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(value: string): void;
  close(): void;
}
export function webSocketURL(
  base: string | undefined,
  pageOrigin: string,
): string {
  try {
    const page = new URL(pageOrigin);
    const url = new URL(resolveApiBaseURL(base) || '/', page);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (page.protocol === 'https:' && url.protocol !== 'https:')
    )
      throw new Error();
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws`;
    return url.href;
  } catch {
    throw new ApiError('INVALID_INPUT', 'WebSocket 地址无效');
  }
}

type MessageHandler = (message: WsMessage) => void;
/** Browser transport only; connecting is explicit after current-user validation. */
export class RealtimeClient {
  private current?: BrowserSocket;
  private readonly live = new Set<BrowserSocket>();
  private readonly handlers = new Set<MessageHandler>();
  private retries = 0;
  private stopped = true;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly options: {
      url: string;
      hasSession: () => boolean;
      socket?: (url: string) => BrowserSocket;
      onAuthClose?: (code: 4401 | 4403) => void;
      diagnostic?: (
        code:
          | 'invalid_message'
          | 'subscriber_failed'
          | 'socket_error'
          | 'capacity',
      ) => void;
    },
  ) {}
  private report(
    code: Parameters<NonNullable<typeof this.options.diagnostic>>[0],
  ): void {
    try {
      this.options.diagnostic?.(code);
    } catch {
      /* Diagnostics cannot break transport lifecycle. */
    }
  }
  private clearTimers(): void {
    clearTimeout(this.retryTimer);
    clearTimeout(this.handshakeTimer);
    clearInterval(this.pingTimer);
    this.retryTimer = undefined;
    this.handshakeTimer = undefined;
    this.pingTimer = undefined;
  }
  private closeSocket(socket: BrowserSocket): void {
    try {
      socket.close();
    } catch {
      this.report('socket_error');
    }
  }
  connect(): boolean {
    if (this.current && [0, 1].includes(this.current.readyState)) return true;
    if (!this.options.hasSession()) return false;
    this.stopped = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.live.size >= 8) {
      this.report('capacity');
      return false;
    }
    let socket: BrowserSocket;
    try {
      socket = (this.options.socket ?? ((url) => new WebSocket(url)))(
        this.options.url,
      );
    } catch {
      this.report('socket_error');
      this.scheduleRetry();
      return false;
    }
    this.current = socket;
    this.live.add(socket);
    const active = () => this.current === socket && !this.stopped;
    this.handshakeTimer = setTimeout(() => {
      if (!active() || socket.readyState !== 0) return;
      this.current = undefined;
      this.closeSocket(socket);
      this.scheduleRetry();
    }, 10000);
    socket.onopen = () => {
      if (!active() || !this.options.hasSession()) {
        this.closeSocket(socket);
        return;
      }
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
      this.retries = 0;
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (!active()) return;
        if (!this.options.hasSession()) {
          this.disconnect();
          return;
        }
        this.send({ type: 'ping' });
      }, 30000);
    };
    socket.onmessage = (event) => {
      if (!active() || !this.options.hasSession()) return;
      let message: WsMessage;
      try {
        if (typeof event.data !== 'string' || event.data.length > 1024 * 1024)
          throw new Error();
        message = wsMessageSchema.parse(JSON.parse(event.data));
      } catch {
        this.report('invalid_message');
        return;
      }
      for (const handler of [...this.handlers]) {
        if (!active()) break;
        if (!this.handlers.has(handler)) continue;
        try {
          handler(message);
        } catch {
          this.report('subscriber_failed');
        }
      }
    };
    socket.onerror = () => {
      if (active()) this.report('socket_error');
    };
    socket.onclose = (event) => {
      this.live.delete(socket);
      if (!active()) return;
      this.current = undefined;
      this.clearTimers();
      if (event.code === 4401 || event.code === 4403) {
        this.stopped = true;
        try {
          this.options.onAuthClose?.(event.code);
        } catch {
          this.report('subscriber_failed');
        }
        return;
      }
      this.scheduleRetry();
    };
    return true;
  }
  private scheduleRetry(): void {
    if (
      this.stopped ||
      !this.options.hasSession() ||
      this.retryTimer ||
      this.retries >= 5
    )
      return;
    const delay = 1000 * 2 ** this.retries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
  }
  disconnect(): void {
    this.stopped = true;
    this.current = undefined;
    this.retries = 0;
    this.clearTimers();
    this.handlers.clear();
    for (const socket of this.live) this.closeSocket(socket);
  }
  send(message: WsClientMessage): boolean {
    if (
      !this.current ||
      this.stopped ||
      this.current.readyState !== 1 ||
      this.current.bufferedAmount > 65536
    )
      return false;
    const parsed = wsClientMessageSchema.safeParse(message);
    if (!parsed.success) return false;
    try {
      this.current.send(JSON.stringify(parsed.data));
      return true;
    } catch {
      this.report('socket_error');
      return false;
    }
  }
  onMessage(handler: MessageHandler): () => void {
    if (this.handlers.size >= 256)
      throw new ApiError('CAPACITY', 'WebSocket 订阅过多');
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
  getReadyState(): number {
    return this.current?.readyState ?? 3;
  }
  isConnected(): boolean {
    return this.current?.readyState === 1;
  }
}
