import type { Env } from '@asin-monitor/config';
import type { ImportRepositoryPort } from '@asin-monitor/db';
import { Inject, Injectable } from '@nestjs/common';
import { AsinImportService } from '../asin/asin-import.service';
import { ENV } from '../config/config.module';
import { ApplicationImportStorage } from '../import/import-storage.module';
import { AppLogger } from '../logger/app-logger.service';
import { TaskQueryRuntime } from '../tasks/task-query.runtime';

export const COMPETITOR_IMPORT_REPOSITORY = Symbol(
  'COMPETITOR_IMPORT_REPOSITORY',
);

@Injectable()
export class CompetitorImportService extends AsinImportService {
  constructor(
    @Inject(ENV) env: Env,
    @Inject(COMPETITOR_IMPORT_REPOSITORY) repository: ImportRepositoryPort,
    @Inject(ApplicationImportStorage) storage: ApplicationImportStorage,
    @Inject(TaskQueryRuntime) runtime: TaskQueryRuntime,
    @Inject(AppLogger) logger: AppLogger,
  ) {
    super(env, repository, storage, runtime, logger);
  }
  protected override get mode(): 'competitor' {
    return 'competitor';
  }
}
