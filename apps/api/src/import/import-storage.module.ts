import { getImportStorageDirectory, type Env } from '@asin-monitor/config';
import { ImportFileStore, ImportResultStore } from '@asin-monitor/import';
import {
  Inject,
  Injectable,
  Module,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigModule, ENV } from '../config/config.module';

@Injectable()
export class ApplicationImportStorage
  extends ImportFileStore
  implements OnModuleDestroy
{
  constructor(@Inject(ENV) env: Env) {
    super(getImportStorageDirectory(env));
  }
  onModuleDestroy() {
    return this.close();
  }
}
@Injectable()
export class ApplicationImportResults extends ImportResultStore {
  constructor(@Inject(ENV) env: Env) {
    super(getImportStorageDirectory(env));
  }
}
@Module({
  imports: [ConfigModule],
  providers: [ApplicationImportStorage, ApplicationImportResults],
  exports: [ApplicationImportStorage, ApplicationImportResults],
})
export class ImportStorageModule {}
