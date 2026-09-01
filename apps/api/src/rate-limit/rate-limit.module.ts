import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { AuthModule } from '../auth/auth.module';
import { MetricsModule } from '../metrics/metrics.module';
import { RedisModule } from '../redis/redis.module';
import {
  RateLimitRequestHook,
  StrictRateLimitInterceptor,
} from './rate-limit.interceptor';
import { RateLimitService } from './rate-limit.service';

@Global()
@Module({
  imports: [AuthModule, MetricsModule, RedisModule],
  providers: [
    RateLimitService,
    RateLimitRequestHook,
    {
      provide: APP_INTERCEPTOR,
      useClass: StrictRateLimitInterceptor,
    },
  ],
  exports: [RateLimitRequestHook, RateLimitService],
})
export class RateLimitModule {}
