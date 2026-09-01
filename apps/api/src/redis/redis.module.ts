import { Global, Module } from '@nestjs/common';

import { ConfigModule } from '../config/config.module';
import { LoggerModule } from '../logger/logger.module';
import { ApplicationRedisClient } from './redis.service';

@Global()
@Module({
  imports: [ConfigModule, LoggerModule],
  providers: [ApplicationRedisClient],
  exports: [ApplicationRedisClient],
})
export class RedisModule {}
