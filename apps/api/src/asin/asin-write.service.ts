import type { Env } from '@asin-monitor/config';
import {
  AsinQueryRepositoryError,
  AsinTimestampPolicyError,
  AsinWriteRepositoryError,
  type AsinGroupReadResult,
  type AsinWriteRepositoryPort,
  type AsinWriteSnapshot,
  type AsinWriteUnit,
} from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { authorizeAdministration } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { mapAsinQueryChild, mapAsinQueryGroups } from './asin-query-mapper';
import {
  AsinWriteInputError,
  parseAsinCreate,
  parseAsinMove,
  parseAsinUpdate,
  parseAsinWriteId,
  parseVariantGroupWrite,
} from './asin-write-values';

export const ASIN_WRITE_REPOSITORY = Symbol('ASIN_WRITE_REPOSITORY');
function fail(status: number, message: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
}
function groupResult(result: AsinGroupReadResult) {
  if (result.groups.length !== 1) throw new Error('Invalid group write result');
  return mapAsinQueryGroups(result)[0];
}
export function asinWriteResult(result: AsinWriteSnapshot) {
  if (result.asin.variantGroupId !== result.group.id)
    throw new Error('Invalid ASIN write result');
  return {
    ...mapAsinQueryChild(result.asin, result.group),
    variantGroupId: result.asin.variantGroupId,
  };
}
@Injectable()
export class AsinWriteService {
  private active = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(ASIN_WRITE_REPOSITORY)
    private readonly repository: AsinWriteRepositoryPort,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  private async write<T>(
    principal: AuthPrincipal,
    operation:
      | 'create-group'
      | 'update-group'
      | 'create-asin'
      | 'update-asin'
      | 'move-asin',
    action: (unit: AsinWriteUnit) => Promise<T>,
  ) {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有 ASIN 入口');
    if (this.active >= 8) fail(429, 'ASIN 写入繁忙，请稍后再试');
    this.active++;
    try {
      const result = await this.repository.transaction(async (unit) => {
        await authorizeAdministration(unit, principal, 'asin:write');
        return action(unit);
      });
      this.logger.info('ASIN 写入完成', 'AsinWriteService', { operation });
      return result;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof AsinWriteInputError) fail(400, 'ASIN 写入参数无效');
      if (error instanceof AsinTimestampPolicyError) {
        this.logger.warn('ASIN 时间策略不可用', 'AsinWriteService', {
          reason: 'asin_timestamp_policy_required',
        });
        fail(503, 'ASIN 写入暂不可用，请使用现有 ASIN 入口');
      }
      if (
        error instanceof AsinQueryRepositoryError &&
        error.code === 'too-many-children'
      )
        fail(413, '变体组包含过多 ASIN，本次修改未提交');
      if (error instanceof AsinWriteRepositoryError) {
        if (error.code === 'asin-not-found') fail(404, 'ASIN不存在');
        if (error.code === 'group-not-found') fail(404, '变体组不存在');
        if (error.code === 'duplicate') fail(409, '该 ASIN 在此国家中已存在');
        if (error.code === 'parent-changed')
          fail(409, 'ASIN 所属变体组已改变，请刷新后重试');
        if (error.code === 'capacity') fail(429, 'ASIN 写入繁忙，请稍后再试');
      }
      this.logger.error('ASIN 写入失败', 'AsinWriteService', {
        operation,
        reason: 'asin_write_failed',
      });
      return fail(500, 'ASIN 写入失败');
    } finally {
      this.active--;
    }
  }
  createGroup(principal: AuthPrincipal, body: unknown) {
    return this.write(principal, 'create-group', async (unit) =>
      groupResult(await unit.createGroup(parseVariantGroupWrite(body))),
    );
  }
  updateGroup(principal: AuthPrincipal, groupId: unknown, body: unknown) {
    return this.write(principal, 'update-group', async (unit) =>
      groupResult(
        await unit.updateGroup(
          parseAsinWriteId(groupId),
          parseVariantGroupWrite(body),
        ),
      ),
    );
  }
  createAsin(principal: AuthPrincipal, body: unknown) {
    return this.write(principal, 'create-asin', async (unit) =>
      asinWriteResult(await unit.createAsin(parseAsinCreate(body))),
    );
  }
  updateAsin(principal: AuthPrincipal, asinId: unknown, body: unknown) {
    return this.write(principal, 'update-asin', async (unit) =>
      asinWriteResult(
        await unit.updateAsin(parseAsinWriteId(asinId), parseAsinUpdate(body)),
      ),
    );
  }
  moveAsin(principal: AuthPrincipal, asinId: unknown, body: unknown) {
    return this.write(principal, 'move-asin', async (unit) =>
      asinWriteResult(
        await unit.moveAsin(
          parseAsinWriteId(asinId),
          parseAsinMove(body).targetGroupId,
        ),
      ),
    );
  }
}
