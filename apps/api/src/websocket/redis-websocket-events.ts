import type { Env } from '@asin-monitor/config';
import { RedisTaskRepository, taskNotificationChannel } from '@asin-monitor/db';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { TaskNotificationConsumer } from './task-notification-consumer';
import {
  LocalWebSocketEventBus,
  type WebSocketEvent,
} from './websocket-events';

/** Lazily starts with the gateway, with separate subscriber and metadata connections. */
@Injectable()
export class RedisWebSocketEventBus
  extends LocalWebSocketEventBus
  implements OnModuleDestroy
{
  private subscriber?: Redis;
  private reader?: Redis;
  private consumer?: TaskNotificationConsumer;
  private closed = false;
  private lastWarning = -Infinity;
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly readyTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    super();
  }

  override subscribe(listener: (event: WebSocketEvent) => void): () => void {
    if (this.closed) throw new Error('TASK_EVENT_BUS_CLOSED');
    const unsubscribe = super.subscribe(listener);
    if (!this.subscriber) this.start();
    return unsubscribe;
  }

  private warn = (reason: string) => {
    if (Date.now() - this.lastWarning < 60_000) return;
    this.lastWarning = Date.now();
    this.logger.warn(
      '任务实时通知暂不可用，请通过任务查询恢复状态',
      'RedisWebSocketEventBus',
      { reason },
    );
  };

  private start(): void {
    const options = {
      lazyConnect: true,
      connectTimeout: 1000,
      commandTimeout: 1000,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      autoResubscribe: false,
      maxLoadingRetryTime: 1000,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt: number) => Math.min(200 * attempt, 1000),
    };
    const reader = (this.reader = new Redis(this.env.REDIS_URL, options));
    const subscriber = (this.subscriber = new Redis(
      this.env.REDIS_URL,
      options,
    ));
    const store = new RedisTaskRepository(reader, this.env);
    const consumer = (this.consumer = new TaskNotificationConsumer(
      async (id) => {
        try {
          return await store.read(id);
        } catch (error) {
          // A timed-out command can remain in ioredis's wire queue until its
          // response arrives. Reset the socket instead of accumulating stale GETs.
          if (!this.closed && reader.status === 'ready')
            reader.disconnect(true);
          throw error;
        }
      },
      (event) => super.publish(event),
      this.warn,
    ));
    const channel = taskNotificationChannel(this.env.BULL_PREFIX);
    for (const connection of [reader, subscriber]) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clearReadyDeadline = () => {
        if (timer) {
          clearTimeout(timer);
          this.readyTimers.delete(timer);
          timer = undefined;
        }
      };
      connection.on('connect', () => {
        clearReadyDeadline();
        timer = setTimeout(() => {
          clearReadyDeadline();
          if (!this.closed && connection.status !== 'ready') {
            this.warn('task_notification_ready_timeout');
            connection.disconnect(true);
          }
        }, 3000);
        timer.unref();
        this.readyTimers.add(timer);
      });
      connection.on('ready', clearReadyDeadline);
      connection.on('error', () =>
        this.warn('task_notification_connection_error'),
      );
      connection.on('close', () => {
        clearReadyDeadline();
        consumer.disconnected();
      });
    }
    subscriber.on('ready', () => {
      if (this.closed) return;
      void subscriber
        .subscribe(channel)
        .then(() => {
          if (!this.closed)
            this.logger.info(
              '任务实时通知订阅已连接',
              'RedisWebSocketEventBus',
            );
        })
        .catch(() => {
          this.warn('task_notification_subscribe_failed');
          if (!this.closed) subscriber.disconnect(true);
        });
    });
    subscriber.on('message', (received: string, raw: string) => {
      if (!this.closed && received === channel) consumer.receive(raw);
    });
    this.heartbeat = setInterval(() => {
      for (const connection of [reader, subscriber]) {
        if (this.closed || connection.status !== 'ready') continue;
        void connection.ping().catch(() => {
          if (this.closed) return;
          this.warn('task_notification_heartbeat_failed');
          connection.disconnect(true);
        });
      }
    }, 15_000);
    this.heartbeat.unref();
    for (const connection of [reader, subscriber])
      void connection
        .connect()
        .catch(() => this.warn('task_notification_connect_failed'));
  }

  onModuleDestroy(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const timer of this.readyTimers) clearTimeout(timer);
    this.readyTimers.clear();
    this.consumer?.stop();
    this.subscriber?.disconnect(false);
    this.reader?.disconnect(false);
  }
}
