import type { PermissionCode } from '@asin-monitor/contracts';
import {
  CatalogOperationError,
  catalogTaskBindingSchema,
  parseCatalogIdentity,
  PgCatalogOperationRepository,
  taskMatchesCatalogOperation,
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

export interface CatalogCancellationLease {
  /** Preserve the original queue proof immediately after exact remove ACK. */
  markRemoved(): void;
  /** Confirm only the exact removed task after its cancelled metadata CAS. */
  confirmRemoved(task: TaskState, deadline: number): Promise<void>;
  /** Only unconfirmed queue removal releases admission; a later metadata
   * failure retains it. Running/absent jobs have no removal proof. */
  release(): void;
}

interface RemovedTaskSettlement {
  readonly key: string;
  readonly binding: CatalogTaskBinding;
  confirmedRemoved: boolean;
  identity?: CatalogOperationIdentity;
  work?: Promise<void>;
}

function cancellationBinding(task: TaskState): CatalogTaskBinding | undefined {
  const parsed = catalogTaskBindingSchema.safeParse({
    taskId: task.taskId,
    userId: task.userId,
    taskType: task.taskType,
    taskSubType: task.taskSubType,
    createdAt: task.createdAt,
  });
  if (!parsed.success) return undefined;
  const binding = parsed.data;
  const catalogTask = (['asin', 'competitor'] as const).some((domain) =>
    (['batch-delete', 'import', 'check', 'monitor'] as const).some((kind) =>
      taskMatchesCatalogOperation(
        {
          ownerId: binding.userId,
          domain,
          kind,
          generation: '1',
          operationId: binding.taskId,
        },
        binding,
      ),
    ),
  );
  return catalogTask ? Object.freeze(binding) : undefined;
}

function settlementKey(binding: CatalogTaskBinding): string {
  return JSON.stringify([
    binding.taskId,
    binding.userId,
    binding.taskType,
    binding.taskSubType,
    binding.createdAt,
  ]);
}

/** Every scope is backed by a durable PostgreSQL reservation. No browser
 * receipt, expired metadata or queue absence can release that reservation. */
@Injectable()
export class ApplicationCatalogOperations {
  private readonly repository: PgCatalogOperationRepository;
  private readonly settlements = new Map<string, RemovedTaskSettlement>();
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
      if (identity && (!retained || !boundTask))
        await this.finish(identity, 'failed');
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

  /** Admit BEFORE the irreversible queue removal. Confirmed entries remain
   * bounded and owned until PostgreSQL proves release of their exact identity. */
  acquireCancellation(task: TaskState): CatalogCancellationLease | undefined {
    const binding = cancellationBinding(task);
    if (!binding) return undefined;
    const key = settlementKey(binding);
    if (this.settlements.has(key))
      throw new HttpException(
        {
          success: false,
          errorCode: 409,
          errorMessage: '目录取消仍待核验，请刷新后重试',
        },
        409,
      );
    if (this.settlements.size >= 8)
      throw new HttpException(
        {
          success: false,
          errorCode: 429,
          errorMessage: '任务取消繁忙，请稍后再试',
        },
        429,
      );
    const entry: RemovedTaskSettlement = {
      key,
      binding,
      confirmedRemoved: false,
    };
    this.settlements.set(key, entry);
    let released = false;
    return {
      markRemoved: () => {
        if (released || this.settlements.get(key) !== entry)
          throw new HttpException(
            {
              success: false,
              errorCode: 409,
              errorMessage: '目录取消仍待核验，请刷新后重试',
            },
            409,
          );
        entry.confirmedRemoved = true;
      },
      confirmRemoved: async (next, deadline) => {
        const actual = cancellationBinding(next);
        if (
          released ||
          !entry.confirmedRemoved ||
          this.settlements.get(key) !== entry ||
          next.status !== 'cancelled' ||
          !actual ||
          settlementKey(actual) !== key
        )
          throw new HttpException(
            {
              success: false,
              errorCode: 409,
              errorMessage: '任务已变化，请刷新后重试',
            },
            409,
          );
        await this.waitRemovedSettlement(entry, deadline);
      },
      release: () => {
        released = true;
        if (!entry.confirmedRemoved && this.settlements.get(key) === entry)
          this.settlements.delete(key);
      },
    };
  }

  /** Terminal metadata alone cannot authorize cleanup. Only this process's
   * prior exact queue-removal proof may retry its still-owned settlement. */
  async retryRemovedTask(task: TaskState, deadline: number): Promise<boolean> {
    if (task.status !== 'cancelled') return false;
    const binding = cancellationBinding(task);
    if (!binding) return false;
    const entry = this.settlements.get(settlementKey(binding));
    if (!entry?.confirmedRemoved) return false;
    await this.waitRemovedSettlement(entry, deadline);
    return true;
  }

  private async waitRemovedSettlement(
    entry: RemovedTaskSettlement,
    deadline: number,
  ): Promise<void> {
    let work = entry.work;
    if (!work) {
      work = this.settleRemovedBinding(entry).finally(() => {
        if (entry.work === work) entry.work = undefined;
      });
      entry.work = work;
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
    entry: RemovedTaskSettlement,
  ): Promise<void> {
    // Each initial confirmation or explicit retry owns at most three attempts.
    // An HTTP deadline stops waiting; it never frees in-flight storage work.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (!entry.identity) {
          const identity = parseCatalogIdentity(
            await this.repository.findByTask(entry.binding),
          );
          if (!taskMatchesCatalogOperation(identity, entry.binding))
            throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
          entry.identity = Object.freeze(identity);
        }
        await this.repository.close(entry.identity, {
          status: 'cancelled',
          source: 'cancel',
          task: entry.binding,
        });
        if (await this.repository.release(entry.identity)) {
          if (this.settlements.get(entry.key) === entry)
            this.settlements.delete(entry.key);
          return;
        }
        this.logger.warn(
          '已移除目录任务保留待核验',
          'ApplicationCatalogOperations',
          { reason: 'catalog_cancel_not_physically_settled' },
        );
      } catch {
        this.logger.warn('目录取消结算未确认', 'ApplicationCatalogOperations', {
          reason: 'catalog_cancel_settlement_unconfirmed',
        });
      }
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
