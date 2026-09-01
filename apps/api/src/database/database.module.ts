import { Global, Module } from '@nestjs/common';

import { ConfigModule } from '../config/config.module';
import { LoggerModule } from '../logger/logger.module';
import { ApplicationDatabasePools } from './database.service';

@Global()
@Module({
  imports: [ConfigModule, LoggerModule],
  providers: [ApplicationDatabasePools],
  exports: [ApplicationDatabasePools],
})
export class DatabaseModule {}
