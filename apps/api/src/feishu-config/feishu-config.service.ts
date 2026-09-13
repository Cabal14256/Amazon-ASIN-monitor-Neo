import type { Env } from '@asin-monitor/config';
import {
  displayFeishuConfiguration,
  feishuConfigurationChange,
  FeishuConfigurationError,
  feishuCountry,
  feishuEnabled,
  type FeishuConfigurationRepositoryPort,
  type FeishuConfigurationUnit,
} from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { authorizeAdministration } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';

export const FEISHU_CONFIGURATION_REPOSITORY = Symbol(
  'FEISHU_CONFIGURATION_REPOSITORY',
);
function fail(status: number, errorMessage: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage },
    status,
  );
}
function enabledValue(body: unknown) {
  try {
    return feishuEnabled(body);
  } catch (error) {
    if (error instanceof FeishuConfigurationError && error.reason === 'input')
      fail(400, 'enabled参数必须是布尔值或0/1');
    throw error;
  }
}
type Operation = 'list' | 'detail' | 'upsert' | 'delete' | 'toggle';
@Injectable()
export class FeishuConfigService {
  private active = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(FEISHU_CONFIGURATION_REPOSITORY)
    private readonly repository: FeishuConfigurationRepositoryPort,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  private async run<T>(
    operation: Operation,
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
      if (error instanceof FeishuConfigurationError) {
        if (error.reason === 'input') fail(400, '配置参数无效');
        if (error.reason === 'capacity')
          fail(429, '配置管理请求繁忙，请稍后再试');
      }
      this.logger.error('飞书配置操作失败', 'FeishuConfigService', {
        operation,
        reason: 'feishu_configuration_failed',
      });
      return fail(500, '飞书配置操作失败');
    } finally {
      this.active--;
    }
  }
  private async readAccess(
    unit: FeishuConfigurationUnit,
    principal: AuthPrincipal,
  ) {
    await authorizeAdministration(unit, principal, 'settings:read');
    // Webhooks grant the ability to post messages. Match sensitive SP-API
    // configuration policy: read-only settings viewers receive masked values.
    return (await unit.operatorPermissionCodes(principal.userId)).includes(
      'settings:write',
    );
  }
  list(principal: AuthPrincipal) {
    return this.run('list', () =>
      this.repository.transaction(async (unit) => {
        const reveal = await this.readAccess(unit, principal),
          rows = await unit.list();
        if (rows.length > 2) throw new FeishuConfigurationError('result');
        return rows.map((row) =>
          displayFeishuConfiguration(row, 'camel', reveal),
        );
      }),
    );
  }
  detail(principal: AuthPrincipal, country: string) {
    return this.run('detail', () =>
      this.repository.transaction(async (unit) => {
        const reveal = await this.readAccess(unit, principal),
          row = await unit.find(feishuCountry(country));
        if (!row) fail(404, '配置不存在');
        return displayFeishuConfiguration(row, 'snake', reveal);
      }),
    );
  }
  upsert(principal: AuthPrincipal, body: unknown) {
    return this.run('upsert', async () => {
      const result = await this.repository.transaction(async (unit) => {
        await authorizeAdministration(unit, principal, 'settings:write');
        const input =
          body && typeof body === 'object' && !Array.isArray(body)
            ? (body as Record<string, unknown>)
            : undefined;
        if (!input?.country || !input.webhookUrl)
          fail(400, 'country 和 webhookUrl 为必填项');
        return displayFeishuConfiguration(
          await unit.upsert(feishuConfigurationChange(body)),
          'camel',
          true,
        );
      });
      this.logger.info('飞书配置已保存', 'FeishuConfigService');
      return result;
    });
  }
  delete(principal: AuthPrincipal, country: string) {
    return this.run('delete', async () => {
      await this.repository.transaction(async (unit) => {
        await authorizeAdministration(unit, principal, 'settings:write');
        await unit.delete(feishuCountry(country));
      });
      this.logger.info('飞书配置删除操作完成', 'FeishuConfigService');
      return '删除成功' as const;
    });
  }
  toggle(principal: AuthPrincipal, country: string, body: unknown) {
    return this.run('toggle', async () => {
      const result = await this.repository.transaction(async (unit) => {
        await authorizeAdministration(unit, principal, 'settings:write');
        const row = await unit.toggle(
          feishuCountry(country),
          enabledValue(body),
        );
        return row && displayFeishuConfiguration(row, 'snake', true);
      });
      this.logger.info('飞书配置状态操作完成', 'FeishuConfigService');
      // Deliberately after commit: disabling a row persists even though Legacy's
      // enabled-only lookup returns no row and the controller responds with 404.
      if (!result) fail(404, '配置不存在');
      return result;
    });
  }
}
