import type { Env } from '@asin-monitor/config';
import {
  PgSpApiConfigurationRepository,
  type SpApiConfigurationRepositoryPort,
} from '@asin-monitor/db';
import { DatabaseConfigSource, SpApiError } from '@asin-monitor/sp-api';
import {
  Inject,
  Injectable,
  Module,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ENV } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { SP_API_MANAGED_KEYS, isManagedSpApiKey } from './sp-api-config-values';
import { SpApiConfigController } from './sp-api-config.controller';
import {
  SP_API_CONFIG_ENV,
  SP_API_CONFIG_REPOSITORY,
  SpApiConfigService,
} from './sp-api-config.service';

/** Host-owned source; future Amazon callers share this provider, never the UI's
 * redacted response. Database pools remain owned by ApplicationDatabasePools. */
@Injectable()
export class ApplicationSpApiConfigSource
  extends DatabaseConfigSource
  implements OnModuleDestroy
{
  constructor(
    @Inject(ENV) env: Env,
    @Inject(SP_API_CONFIG_ENV) configEnv: Readonly<Record<string, unknown>>,
    @Inject(SP_API_CONFIG_REPOSITORY)
    repository: SpApiConfigurationRepositoryPort,
  ) {
    super(configEnv, async (signal) => {
      if (env.AUTH_DATA_AUTHORITY !== 'postgresql')
        throw new SpApiError('DEPENDENCY_ERROR');
      const rows = await repository.readConfiguration(signal);
      return Object.fromEntries(
        rows
          .filter((row) => isManagedSpApiKey(row.configKey.toUpperCase()))
          .map((row) => [row.configKey.toUpperCase(), row.configValue]),
      );
    });
  }
  onModuleDestroy() {
    this.close();
  }
}

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [SpApiConfigController],
  providers: [
    SpApiConfigService,
    ApplicationSpApiConfigSource,
    {
      provide: SP_API_CONFIG_ENV,
      // ENV must finish loading environment files before the restricted snapshot.
      inject: [ENV],
      useFactory: (_env: Env) =>
        Object.freeze(
          Object.fromEntries(
            SP_API_MANAGED_KEYS.filter(
              (key) => process.env[key] !== undefined,
            ).map((key) => [key, process.env[key]]),
          ),
        ),
    },
    {
      provide: SP_API_CONFIG_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgSpApiConfigurationRepository(pools.primaryPool),
    },
  ],
  exports: [ApplicationSpApiConfigSource],
})
export class SpApiConfigModule {}
