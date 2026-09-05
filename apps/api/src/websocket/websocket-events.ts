import type { WsMessage } from '@asin-monitor/contracts';
import { Injectable } from '@nestjs/common';

export type WebSocketEvent =
  | { audience: 'all'; message: WsMessage }
  | { audience: 'user'; userId: string; message: WsMessage };
export const WS_EVENT_BUS = Symbol('WS_EVENT_BUS');

/** Redis Pub/Sub 可替换此接口；远端实现必须保留 audience/userId 并校验载荷。 */
export interface WebSocketEventBus {
  publish(event: WebSocketEvent): void;
  subscribe(listener: (event: WebSocketEvent) => void): () => void;
}

/** 仅进程内广播，不保证重放或跨 API/Worker 进程传递。 */
@Injectable()
export class LocalWebSocketEventBus implements WebSocketEventBus {
  private readonly listeners = new Set<(event: WebSocketEvent) => void>();

  publish(event: WebSocketEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: (event: WebSocketEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
