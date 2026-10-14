import { PgBackupConfigRepository } from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { TaskQueryModule } from '../tasks/task-query.module';
import { BackupController } from './backup.controller';
import { BACKUP_CONFIG_REPOSITORY, BackupService } from './backup.service';

@Module({
  imports: [AuthModule, DatabaseModule, TaskQueryModule],
  controllers: [BackupController],
  providers: [
    BackupService,
    {
      provide: BACKUP_CONFIG_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgBackupConfigRepository(pools.primaryPool),
    },
  ],
})
export class BackupModule {}
