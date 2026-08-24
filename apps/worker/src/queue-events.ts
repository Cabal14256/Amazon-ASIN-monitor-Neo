import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import { logger } from './logger';

/** BullMQ 的 error EventEmitter 事件必须被消费，否则 Node 会直接终止进程。 */
export function attachQueueErrorLogger(
  queue: Pick<Queue, 'on'>,
  physicalQueueName: string,
): void {
  queue.on('error', (error) => {
    logger.warn('BullMQ 队列连接异常，等待看门狗判定恢复', {
      queue: physicalQueueName,
      error,
    });
  });
}

/** 看门狗使用独立 ioredis；同样必须消费 error 事件并经 logger 输出。 */
export function attachRedisErrorLogger(
  redis: Pick<Redis, 'on'>,
  connectionName: string,
): void {
  redis.on('error', (error) => {
    logger.warn('Redis 连接异常，等待看门狗判定恢复', {
      connection: connectionName,
      error,
    });
  });
}
