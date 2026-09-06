import { AuditQueryRepository, AuditRepository } from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { LoggerModule } from '../logger/logger.module';
import { AuditQueryController } from './audit-query.controller';
import {
  AUDIT_QUERY_REPOSITORY,
  AuditQueryService,
} from './audit-query.service';
import { AuditInterceptor } from './audit.interceptor';
import { AUDIT_REPOSITORY, AuditService } from './audit.service';

@Module({
  imports: [AuthModule, DatabaseModule, LoggerModule],
  controllers: [AuditQueryController],
  providers: [
    {
      provide: AUDIT_QUERY_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new AuditQueryRepository(pools.primaryPool),
    },
    AuditQueryService,
    {
      provide: AUDIT_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new AuditRepository(pools.primaryPool),
    },
    AuditService,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditService],
})
export class AuditModule {}
