import 'reflect-metadata';

import { loadEnv, loadEnvironmentFiles } from '@asin-monitor/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { startAsinBatchDeleteRuntime } from './asin-batch-delete-runtime';
import { startAsinImportRuntime } from './asin-import-runtime';
import { startAuthMaintenanceRuntime } from './auth-maintenance-runtime';
import {
  AUTH_MAINTENANCE_QUEUE,
  resolveWorkerSelection,
} from './auth-maintenance-schedules';
import { waitForShutdownSignal } from './idle';
import { logger } from './logger';
import { attachQueueErrorLogger, attachRedisErrorLogger } from './queue-events';
import { getNeoQueuePrefix, getQueueOptions } from './queue-policy';
import { getPhysicalQueueName } from './queues';
import { getWatchdogRedisOptions, parseRedisUrl } from './redis-options';
import { runWorker } from './runner';
import { shutdownWorker } from './shutdown';
import { createSingleFlightCheck, RedisWatchdog } from './watchdog';

/**
 * Worker 进程入口（PROCESS_ROLE=worker 角色）。
 * D4 认证维护、主营批量删除和导入已注册 Processor；其余业务队列继续逐域平移。
 * BullMQ 自管连接（传 ConnectionOptions），看门狗使用独立 ioredis 实例。
 */
async function bootstrap(): Promise<void> {
  loadEnvironmentFiles();
  const env = loadEnv();
  const {
    enabledQueues: enabled,
    unknownQueues,
    maintenance: selectedMaintenance,
  } = resolveWorkerSelection(env.WORKER_ENABLED_QUEUES);
  const enableMaintenance =
    selectedMaintenance && env.AUTH_DATA_AUTHORITY === 'postgresql';
  if (selectedMaintenance && !enableMaintenance)
    logger.info('认证维护未启用，当前认证权威源为 Legacy');

  if (unknownQueues.length > 0) {
    logger.warn('WORKER_ENABLED_QUEUES 包含未知队列名，已忽略', {
      unknownQueues,
    });
  }

  if (enabled.length === 0 && !enableMaintenance) {
    const stopped = waitForShutdownSignal();
    logger.info('Worker 未启用任何队列，跳过 Redis 连接与看门狗');
    const signal = await stopped;
    logger.info('空闲 Worker 收到停止信号', { signal });
    return;
  }

  const connection = parseRedisUrl(env.REDIS_URL);
  const maintenance = enableMaintenance
    ? await startAuthMaintenanceRuntime(env, () => process.exit(1))
    : undefined;
  const batchDelete =
    enabled.includes('batch-delete') && env.AUTH_DATA_AUTHORITY === 'postgresql'
      ? await startAsinBatchDeleteRuntime(env, () => process.exit(1))
      : undefined;
  const asinImport =
    enabled.includes('import') && env.AUTH_DATA_AUTHORITY === 'postgresql'
      ? await startAsinImportRuntime(env, () => process.exit(1))
      : undefined;

  const queues = enabled
    .filter((name) => !(batchDelete && name === 'batch-delete'))
    .filter((name) => !(asinImport && name === 'import'))
    .map((name) => {
      const physicalName = getPhysicalQueueName(name);
      const queue = new Queue(
        physicalName,
        getQueueOptions(name, env, connection),
      );
      attachQueueErrorLogger(queue, physicalName);
      return queue;
    });

  const watchdogRedis = new Redis(getWatchdogRedisOptions(connection));
  attachRedisErrorLogger(watchdogRedis, 'watchdog');
  const watchdog = new RedisWatchdog(watchdogRedis, {
    checks: [
      ...queues,
      ...(maintenance ? [maintenance.queue] : []),
      ...(batchDelete ? [batchDelete.queue] : []),
      ...(asinImport ? [asinImport.queue] : []),
    ].map((queue) => createSingleFlightCheck(() => queue.getJobCounts())),
  });
  watchdog.start(() => {
    logger.error('Redis 连续 60s 不健康，退出进程');
    process.exit(1);
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= shutdownWorker({
      watchdog,
      queues: [
        ...queues,
        ...(maintenance ? [maintenance] : []),
        ...(batchDelete ? [batchDelete] : []),
        ...(asinImport ? [asinImport] : []),
      ],
      watchdogRedis,
    });
    return shutdownPromise;
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // A supervisor may stop us immediately after observing this readiness log.
  logger.info('Worker 已启动', {
    mode:
      batchDelete || asinImport
        ? 'business-worker'
        : maintenance
        ? 'auth-maintenance'
        : 'queue-scaffold',
    registeredProcessors:
      Number(!!maintenance) + Number(!!batchDelete) + Number(!!asinImport),
    prefix: getNeoQueuePrefix(env),
    enabledQueues: enabled,
    physicalQueues: [
      ...enabled.map(getPhysicalQueueName),
      ...(maintenance ? [AUTH_MAINTENANCE_QUEUE] : []),
    ],
    queueCount:
      queues.length +
      Number(!!maintenance) +
      Number(!!batchDelete) +
      Number(!!asinImport),
    schedulerEnabled: !!maintenance && env.SCHEDULER_ENABLED,
  });
}

if (require.main === module) {
  void runWorker(bootstrap);
}
