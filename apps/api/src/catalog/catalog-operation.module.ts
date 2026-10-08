import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { LoggerModule } from '../logger/logger.module';
import { ApplicationCatalogOperations } from './catalog-operation.service';

@Global()
@Module({
  imports: [DatabaseModule, LoggerModule],
  providers: [ApplicationCatalogOperations],
  exports: [ApplicationCatalogOperations],
})
export class CatalogOperationModule {}
