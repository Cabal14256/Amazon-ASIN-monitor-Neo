import { AppLogger } from './logger/app-logger.service';

/** 捕获 API 启动失败，统一经脱敏 logger 记录并以失败码退出。 */
export async function runApi(
  bootstrap: () => Promise<void>,
  logger: AppLogger = new AppLogger(),
  exit: (code: number) => unknown = (code) => process.exit(code),
): Promise<void> {
  try {
    await bootstrap();
  } catch (error) {
    logger.error('API 启动失败', 'Bootstrap', error);
    exit(1);
  }
}
