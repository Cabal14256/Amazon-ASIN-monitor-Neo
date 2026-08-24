import { Global, Module } from '@nestjs/common';

import { loadEnv, loadEnvironmentFiles, type Env } from '@asin-monitor/config';

export const ENV = Symbol('ENV');

/**
 * 全局配置模块：进程启动时用 zod 校验环境变量（fail-fast）。
 */
@Global()
@Module({
  providers: [
    {
      provide: ENV,
      useFactory: (): Env => {
        loadEnvironmentFiles();
        return loadEnv();
      },
    },
  ],
  exports: [ENV],
})
export class ConfigModule {}
