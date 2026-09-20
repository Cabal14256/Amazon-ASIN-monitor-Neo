import type { Env } from '@asin-monitor/config';
import { batchCreateAsinsDataSchema } from '@asin-monitor/contracts';
import {
  CompetitorQueryError,
  CompetitorTransactionError,
  CompetitorWriteError,
  type CompetitorGroupReadResult,
  type CompetitorWriteRepositoryPort,
  type CompetitorWriteUnit,
} from '@asin-monitor/db';
import {
  HttpException,
  Inject,
  Injectable,
  type OnModuleDestroy,
} from '@nestjs/common';
import { authorizeAdministration } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { mapCompetitorQueryGroups } from './competitor-query-mapper';
import { mapCompetitorAsinWrite } from './competitor-write-mapper';
import {
  CompetitorWriteInputError,
  parseCompetitorAsinCreate,
  parseCompetitorAsinMove,
  parseCompetitorAsinUpdate,
  parseCompetitorBatchCreate,
  parseCompetitorGroupWrite,
  parseCompetitorNotify,
  parseCompetitorWriteId,
} from './competitor-write-values';

export const COMPETITOR_WRITE_REPOSITORY = Symbol(
  'COMPETITOR_WRITE_REPOSITORY',
);
/** Fixed public guidance only: never attach driver errors or request payloads. */
export class CompetitorCommitUncertainError extends HttpException {
  constructor() {
    super(
      {
        success: false,
        errorCode: 503,
        errorMessage: '写入结果未确认，请刷新数据后再操作',
      },
      503,
    );
  }
}
function fail(status: number, message: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
}
function groupResult(result: CompetitorGroupReadResult) {
  if (result.groups.length !== 1)
    throw new Error('Invalid competitor write result');
  return mapCompetitorQueryGroups(result)[0];
}
@Injectable()
export class CompetitorWriteService implements OnModuleDestroy {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(COMPETITOR_WRITE_REPOSITORY)
    private readonly repository: CompetitorWriteRepositoryPort,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  private async write<T>(
    principal: AuthPrincipal,
    operation:
      | 'create-group'
      | 'update-group'
      | 'create-asin'
      | 'batch-create'
      | 'update-asin'
      | 'move-asin'
      | 'delete-group'
      | 'delete-asin'
      | 'group-notify'
      | 'asin-notify',
    action: (unit: CompetitorWriteUnit) => Promise<T>,
  ) {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有竞品入口');
    try {
      const result = await this.repository.transaction(async (unit) => {
        await authorizeAdministration(unit, principal, 'asin:write');
        return action(unit);
      });
      this.logger.info('竞品写入完成', 'CompetitorWriteService', { operation });
      return result;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (
        error instanceof CompetitorWriteInputError &&
        error.code === 'batch-empty'
      )
        fail(400, 'items不能为空');
      if (error instanceof CompetitorWriteInputError && error.code === 'notify')
        fail(400, 'enabled参数必须是布尔值或0/1');
      if (
        error instanceof CompetitorWriteInputError ||
        (error instanceof CompetitorWriteError && error.code === 'input')
      )
        fail(400, '竞品写入参数无效');
      if (error instanceof CompetitorWriteError) {
        if (error.code === 'group-not-found') fail(404, '竞品变体组不存在');
        if (error.code === 'asin-not-found')
          fail(
            404,
            operation === 'move-asin' ? 'ASIN不存在' : '竞品ASIN不存在',
          );
        if (error.code === 'validation' && error.publicMessage)
          fail(400, error.publicMessage);
        if (error.code === 'duplicate')
          fail(409, '该 ASIN 在此国家中已存在，请刷新后重试');
        if (error.code === 'parent-changed')
          fail(409, 'ASIN 所属竞品组已改变，请刷新后重试');
        if (error.code === 'timestamp-policy') {
          this.logger.warn('竞品写入策略未就绪', 'CompetitorWriteService', {
            reason: 'competitor_write_policy_required',
          });
          fail(503, '竞品写入暂不可用，请使用现有竞品入口');
        }
      }
      if (
        error instanceof CompetitorQueryError &&
        error.code === 'too-many-children'
      )
        fail(413, '竞品组包含过多 ASIN，本次修改未提交');
      if (
        error instanceof CompetitorTransactionError &&
        error.code === 'capacity'
      )
        fail(429, '竞品写入繁忙，请稍后再试');
      if (
        error instanceof CompetitorTransactionError &&
        error.code === 'commit-uncertain'
      ) {
        this.logger.error('竞品提交结果未确认', 'CompetitorWriteService', {
          operation,
          reason: 'competitor_commit_uncertain',
        });
        throw new CompetitorCommitUncertainError();
      }
      this.logger.error('竞品写入失败', 'CompetitorWriteService', {
        operation,
        reason: 'competitor_write_failed',
      });
      return fail(500, '竞品写入失败');
    }
  }
  createGroup(principal: AuthPrincipal, body: unknown) {
    return this.write(principal, 'create-group', async (unit) =>
      groupResult(await unit.createGroup(parseCompetitorGroupWrite(body))),
    );
  }
  updateGroup(principal: AuthPrincipal, id: unknown, body: unknown) {
    return this.write(principal, 'update-group', async (unit) =>
      groupResult(
        await unit.updateGroup(
          parseCompetitorWriteId(id),
          parseCompetitorGroupWrite(body),
        ),
      ),
    );
  }
  createAsin(principal: AuthPrincipal, body: unknown) {
    return this.write(principal, 'create-asin', async (unit) =>
      mapCompetitorAsinWrite(
        await unit.createAsin(parseCompetitorAsinCreate(body)),
      ),
    );
  }
  updateAsin(principal: AuthPrincipal, id: unknown, body: unknown) {
    return this.write(principal, 'update-asin', async (unit) =>
      mapCompetitorAsinWrite(
        await unit.updateAsin(
          parseCompetitorWriteId(id),
          parseCompetitorAsinUpdate(body),
        ),
      ),
    );
  }
  batchCreateAsins(principal: AuthPrincipal, body: unknown) {
    return this.write(principal, 'batch-create', async (unit) => {
      const items = parseCompetitorBatchCreate(body);
      const result = batchCreateAsinsDataSchema.parse(
        await unit.batchCreateAsins(items),
      );
      if (
        result.total !== items.length ||
        result.total !== result.successCount + result.failedCount ||
        result.results.length !== result.total ||
        result.errors.length !== result.failedCount
      )
        throw new Error('Invalid competitor batch result');
      return result;
    });
  }
  moveAsin(principal: AuthPrincipal, id: unknown, body: unknown) {
    return this.write(principal, 'move-asin', async (unit) =>
      mapCompetitorAsinWrite(
        await unit.moveAsin(
          parseCompetitorWriteId(id),
          parseCompetitorAsinMove(body).targetGroupId,
        ),
      ),
    );
  }
  deleteGroup(principal: AuthPrincipal, id: unknown) {
    return this.write(principal, 'delete-group', async (unit) => {
      await unit.deleteGroup(parseCompetitorWriteId(id));
      return '删除成功';
    });
  }
  deleteAsin(principal: AuthPrincipal, id: unknown) {
    return this.write(principal, 'delete-asin', async (unit) => {
      await unit.deleteAsin(parseCompetitorWriteId(id));
      return '删除成功';
    });
  }
  updateGroupNotify(principal: AuthPrincipal, id: unknown, body: unknown) {
    return this.write(principal, 'group-notify', async (unit) =>
      groupResult(
        await unit.updateGroupNotify(
          parseCompetitorWriteId(id),
          parseCompetitorNotify(body),
        ),
      ),
    );
  }
  updateAsinNotify(principal: AuthPrincipal, id: unknown, body: unknown) {
    return this.write(principal, 'asin-notify', async (unit) =>
      mapCompetitorAsinWrite(
        await unit.updateAsinNotify(
          parseCompetitorWriteId(id),
          parseCompetitorNotify(body),
        ),
      ),
    );
  }
  onModuleDestroy() {
    this.repository.close?.();
  }
}
