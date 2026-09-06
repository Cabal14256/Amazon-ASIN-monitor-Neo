import { AuditRepository } from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { LoggerModule } from '../logger/logger.module';
import { AuditInterceptor } from './audit.interceptor';
import { AUDIT_REPOSITORY, AuditService } from './audit.service';

@Module({
  imports: [DatabaseModule, LoggerModule],
  providers: [
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
