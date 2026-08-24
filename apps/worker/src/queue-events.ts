import type { Queue } from 'bullmq';

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
