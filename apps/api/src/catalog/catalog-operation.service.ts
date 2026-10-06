import type { PermissionCode } from '@asin-monitor/contracts';
import {
  CatalogOperationError,
  catalogTaskBindingSchema,
  PgCatalogOperationRepository,
  withCatalogOperationExecution,
  type CatalogOperationIdentity,
  type CatalogTaskBinding,
  type TaskState,
} from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { authorizeAdministration } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import { ApplicationDatabasePools } from '../database/database.service';
import { AppLogger } from '../logger/app-logger.service';

export interface CatalogOperationSubmission {
  readonly identity: CatalogOperationIdentity;
  /** A Redis acknowledgement can be lost. Retain the reservation before EVAL. */
  retain(): void;
  bindTask(task: CatalogTaskBinding | TaskState): Promise<void>;
  reject(): Promise<boolean>;
}

/** Every scope is backed by a durable PostgreSQL reservation. No browser
 * receipt, expired metadata or queue absence can release that reservation. */
@Injectable()
export class ApplicationCatalogOperations {
  private readonly repository: PgCatalogOperationRepository;
  private readonly settlements = new Map<string, Promise<void>>();
  constructor(
    @Inject(ApplicationDatabasePools) pools: ApplicationDatabasePools,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    this.repository = new PgCatalogOperationRepository(pools.primaryPool);
  }

  async execute<T>(
    principal: AuthPrincipal,
    domain: CatalogOperationIdentity['domain'],
    kind: CatalogOperationIdentity['kind'],
    permission: PermissionCode,
    action: (submission: CatalogOperationSubmission) => Promise<T>,
    expectedTaskId?: string,
  ): Promise<T> {
    let identity: CatalogOperationIdentity | undefined;
    let retained = false;
    let boundTask: CatalogTaskBinding | undefined;
    try {
      identity = await this.repository.reserve(
        { ownerId: principal.userId, domain, kind, expectedTaskId },
        (unit) => authorizeAdministration(unit, principal, permission),
      );
      const reserved = identity;
      const result = await withCatalogOperationExecution(
        this.repository,
        reserved,
        () =>
          action({
            identity: reserved,
            retain: () => {
              retained = true;
            },
            bindTask: (task) => {
              if (task.userId !== reserved.ownerId || !task.taskSubType)
                throw new Error('CATALOG_TASK_BINDING_INVALID');
              const binding = catalogTaskBindingSchema.parse({
                taskId: task.taskId,
                userId: reserved.ownerId,
                taskType: task.taskType,
                taskSubType: task.taskSubType,
                createdAt: task.createdAt,
              });
              return this.repository.bindTask(reserved, binding).then(() => {
                boundTask = binding;
              });
            },
            reject: async () => {
              if (!boundTask) return false;
              await this.repository.close(reserved, {
                status: 'rejected',
                source: 'producer',
                task: boundTask,
              });
              return this.repository.release(reserved);
            },
          }),
      );
      if (!retained) await this.finish(reserved, 'completed');
      return result;
    } catch (error) {
      if (identity && !retained) await this.finish(identity, 'failed');
      if (error instanceof CatalogOperationError)
        throw new HttpException(
          {
            success: false,
            errorCode: 409,
            errorMessage: '当前目录操作尚未确认结束，请核实原操作后再试',
          },
          409,
        );
      throw error;
    }
  }

  /** Called only after the queue atomically confirms removal before execution.
   * An absent job or terminal Redis metadata is never physical completion proof. */
  async settleRemovedTask(task: TaskState, deadline: number): Promise<void> {
    const binding = catalogTaskBindingSchema.safeParse({
      taskId: task.taskId,
      userId: task.userId,
      taskType: task.taskType,
      taskSubType: task.taskSubType,
      createdAt: task.createdAt,
    });
    if (!binding.success || task.status !== 'cancelled') return;
    const key = `${binding.data.taskId}:${binding.data.createdAt}`;
    let work = this.settlements.get(key);
    if (!work) {
      if (this.settlements.size >= 8) {
        this.logger.warn(
          '目录取消结算繁忙，保留待核验',
          'ApplicationCatalogOperations',
          { reason: 'catalog_cancel_settlement_capacity' },
        );
        return;
      }
      const prepared = binding.data;
      work = this.settleRemovedBinding(prepared).finally(() => {
        if (this.settlements.get(key) === work) this.settlements.delete(key);
      });
      this.settlements.set(key, work);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timer = setTimeout(
            resolve,
            Math.max(0, deadline - performance.now()),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async settleRemovedBinding(
    binding: CatalogTaskBinding,
  ): Promise<void> {
    try {
      const identity = await this.repository.findByTask(binding);
      await this.repository.close(identity, {
        status: 'cancelled',
        source: 'cancel',
        task: binding,
      });
      if (!(await this.repository.release(identity)))
        this.logger.warn(
          '已移除目录任务保留待核验',
          'ApplicationCatalogOperations',
          { reason: 'catalog_cancel_not_physically_settled' },
        );
    } catch (error) {
      if (
        error instanceof CatalogOperationError &&
        error.code === 'CATALOG_OPERATION_MISSING'
      )
        return;
      this.logger.warn('目录取消结算未确认', 'ApplicationCatalogOperations', {
        reason: 'catalog_cancel_settlement_unconfirmed',
      });
    }
  }

  private async finish(
    identity: CatalogOperationIdentity,
    status: 'completed' | 'failed',
  ): Promise<void> {
    try {
      await this.repository.close(identity, { status, source: 'sync' });
      if (!(await this.repository.release(identity)))
        this.logger.warn('目录操作保留待核验', 'ApplicationCatalogOperations', {
          reason: 'catalog_operation_not_physically_settled',
          kind: identity.kind,
          domain: identity.domain,
        });
    } catch {
      // A cleanup acknowledgement or physical COMMIT may be uncertain. Preserve
      // the durable slot and the original business result; never force release.
      this.logger.warn('目录操作结算未确认', 'ApplicationCatalogOperations', {
        reason: 'catalog_operation_settlement_unconfirmed',
        kind: identity.kind,
        domain: identity.domain,
      });
    }
  }
}
