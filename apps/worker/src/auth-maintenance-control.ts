import { loadEnv, loadEnvironmentFiles } from '@asin-monitor/config';
import { Queue } from 'bullmq';
import {
  AUTH_MAINTENANCE_QUEUE,
  removeAuthMaintenanceSchedules,
} from './auth-maintenance-schedules';
import { logger } from './logger';
import { getNeoQueuePrefix } from './queue-policy';
import { getWatchdogRedisOptions, parseRedisUrl } from './redis-options';
import { runWorker } from './runner';

/** Stop all scheduler producers before stop; restart an enabled one after resume. */
export async function controlAuthMaintenance(
  command: string | undefined,
  queue: Pick<Queue, 'pause' | 'resume' | 'removeJobScheduler'>,
) {
  if (command === 'stop') {
    // Pause is durable and takes effect across consumers. Active transactions
    // finish normally; removing schedules alone would leave waiting work runnable.
    await queue.pause();
    await removeAuthMaintenanceSchedules(queue);
  } else if (command === 'resume') {
    await queue.resume();
  } else {
    throw new Error('Expected maintenance command: stop or resume');
  }
}

async function main() {
  const command = process.argv[2];
  if (!['stop', 'resume'].includes(command ?? '') || process.argv.length !== 3)
    throw new Error('Expected maintenance command: stop or resume');
  loadEnvironmentFiles();
  const env = loadEnv();
  if (env.AUTH_DATA_AUTHORITY !== 'postgresql')
    throw new Error('Authentication maintenance requires PostgreSQL authority');
  const queue = new Queue(AUTH_MAINTENANCE_QUEUE, {
    prefix: getNeoQueuePrefix(env),
    connection: {
      ...getWatchdogRedisOptions(parseRedisUrl(env.REDIS_URL)),
      connectTimeout: 2000,
    },
  });
  queue.on('error', () =>
    logger.warn('认证维护控制连接异常', {
      reason: 'maintenance_control_error',
    }),
  );
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await queue.waitUntilReady();
        await controlAuthMaintenance(command, queue);
      })(),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error('Control timeout')),
          20_000,
        );
      }),
    ]);
    logger.info('认证维护队列控制完成', { command });
  } catch {
    throw new Error('Authentication maintenance control failed');
  } finally {
    if (deadline) clearTimeout(deadline);
    await queue.close();
  }
}

if (require.main === module) void runWorker(main);
