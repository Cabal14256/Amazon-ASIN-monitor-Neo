import {
  parseCatalogTaskBinding,
  PgCatalogOperationRepository,
  withCatalogOperationExecution,
  type CatalogOperationDomain,
  type CatalogOperationKind,
  type CatalogTaskBinding,
  type createPgPool,
  type CreateTaskInput,
  type RedisTaskRepository,
} from '@asin-monitor/db';
type Pool = ReturnType<typeof createPgPool>;

/** Private-schema fixture producer. This preserves the real API ordering:
 * reserve -> prepared immutable binding -> Redis EVAL -> BullMQ enqueue.
 * Authorization is fixture-owned; this helper does not claim HTTP coverage. */
export async function createCatalogFixtureTask(
  pool: Pool,
  store: RedisTaskRepository,
  input: CreateTaskInput,
) {
  const repository = new PgCatalogOperationRepository(pool);
  const domain: CatalogOperationDomain = input.taskSubType?.startsWith(
    'competitor',
  )
    ? 'competitor'
    : 'asin';
  const kind: CatalogOperationKind =
    input.taskType === 'monitor' || input.taskType === 'competitor-monitor'
      ? 'monitor'
      : input.taskType === 'variant-check' || input.taskType === 'batch-check'
      ? 'check'
      : input.taskType === 'import'
      ? 'import'
      : 'batch-delete';
  const identity = await repository.reserve(
    { ownerId: input.userId, domain, kind, expectedTaskId: input.taskId },
    async () => undefined,
  );
  return store.create(input, (prepared) =>
    repository.bindTask(
      identity,
      parseCatalogTaskBinding({
        taskId: prepared.taskId,
        userId: prepared.userId,
        taskType: prepared.taskType,
        taskSubType: prepared.taskSubType,
        createdAt: prepared.createdAt,
      }),
    ),
  );
}

export async function withCatalogFixtureTask<T>(
  pool: Pool,
  task: CatalogTaskBinding,
  work: () => Promise<T>,
): Promise<T> {
  const repository = new PgCatalogOperationRepository(pool);
  return withCatalogOperationExecution(
    repository,
    await repository.findByTask(task),
    work,
  );
}
