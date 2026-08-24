/**
 * 全局日志模块。
 * 语义对齐旧系统 server/src/utils/logger.js 与 AGENTS.md 日志规范：
 * - 级别 DEBUG/INFO/WARN/ERROR，LOG_LEVEL 控制（默认 INFO）
 * - 敏感字段脱敏（password/token/secret/authorization 等）
 * - 服务端代码一律注入 AppLogger，禁止直接使用 console.*
 */
import { Global, Module } from '@nestjs/common';

import { AppLogger } from './app-logger.service';

@Global()
@Module({
  providers: [AppLogger],
  exports: [AppLogger],
})
export class LoggerModule {}
