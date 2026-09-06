import { PgRoleRepository } from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { RoleController } from './role.controller';
import { ROLE_REPOSITORY, RoleService } from './role.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [RoleController],
  providers: [
    RoleService,
    {
      provide: ROLE_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgRoleRepository(pools.primaryPool),
    },
  ],
})
export class RoleModule {}
