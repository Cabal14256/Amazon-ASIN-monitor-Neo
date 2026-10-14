import { getExportStorageDirectory, type Env } from '@asin-monitor/config';
import { ExportArtifactStore } from '@asin-monitor/export';
import { Inject, Injectable, Module } from '@nestjs/common';
import { ConfigModule, ENV } from '../config/config.module';

@Injectable()
export class ApplicationExportArtifacts extends ExportArtifactStore {
  constructor(@Inject(ENV) env: Env) {
    super(getExportStorageDirectory(env));
  }
}

@Module({
  imports: [ConfigModule],
  providers: [ApplicationExportArtifacts],
  exports: [ApplicationExportArtifacts],
})
export class ExportStorageModule {}
