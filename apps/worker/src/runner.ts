import { logger } from './logger';

/** 捕获启动失败，确保 Node 不会把带 input 字段的 URL 异常直接写到 stderr。 */
export async function runWorker(
  bootstrap: () => Promise<void>,
  exit: (code: number) => unknown = (code) => process.exit(code),
): Promise<void> {
  try {
    await bootstrap();
  } catch (error) {
    logger.error('Worker 启动失败', error);
    exit(1);
  }
}
