import type { Queue } from 'bullmq';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  attachQueueErrorLogger,
  attachRedisErrorLogger,
} from '../src/queue-events';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BullMQ Queue error 事件', () => {
  it('消费错误事件并以 warn 记录最小上下文', () => {
    const queue = new EventEmitter();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failure = Object.assign(new Error('connect ECONNREFUSED'), {
      input: 'redis://user:secret@host',
    });

    attachQueueErrorLogger(queue as unknown as Pick<Queue, 'on'>, 'queue-1');
    expect(() => queue.emit('error', failure)).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      '[WARN] [worker]',
      'BullMQ 队列连接异常，等待看门狗判定恢复',
      {
        queue: 'queue-1',
        error: { name: 'Error', message: 'connect ECONNREFUSED' },
      },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('user:secret');
  });

  it('看门狗 ioredis error 同样经 warn logger 消费', () => {
    const redis = new EventEmitter();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    attachRedisErrorLogger(
      redis as unknown as Parameters<typeof attachRedisErrorLogger>[0],
      'watchdog',
    );
    expect(() => redis.emit('error', new Error('socket closed'))).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      '[WARN] [worker]',
      'Redis 连接异常，等待看门狗判定恢复',
      {
        connection: 'watchdog',
        error: { name: 'Error', message: 'socket closed' },
      },
    );
  });
});
