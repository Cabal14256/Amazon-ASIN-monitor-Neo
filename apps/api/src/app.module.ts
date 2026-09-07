import { Module } from '@nestjs/common';

import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { LoggerModule } from './logger/logger.module';
import { MetricsModule } from './metrics/metrics.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { RedisModule } from './redis/redis.module';
import { RoleModule } from './roles/role.module';
import { UserQueryModule } from './users/user-query.module';
import { WebSocketModule } from './websocket/websocket.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    DatabaseModule,
    RedisModule,
    AuthModule,
    RoleModule,
    UserQueryModule,
    AuditModule,
    WebSocketModule,
    MetricsModule,
    RateLimitModule,
    HealthModule,
  ],
})
export class AppModule {}
