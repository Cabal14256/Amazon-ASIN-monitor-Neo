import type { Env } from '@asin-monitor/config';
import type {
  SpApiConfigurationRepositoryPort,
  SpApiConfigurationRow,
} from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { authorizeAdministration } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import {
  displaySpApiConfigs,
  isManagedSpApiKey,
  isSensitiveSpApiKey,
  normalizeSpApiConfigUpdates,
  SpApiConfigInputError,
} from './sp-api-config-values';

export const SP_API_CONFIG_REPOSITORY = Symbol('SP_API_CONFIG_REPOSITORY');
export const SP_API_CONFIG_ENV = Symbol('SP_API_CONFIG_ENV');
function fail(status: number, errorMessage: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage },
    status,
  );
}
function publicRecord(row: SpApiConfigurationRow) {
  return {
    id: row.id,
    config_key: row.configKey,
    config_value: row.configValue,
    description: row.description,
    create_time: row.createTime?.toISOString() ?? null,
    update_time: row.updateTime?.toISOString() ?? null,
  };
}

@Injectable()
export class SpApiConfigService {
  private active = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(SP_API_CONFIG_ENV)
    private readonly configEnv: Readonly<Record<string, unknown>>,
    @Inject(SP_API_CONFIG_REPOSITORY)
    private readonly repository: SpApiConfigurationRepositoryPort,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  private async run<T>(
    operation: 'list' | 'detail' | 'update',
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有配置管理入口');
    if (this.active >= 8) fail(429, '配置管理请求繁忙，请稍后再试');
    this.active++;
    try {
      return await action();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof SpApiConfigInputError) fail(400, '配置参数无效');
      this.logger.error('SP-API 配置管理请求失败', 'SpApiConfigService', {
        operation,
        reason: 'configuration_operation_failed',
      });
      return fail(500, '配置管理请求失败');
    } finally {
      this.active--;
    }
  }
  list(principal: AuthPrincipal) {
    return this.run('list', () =>
      this.repository.transaction(async (unit) => {
        await authorizeAdministration(unit, principal, 'settings:read');
        const revealSensitive = (
          await unit.operatorPermissionCodes(principal.userId)
        ).includes('settings:write');
        return displaySpApiConfigs(
          await unit.listConfiguration(),
          this.configEnv,
          revealSensitive,
        );
      }),
    );
  }
  detail(principal: AuthPrincipal, rawKey: string) {
    return this.run('detail', () =>
      this.repository.transaction(async (unit) => {
        await authorizeAdministration(unit, principal, 'settings:read');
        if (!/^[a-zA-Z0-9_]{1,50}$/.test(rawKey)) fail(400, '配置键格式无效');
        const key = rawKey.toUpperCase();
        if (!isManagedSpApiKey(key)) fail(404, '配置不存在');
        if (
          isSensitiveSpApiKey(key) &&
          !(await unit.operatorPermissionCodes(principal.userId)).includes(
            'settings:write',
          )
        )
          fail(403, '没有权限读取敏感配置');
        const row = await unit.findConfiguration(key);
        if (!row) fail(404, '配置不存在');
        return publicRecord(row);
      }),
    );
  }
  update(principal: AuthPrincipal, body: unknown) {
    return this.run('update', async () => {
      const changes = normalizeSpApiConfigUpdates(body);
      const rows = await this.repository.transaction(async (unit) => {
        await authorizeAdministration(unit, principal, 'settings:write');
        return (await unit.upsertConfiguration(changes)).map(publicRecord);
      });
      this.logger.info('SP-API 配置更新成功', 'SpApiConfigService', {
        count: changes.length,
      });
      return rows;
    });
  }
}
