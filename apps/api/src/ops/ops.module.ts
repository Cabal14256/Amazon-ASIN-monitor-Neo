import { PgRoleRepository } from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { Queue, type ConnectionOptions } from 'bullmq';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { RedisModule } from '../redis/redis.module';
import { OpsController } from './ops.controller';
import {
  OPS_QUEUE_FACTORY,
  OPS_ROLE_REPOSITORY,
  OpsService,
} from './ops.service';

@Module({
  imports: [AuthModule, DatabaseModule, RedisModule],
  controllers: [OpsController],
  providers: [
    OpsService,
    {
      provide: OPS_ROLE_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgRoleRepository(pools.primaryPool),
    },
    {
      provide: OPS_QUEUE_FACTORY,
      useFactory:
        () =>
        (
          name: string,
          options: { connection: ConnectionOptions; prefix: string },
        ) =>
          new Queue(name, options),
    },
  ],
})
export class OpsModule {}
