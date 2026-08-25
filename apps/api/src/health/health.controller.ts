import { Controller, Get } from '@nestjs/common';

/**
 * 健康检查占位（P2-T1 将补齐：双 DB 池 / 限流 / 缓存 / 错误统计，字段对齐旧 /health）。
 * 旧系统同时暴露根级 /health 与 /api/v1/health，此处同样注册两条路由。
 */
@Controller()
export class HealthController {
  @Get(['health', 'api/v1/health'])
  getHealth() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}
