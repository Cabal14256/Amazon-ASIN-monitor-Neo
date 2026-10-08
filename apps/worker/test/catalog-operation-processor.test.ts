import {
  assertCatalogWriteExecution,
  CatalogOperationError,
  catalogTransactionExecution,
  competitorMonitorJobDigest,
  type CatalogOperationIdentity,
  type CatalogOperationPin,
  type CatalogOperationSnapshot,
  type CatalogOperationTerminalProof,
  type CatalogPhysicalOutcome,
  type CatalogTaskBinding,
  type PgCatalogOperationRepository,
  type TaskState,
} from '@asin-monitor/db';
import {
  parseVariantCheckJob,
  variantCheckJobOperation,
  variantCheckResultReference,
} from '@asin-monitor/variant-check';
import { UnrecoverableError, type Job } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCatalogFencedProcessor } from '../src/catalog-operation-processor';

afterEach(() => vi.useRealTimers());

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function completedReplay(f: ReturnType<typeof fixture>) {
  const task = f.task;
  let result: unknown = { success: true, summary: 'original' };
  switch (task.taskType) {
    case 'batch-delete':
      f.job.data = {
        ...task,
        domain: f.identity.domain,
        title:
          f.identity.domain === 'asin'
            ? '批量删除变体组'
            : '批量删除竞品变体组',
        groupIds: ['g1'],
        asinIds: [],
      };
      break;
    case 'import':
      f.job.data = {
        ...task,
        ...(f.identity.domain === 'competitor'
          ? { domain: 'competitor', title: '竞品ASIN导入' }
          : { title: 'ASIN导入' }),
        file: {
          taskId: task.taskId,
          extension: 'csv',
          originalFilename: 'fixture.csv',
          sha256: 'a'.repeat(64),
          bytes: 100,
        },
      };
      break;
    case 'variant-check':
    case 'batch-check':
      f.job.data = {
        ...task,
        expiresAt: '2026-10-04T00:30:00.000Z',
        params:
          task.taskType === 'batch-check'
            ? { groupIds: ['g1'], forceRefresh: false }
            : { asinId: 'a1', forceRefresh: false },
      };
      result = variantCheckResultReference(
        variantCheckJobOperation(parseVariantCheckJob(f.job.data)),
      );
      break;
    case 'monitor':
    case 'competitor-monitor':
      f.job.data = {
        ...task,
        expiresAt: '2026-10-04T00:30:00.000Z',
        countries: ['US'],
      };
      if (task.taskType === 'competitor-monitor')
        result = {
          success: true,
          totalChecked: 0,
          totalBroken: 0,
          totalNormal: 0,
          countryResults: {
            US: {
              totalGroups: 0,
              brokenGroups: 0,
              checkTime: task.createdAt,
              brokenByType: { SP_API_ERROR: 0, NOT_FOUND: 0, NO_VARIANTS: 0 },
            },
          },
          notificationResults: { US: 'skipped' },
          _competitorMonitorCommit: {
            version: 1,
            requestHash: competitorMonitorJobDigest(f.job.data),
          },
        };
  }
  f.patch({ ...task, status: 'completed', result });
  return result;
}

function fixture(
  domain: 'asin' | 'competitor' = 'asin',
  kind: 'import' | 'batch-delete' | 'check' | 'monitor' = 'check',
) {
  const task: CatalogTaskBinding = {
    taskId: '10000000-0000-4000-8000-000000000224',
    userId: ' owner ',
    taskType:
      kind === 'check'
        ? 'variant-check'
        : kind === 'monitor'
        ? domain === 'asin'
          ? 'monitor'
          : 'competitor-monitor'
        : kind,
    taskSubType:
      kind === 'check'
        ? domain === 'asin'
          ? 'asin-check'
          : 'competitor-asin-check'
        : kind === 'monitor'
        ? domain === 'asin'
          ? 'primary'
          : 'competitor'
        : kind === 'import'
        ? domain === 'asin'
          ? 'asin'
          : 'competitor-asin'
        : domain === 'asin'
        ? 'variant-group-delete'
        : 'competitor-variant-group-delete',
    createdAt: '2026-09-27T00:30:00.000Z',
  };
  const identity: CatalogOperationIdentity = {
    ownerId: task.userId,
    domain,
    operationId: '20000000-0000-4000-8000-000000000224',
    generation: '9007199254740993',
    kind,
  };
  let state: TaskState | null = {
    ...task,
    title: 'Fixture',
    status: 'pending',
    progress: 0,
    message: '',
    error: null,
    result: null,
    updatedAt: task.createdAt,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    cancelRequestedAt: null,
    revision: 0,
  };
  let snapshot: CatalogOperationSnapshot | null = {
    ...identity,
    state: 'open',
    expectedTaskId: task.taskId,
    task,
    pendingPins: 0,
    uncertainPins: 0,
    terminal: null,
  };
  const pins = new Map<string, CatalogOperationPin>();
  const events: string[] = [];
  const repository = {
    findByTask: vi.fn(async (input: CatalogTaskBinding) => {
      expect(input).toEqual(task);
      if (!snapshot)
        throw new CatalogOperationError('CATALOG_OPERATION_MISSING');
      return { ...identity };
    }),
    read: vi.fn(async () => snapshot && { ...snapshot }),
    beginPin: vi.fn(async () => {
      const pin = {
        identity,
        pinId: `30000000-0000-4000-8000-${String(pins.size + 1).padStart(
          12,
          '0',
        )}`,
      };
      pins.set(pin.pinId, pin);
      snapshot!.pendingPins++;
      events.push('begin');
      return pin;
    }),
    assertPin: vi.fn(async () => undefined),
    finishPin: vi.fn(
      async (pin: CatalogOperationPin, outcome: CatalogPhysicalOutcome) => {
        expect(pins.has(pin.pinId)).toBe(true);
        pins.delete(pin.pinId);
        snapshot!.pendingPins--;
        if (outcome === 'uncertain') {
          snapshot!.uncertainPins++;
          snapshot!.state = 'uncertain';
        }
        events.push(outcome);
      },
    ),
    close: vi.fn(
      async (
        _identity: CatalogOperationIdentity,
        proof?: CatalogOperationTerminalProof,
      ) => {
        expect(snapshot!.pendingPins).toBe(0);
        expect(snapshot!.uncertainPins).toBe(0);
        snapshot!.state = 'closed';
        snapshot!.terminal ??= proof ?? null;
        events.push('close');
      },
    ),
    release: vi.fn(async () => {
      expect(snapshot!.state).toBe('closed');
      expect(snapshot!.terminal).not.toBeNull();
      snapshot = null;
      events.push('release');
      return true;
    }),
  };
  const store = { read: vi.fn(async () => state) };
  const log = { warn: vi.fn() };
  const job = {
    id: task.taskId,
    name:
      kind === 'import' || kind === 'batch-delete'
        ? `${domain}-${kind}`
        : kind === 'monitor'
        ? `${domain === 'asin' ? 'primary' : 'competitor'}-monitor`
        : task.taskType,
    data: { ...task },
    attemptsMade: 0,
    opts: { attempts: 2 },
  } as Job;
  const patch = (value: Partial<TaskState>) => {
    state = { ...state!, ...value };
  };
  const run = (processor: (job: Job, token?: string) => Promise<unknown>) =>
    createCatalogFencedProcessor(
      task.taskType,
      repository as unknown as PgCatalogOperationRepository,
      store,
      processor,
      log,
    )(job, 'lease');
  return {
    task,
    identity,
    repository,
    store,
    log,
    job,
    patch,
    run,
    events,
    snapshot: () => snapshot,
    setSnapshot: (value: CatalogOperationSnapshot | null) => {
      snapshot = value;
    },
    expire: () => {
      state = null;
    },
  };
}

describe('required Worker catalog operation and physical settlement', () => {
  for (const domain of ['asin', 'competitor'] as const) {
    for (const kind of [
      'import',
      'batch-delete',
      'check',
      'monitor',
    ] as const) {
      it(`${domain} ${kind} enters the exact scope and releases only after physical COMMIT and terminal task`, async () => {
        const f = fixture(domain, kind);
        const result = await f.run(async () => {
          const execution = catalogTransactionExecution();
          expect(execution.scoped).toBe(true);
          await execution.begin();
          const db = { execute: vi.fn() };
          await execution.guard(db);
          assertCatalogWriteExecution(
            db,
            domain,
            kind === 'check' || kind === 'monitor',
          );
          await execution.settled('committed');
          expect(f.repository.close).not.toHaveBeenCalled();
          f.patch({ status: 'completed', result: { success: true } });
          return { success: true };
        });
        expect(result).toEqual({ success: true });
        expect(f.repository.close).toHaveBeenCalledTimes(2);
        expect(f.repository.close).toHaveBeenNthCalledWith(1, f.identity);
        expect(f.repository.close).toHaveBeenNthCalledWith(2, f.identity, {
          status: 'completed',
          source: 'worker',
          task: f.task,
        });
        expect(f.events).toEqual([
          'begin',
          'committed',
          'close',
          'close',
          'release',
        ]);
      });
      it(`${domain} ${kind} replays its exact terminal result after release without invoking any business processor`, async () => {
        const f = fixture(domain, kind);
        await f.run(async () => {
          const execution = catalogTransactionExecution();
          await execution.begin();
          await execution.settled('committed');
          return completedReplay(f);
        });
        expect(f.snapshot()).toBeNull();
        const original = await f.store.read();
        for (const method of Object.values(f.repository)) method.mockClear();
        const business = vi.fn(async () => {
          throw new Error('terminal replay must never enter a processor');
        });
        await expect(f.run(business)).resolves.toEqual(original?.result);
        expect(business).not.toHaveBeenCalled();
        expect(f.repository.findByTask).toHaveBeenCalledExactlyOnceWith(f.task);
        for (const [name, method] of Object.entries(f.repository))
          if (name !== 'findByTask') expect(method).not.toHaveBeenCalled();
        expect(await f.store.read()).toEqual(original);
      });
    }
    for (const outcome of ['committed', 'rolled-back'] as const) {
      it(`${domain} keeps the gate when a logical timeout precedes late physical ${outcome}`, async () => {
        const f = fixture(domain);
        const physical = deferred();
        let finishing!: Promise<void>;
        await f.run(async () => {
          const execution = catalogTransactionExecution();
          await execution.begin();
          await execution.guard({ execute: vi.fn() });
          finishing = physical.promise.then(() => execution.settled(outcome));
          // Models the repository's Promise.race: logical deadline wins while
          // real SQL/COMMIT/ROLLBACK still owns its transaction and slot lock.
          await Promise.race([finishing, Promise.resolve()]);
          f.patch({ status: 'cancelled' });
          return { cancelled: true };
        });
        expect(f.repository.close).not.toHaveBeenCalled();
        expect(f.repository.release).not.toHaveBeenCalled();
        expect(f.snapshot()?.pendingPins).toBe(1);
        physical.resolve();
        await finishing;
        expect(f.events).toEqual([
          'begin',
          outcome,
          'close',
          'close',
          'release',
        ]);
        expect(f.repository.close).toHaveBeenCalledWith(f.identity, {
          status: 'cancelled',
          source: 'worker',
          task: f.task,
        });
      });
    }
    it(`${domain} cannot start a late chunk after the processor logically ends`, async () => {
      const f = fixture(domain);
      const late = deferred();
      let continuation!: Promise<unknown>;
      await f.run(async () => {
        continuation = late.promise.then(async () => {
          const execution = catalogTransactionExecution();
          await execution.begin();
        });
        f.patch({ status: 'completed' });
      });
      late.resolve();
      await expect(continuation).rejects.toMatchObject({
        code: 'CATALOG_OPERATION_CLOSED',
      });
      expect(f.repository.beginPin).not.toHaveBeenCalled();
    });
  }
  it.each(['completed', 'failed', 'cancelled'] as const)(
    'settles confirmed %s and preserves the processor result/error',
    async (status) => {
      const f = fixture();
      const error = new Error('original');
      const result = f.run(async () => {
        f.patch({ status });
        if (status === 'failed') throw error;
        return status;
      });
      if (status === 'failed') await expect(result).rejects.toBe(error);
      else await expect(result).resolves.toBe(status);
      expect(f.repository.release).toHaveBeenCalledOnce();
    },
  );
  it.each(['pending', 'processing', 'cancelling'] as const)(
    'retains a retryable %s task even when a result is returned',
    async (status) => {
      const f = fixture();
      await f.run(async () => {
        f.patch({ status });
        return { success: true };
      });
      expect(f.repository.close).not.toHaveBeenCalled();
      expect(f.repository.release).not.toHaveBeenCalled();
    },
  );
  it('unknown physical COMMIT never releases from task status, elapsed time or missing queue', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture();
    await f.run(async () => {
      const execution = catalogTransactionExecution();
      await execution.begin();
      await execution.guard({ execute: vi.fn() });
      await execution.settled('uncertain');
      return completedReplay(f);
    });
    expect(f.snapshot()).toMatchObject({
      state: 'uncertain',
      uncertainPins: 1,
    });
    expect(f.repository.close).not.toHaveBeenCalled();
    expect(f.repository.release).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2030-09-27T00:30:00.000Z'));
    const retry = vi.fn(async () => undefined);
    await expect(f.run(retry)).resolves.toEqual((await f.store.read())?.result);
    expect(retry).not.toHaveBeenCalled();
    expect(f.repository.beginPin).toHaveBeenCalledOnce();
    expect(f.snapshot()).toMatchObject({
      state: 'uncertain',
      uncertainPins: 1,
    });
    expect(f.repository.close).not.toHaveBeenCalled();
    expect(f.repository.release).not.toHaveBeenCalled();
  });
  it('a lost finishPin acknowledgement retains the original gate', async () => {
    const f = fixture();
    f.repository.finishPin.mockRejectedValueOnce(
      new Error('private connection detail'),
    );
    await expect(
      f.run(async () => {
        const execution = catalogTransactionExecution();
        await execution.begin();
        try {
          await execution.settled('rolled-back');
        } finally {
          f.patch({ status: 'failed' });
        }
      }),
    ).rejects.toThrow('private connection detail');
    expect(f.repository.close).not.toHaveBeenCalled();
    expect(f.repository.release).not.toHaveBeenCalled();
    expect(JSON.stringify(f.log.warn.mock.calls)).not.toContain(
      'private connection detail',
    );
  });
  it('an unknown beginPin allocation must not release even if the current PG snapshot has no pin', async () => {
    const f = fixture();
    f.repository.beginPin.mockRejectedValueOnce(
      new Error('allocation timeout'),
    );
    await f.run(async () => {
      try {
        await catalogTransactionExecution().begin();
      } catch {
        f.patch({ status: 'failed' });
      }
    });
    expect(f.repository.close).not.toHaveBeenCalled();
    expect(f.repository.release).not.toHaveBeenCalled();
  });
  it('expired Redis metadata is not terminal proof', async () => {
    const f = fixture();
    await f.run(async () => {
      f.expire();
      return { success: true };
    });
    expect(f.repository.close).not.toHaveBeenCalled();
    expect(f.repository.release).not.toHaveBeenCalled();
  });
  it.each([
    'taskId',
    'userId',
    'taskType',
    'taskSubType',
    'createdAt',
  ] as const)(
    'does not release a changed Redis %s incarnation',
    async (field) => {
      const f = fixture();
      await f.run(async () => {
        f.patch({ status: 'completed', [field]: 'changed' });
      });
      expect(f.repository.close).not.toHaveBeenCalled();
      expect(f.repository.release).not.toHaveBeenCalled();
    },
  );
  it('missing server reservation fails before the processor and never synthesizes an exemption', async () => {
    const f = fixture();
    f.setSnapshot(null);
    const business = vi.fn(async () => undefined);
    await expect(f.run(business)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(business).not.toHaveBeenCalled();
  });
  it('closed cancelled task settles the original proof without invoking any business retry', async () => {
    const f = fixture();
    f.patch({ status: 'cancelled' });
    f.setSnapshot({
      ...f.snapshot()!,
      state: 'closed',
      terminal: { status: 'cancelled', source: 'cancel', task: f.task },
    });
    const business = vi.fn(async () => undefined);
    await expect(f.run(business)).resolves.toMatchObject({ cancelled: true });
    expect(business).not.toHaveBeenCalled();
    expect(f.repository.close).toHaveBeenCalledExactlyOnceWith(f.identity);
    expect(f.repository.release).toHaveBeenCalledOnce();
  });
  it.each(['completed', 'failed'] as const)(
    'closed %s replays metadata or the original failure without a late business run',
    async (status) => {
      const f = fixture();
      const original = completedReplay(f);
      f.patch({ status });
      f.setSnapshot({
        ...f.snapshot()!,
        state: 'closed',
        terminal: { status, source: 'worker', task: f.task },
      });
      const business = vi.fn(async () => undefined);
      if (status === 'completed')
        await expect(f.run(business)).resolves.toEqual(original);
      else
        await expect(f.run(business)).rejects.toBeInstanceOf(
          UnrecoverableError,
        );
      expect(business).not.toHaveBeenCalled();
      expect(f.repository.beginPin).not.toHaveBeenCalled();
      expect(f.repository.close).toHaveBeenCalledExactlyOnceWith(f.identity);
      expect(f.repository.release).toHaveBeenCalledExactlyOnceWith(f.identity);
      expect(f.snapshot()).toBeNull();
    },
  );
  it('a new owner/domain generation cannot be released by an old attempt', async () => {
    const f = fixture();
    await f.run(async () => {
      f.patch({ status: 'completed' });
      f.setSnapshot({ ...f.snapshot()!, generation: '9007199254740994' });
    });
    expect(f.repository.close).not.toHaveBeenCalled();
    expect(f.repository.release).not.toHaveBeenCalled();
  });
  it('an old completed replay leaves a replacement generation and unknown pins untouched', async () => {
    const f = fixture('competitor', 'batch-delete');
    const original = completedReplay(f);
    const replacement = {
      ...f.snapshot()!,
      generation: '9007199254740994',
      operationId: '20000000-0000-4000-8000-000000000225',
      pendingPins: 1,
      uncertainPins: 1,
      state: 'uncertain' as const,
    };
    f.setSnapshot(replacement);
    const business = vi.fn(async () => undefined);
    await expect(f.run(business)).resolves.toEqual(original);
    expect(f.snapshot()).toEqual(replacement);
    expect(business).not.toHaveBeenCalled();
    expect(f.repository.findByTask).toHaveBeenCalledExactlyOnceWith(f.task);
    expect(f.repository.read).toHaveBeenCalledExactlyOnceWith(
      f.identity.ownerId,
      f.identity.domain,
    );
    for (const name of [
      'beginPin',
      'assertPin',
      'finishPin',
      'close',
      'release',
    ] as const)
      expect(f.repository[name]).not.toHaveBeenCalled();
  });
  it.each(['open', 'uncertain'] as const)(
    'cancelled metadata cannot invoke a processor or settle a %s physical generation',
    async (state) => {
      const f = fixture();
      f.patch({ status: 'cancelled' });
      const original = {
        ...f.snapshot()!,
        state,
        pendingPins: 1,
        uncertainPins: state === 'uncertain' ? 1 : 0,
      };
      f.setSnapshot(original);
      const business = vi.fn(async () => undefined);
      await expect(f.run(business)).resolves.toMatchObject({ cancelled: true });
      expect(business).not.toHaveBeenCalled();
      expect(f.repository.beginPin).not.toHaveBeenCalled();
      expect(f.repository.close).not.toHaveBeenCalled();
      expect(f.repository.release).not.toHaveBeenCalled();
      expect(f.snapshot()).toEqual(original);
    },
  );
  it('an already released cancellation only returns its exact metadata', async () => {
    const f = fixture();
    f.patch({ status: 'cancelled' });
    f.setSnapshot(null);
    const business = vi.fn(async () => undefined);
    await expect(f.run(business)).resolves.toMatchObject({ cancelled: true });
    expect(business).not.toHaveBeenCalled();
    expect(f.repository.beginPin).not.toHaveBeenCalled();
    expect(f.repository.close).not.toHaveBeenCalled();
    expect(f.repository.release).not.toHaveBeenCalled();
  });
  it.each([
    'taskId',
    'userId',
    'taskType',
    'taskSubType',
    'createdAt',
  ] as const)(
    'rejects a changed terminal metadata %s before lookup or execution',
    async (field) => {
      const f = fixture();
      completedReplay(f);
      f.patch({ [field]: 'changed' });
      const business = vi.fn(async () => undefined);
      await expect(f.run(business)).rejects.toBeInstanceOf(UnrecoverableError);
      expect(business).not.toHaveBeenCalled();
      expect(f.repository.findByTask).not.toHaveBeenCalled();
    },
  );
  it.each(['params', 'expiresAt', 'result'] as const)(
    'check terminal replay still rejects altered %s receipt identity',
    async (field) => {
      const f = fixture();
      completedReplay(f);
      if (field === 'params') f.job.data.params.asinId = 'different';
      else if (field === 'expiresAt')
        f.job.data.expiresAt = '2026-10-05T00:30:00.000Z';
      else f.patch({ result: { ...f.job.data } });
      const business = vi.fn(async () => undefined);
      await expect(f.run(business)).rejects.toBeInstanceOf(UnrecoverableError);
      expect(business).not.toHaveBeenCalled();
      expect(f.repository.findByTask).not.toHaveBeenCalled();
    },
  );
  it('batch-check completion uses the same exact immutable receipt comparison', async () => {
    const f = fixture();
    f.task.taskType = 'batch-check';
    f.task.taskSubType = 'variant-group';
    f.job.name = 'batch-check';
    const result = completedReplay(f);
    f.setSnapshot(null);
    const business = vi.fn(async () => undefined);
    await expect(f.run(business)).resolves.toEqual(result);
    expect(f.repository.findByTask).toHaveBeenCalledExactlyOnceWith(f.task);
    f.repository.findByTask.mockClear();
    f.job.data.params.groupIds = ['different'];
    await expect(f.run(business)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(business).not.toHaveBeenCalled();
    expect(f.repository.findByTask).not.toHaveBeenCalled();
  });
  it.each(['countries', 'commit'] as const)(
    'competitor monitor terminal replay still rejects altered %s completion proof',
    async (field) => {
      const f = fixture('competitor', 'monitor');
      const result = completedReplay(f) as Record<string, unknown>;
      if (field === 'countries') f.job.data.countries = ['DE'];
      else
        f.patch({
          result: {
            ...result,
            _competitorMonitorCommit: {
              version: 1,
              requestHash: 'b'.repeat(64),
            },
          },
        });
      const business = vi.fn(async () => undefined);
      await expect(f.run(business)).rejects.toBeInstanceOf(UnrecoverableError);
      expect(business).not.toHaveBeenCalled();
      expect(f.repository.findByTask).not.toHaveBeenCalled();
    },
  );
  it('an invalid domain payload cannot turn terminal metadata into a valid deletion replay', async () => {
    const f = fixture('competitor', 'batch-delete');
    completedReplay(f);
    f.job.data.domain = 'asin';
    const business = vi.fn(async () => undefined);
    await expect(f.run(business)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(business).not.toHaveBeenCalled();
    expect(f.repository.findByTask).not.toHaveBeenCalled();
  });
  it('a payload completed flag with no server metadata cannot bypass prepared admission', async () => {
    const f = fixture();
    f.job.data.status = 'completed';
    f.expire();
    const business = vi.fn(async () => undefined);
    await expect(f.run(business)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(business).not.toHaveBeenCalled();
    expect(f.repository.findByTask).not.toHaveBeenCalled();
  });
  it('rejects a different job ID or name before lookup, metadata or business work', async () => {
    const f = fixture();
    f.job.id = 'another';
    const business = vi.fn(async () => undefined);
    await expect(f.run(business)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(f.repository.findByTask).not.toHaveBeenCalled();
    expect(f.store.read).not.toHaveBeenCalled();
    expect(business).not.toHaveBeenCalled();
  });
  it('a previous attempt pending pin prevents a new retry from starting business writes', async () => {
    const f = fixture();
    f.setSnapshot({ ...f.snapshot()!, pendingPins: 1 });
    const business = vi.fn(async () => undefined);
    await expect(f.run(business)).rejects.toThrow('目录操作状态暂不可用');
    expect(business).not.toHaveBeenCalled();
    expect(f.repository.beginPin).not.toHaveBeenCalled();
    expect(f.repository.release).not.toHaveBeenCalled();
  });
  it('closed cancellation with a pending physical pin cannot release or retry its writes', async () => {
    const f = fixture();
    f.patch({ status: 'cancelled' });
    f.setSnapshot({
      ...f.snapshot()!,
      state: 'closed',
      pendingPins: 1,
      terminal: { status: 'cancelled', source: 'cancel', task: f.task },
    });
    const business = vi.fn(async () => undefined);
    await expect(f.run(business)).resolves.toMatchObject({ cancelled: true });
    expect(business).not.toHaveBeenCalled();
    expect(f.repository.close).not.toHaveBeenCalled();
    expect(f.repository.release).not.toHaveBeenCalled();
  });
  it('waits for every real transaction, not just the first late completion', async () => {
    const f = fixture('competitor', 'import');
    const first = deferred(),
      second = deferred();
    let finishing!: Promise<void>[];
    await f.run(async () => {
      const executions = [
        catalogTransactionExecution(),
        catalogTransactionExecution(),
      ];
      for (const execution of executions) await execution.begin();
      finishing = [
        first.promise.then(() => executions[0].settled('committed')),
        second.promise.then(() => executions[1].settled('rolled-back')),
      ];
      f.patch({ status: 'cancelled' });
    });
    first.resolve();
    await finishing[0];
    expect(f.repository.close).not.toHaveBeenCalled();
    expect(f.repository.release).not.toHaveBeenCalled();
    second.resolve();
    await finishing[1];
    expect(f.events).toEqual([
      'begin',
      'begin',
      'committed',
      'rolled-back',
      'close',
      'close',
      'release',
    ]);
  });
  it('a payload-supplied system/anonymous flag cannot bypass missing server ownership', async () => {
    const f = fixture();
    f.job.data = {
      ...f.job.data,
      source: 'scheduled-system',
      actor: { kind: 'system' },
      anonymous: true,
    };
    f.setSnapshot(null);
    const business = vi.fn(async () => undefined);
    await expect(f.run(business)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(business).not.toHaveBeenCalled();
  });
  it('retains the gate and rejects Bull completion when final metadata read stays unavailable after bounded retry', async () => {
    const f = fixture();
    await expect(
      f.run(async () => {
        f.patch({ status: 'completed' });
        f.store.read.mockRejectedValue(new Error('private endpoint'));
        return 'completed';
      }),
    ).rejects.toThrow('目录任务释放暂不可用');
    expect(f.repository.close).not.toHaveBeenCalled();
    expect(f.repository.release).not.toHaveBeenCalled();
    expect(f.log.warn).toHaveBeenCalledWith('目录任务释放未确认', {
      reason: 'catalog_task_settlement_unconfirmed',
      taskType: 'variant-check',
    });
    expect(JSON.stringify(f.log.warn.mock.calls)).not.toContain(
      'private endpoint',
    );
  });
  it('blocks a prepared pin from entering SQL after its logical attempt has ended, then releases after real rollback', async () => {
    const f = fixture();
    const late = deferred();
    let finishing!: Promise<void>;
    await f.run(async () => {
      const execution = catalogTransactionExecution();
      await execution.begin();
      finishing = late.promise.then(async () => {
        await expect(
          execution.guard({ execute: vi.fn() }),
        ).rejects.toMatchObject({ code: 'CATALOG_OPERATION_CLOSED' });
        await execution.settled('rolled-back');
      });
      f.patch({ status: 'cancelled' });
    });
    expect(f.repository.close).not.toHaveBeenCalled();
    late.resolve();
    await finishing;
    expect(f.repository.assertPin).not.toHaveBeenCalled();
    expect(f.events).toEqual([
      'begin',
      'rolled-back',
      'close',
      'close',
      'release',
    ]);
  });
  it('a caught unknown settlement stops subsequent chunks and already prepared SQL guards', async () => {
    const f = fixture('competitor', 'batch-delete');
    f.repository.finishPin.mockRejectedValueOnce(new Error('pin ACK lost'));
    await f.run(async () => {
      const first = catalogTransactionExecution(),
        prepared = catalogTransactionExecution();
      await first.begin();
      await prepared.begin();
      await expect(first.settled('committed')).rejects.toThrow('pin ACK lost');
      await expect(catalogTransactionExecution().begin()).rejects.toMatchObject(
        { code: 'CATALOG_OPERATION_UNCERTAIN' },
      );
      await expect(prepared.guard({ execute: vi.fn() })).rejects.toMatchObject({
        code: 'CATALOG_OPERATION_UNCERTAIN',
      });
      await prepared.settled('rolled-back');
      f.patch({ status: 'failed' });
    });
    expect(f.repository.beginPin).toHaveBeenCalledTimes(2);
    expect(f.repository.assertPin).not.toHaveBeenCalled();
    expect(f.repository.release).not.toHaveBeenCalled();
  });

  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    for (const dependency of ['read', 'close', 'release'] as const) {
      it(`retries ${status} physical settlement after a single ${dependency} failure even with one Bull attempt`, async () => {
        const f = fixture('competitor', 'batch-delete');
        f.job.opts.attempts = 1;
        const originalError = new Error('original business failure');
        const result = { cancelled: status === 'cancelled', original: true };
        const business = vi.fn(async () => {
          const execution = catalogTransactionExecution();
          await execution.begin();
          await execution.guard({ execute: vi.fn() });
          await execution.settled(
            status === 'failed' ? 'rolled-back' : 'committed',
          );
          f.patch({ status, result });
          const method =
            dependency === 'read' ? f.store.read : f.repository[dependency];
          method.mockRejectedValueOnce(
            new Error('private settlement endpoint'),
          );
          if (status === 'failed') throw originalError;
          return result;
        });
        if (status === 'failed')
          await expect(f.run(business)).rejects.toBe(originalError);
        else await expect(f.run(business)).resolves.toEqual(result);
        expect(business).toHaveBeenCalledTimes(1);
        expect(f.repository.beginPin).toHaveBeenCalledTimes(1);
        expect(f.repository.finishPin).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ identity: f.identity }),
          status === 'failed' ? 'rolled-back' : 'committed',
        );
        expect(f.snapshot()).toBeNull();
        expect(f.repository.release).toHaveBeenCalledWith(f.identity);
        expect(JSON.stringify(f.log.warn.mock.calls)).not.toContain(
          'private settlement endpoint',
        );
      });
    }
    it(`recovers ${status} from its durable drained marker without invoking business or allocating another pin`, async () => {
      const f = fixture();
      const result = completedReplay(f);
      f.patch({ status });
      f.setSnapshot({ ...f.snapshot()!, state: 'closed', terminal: null });
      const original = await f.store.read();
      const business = vi.fn(async () => {
        throw new Error('must not repeat business');
      });
      if (status === 'failed')
        await expect(f.run(business)).rejects.toBeInstanceOf(
          UnrecoverableError,
        );
      else
        await expect(f.run(business)).resolves.toEqual(
          status === 'cancelled'
            ? {
                cancelled: true,
                message: '检查任务已取消，已提交的检查结果保留',
              }
            : result,
        );
      expect(business).not.toHaveBeenCalled();
      expect(f.repository.beginPin).not.toHaveBeenCalled();
      expect(f.repository.close).toHaveBeenCalledWith(f.identity, {
        status,
        source: 'worker',
        task: f.task,
      });
      expect(f.snapshot()).toBeNull();
      expect(await f.store.read()).toEqual(original);
    });
    it(`recovers ${status} after PostgreSQL applied the drained marker but its close ACK was lost`, async () => {
      const f = fixture();
      const close = f.repository.close.getMockImplementation()!;
      const business = vi.fn(async () => {
        const execution = catalogTransactionExecution();
        await execution.begin();
        await execution.settled('committed');
        f.patch({ status });
        f.repository.close.mockImplementationOnce(async (identity, proof) => {
          await close(identity, proof);
          throw new Error('private close ACK');
        });
        return { original: true };
      });
      await expect(f.run(business)).resolves.toEqual({ original: true });
      expect(business).toHaveBeenCalledTimes(1);
      expect(f.snapshot()).toBeNull();
      expect(f.repository.beginPin).toHaveBeenCalledTimes(1);
      expect(f.repository.release).toHaveBeenCalledWith(f.identity);
    });
    it(`recovers ${status} after terminal-proof COMMIT succeeded but its ACK was lost`, async () => {
      const f = fixture();
      const close = f.repository.close.getMockImplementation()!;
      let lost = false;
      f.repository.close.mockImplementation(async (identity, proof) => {
        await close(identity, proof);
        if (proof && !lost) {
          lost = true;
          throw new Error('private proof ACK');
        }
      });
      await expect(
        f.run(async () => {
          f.patch({ status });
          return 'original';
        }),
      ).resolves.toBe('original');
      expect(lost).toBe(true);
      expect(f.snapshot()).toBeNull();
      expect(f.repository.beginPin).not.toHaveBeenCalled();
      expect(JSON.stringify(f.log.warn.mock.calls)).not.toContain(
        'private proof ACK',
      );
    });
    it(`does not repeat business after ${status} release COMMIT succeeded but its ACK was lost`, async () => {
      const f = fixture();
      const release = f.repository.release.getMockImplementation()!;
      f.repository.release.mockImplementationOnce(async () => {
        await release();
        throw new Error('private release ACK');
      });
      const business = vi.fn(async () => {
        f.patch({ status });
        return 'original';
      });
      await expect(f.run(business)).resolves.toBe('original');
      expect(f.snapshot()).toBeNull();
      expect(business).toHaveBeenCalledTimes(1);
      expect(f.repository.release).toHaveBeenCalledTimes(1);
      expect(f.repository.beginPin).not.toHaveBeenCalled();
    });
    it(`a new Worker invocation recovers ${status} after proof storage failed three times following a durable marker`, async () => {
      const f = fixture();
      f.job.opts.attempts = 1;
      const result = completedReplay(f);
      f.patch({ status: 'pending', result: null });
      const close = f.repository.close.getMockImplementation()!;
      f.repository.close.mockImplementation(async (identity, proof) => {
        if (proof) throw new Error('private proof outage');
        await close(identity);
      });
      const business = vi.fn(async () => {
        const execution = catalogTransactionExecution();
        await execution.begin();
        await execution.guard({ execute: vi.fn() });
        await execution.settled(
          status === 'failed' ? 'rolled-back' : 'committed',
        );
        f.patch({ status, result });
        return result;
      });
      await expect(f.run(business)).rejects.toThrow('目录任务释放暂不可用');
      expect(f.snapshot()).toMatchObject({
        state: 'closed',
        terminal: null,
        pendingPins: 0,
        uncertainPins: 0,
      });
      expect(f.repository.release).not.toHaveBeenCalled();
      const original = await f.store.read();
      f.repository.close.mockImplementation(close);
      const forbidden = vi.fn(async () => {
        throw new Error('business cannot repeat');
      });
      if (status === 'failed')
        await expect(f.run(forbidden)).rejects.toBeInstanceOf(
          UnrecoverableError,
        );
      else
        await expect(f.run(forbidden)).resolves.toEqual(
          status === 'cancelled'
            ? {
                cancelled: true,
                message: '检查任务已取消，已提交的检查结果保留',
              }
            : result,
        );
      expect(f.snapshot()).toBeNull();
      expect(business).toHaveBeenCalledTimes(1);
      expect(forbidden).not.toHaveBeenCalled();
      expect(f.repository.beginPin).toHaveBeenCalledTimes(1);
      expect(await f.store.read()).toEqual(original);
    });
  }
  it('does not seal a still-active retryable failure and permits the next normal business attempt', async () => {
    const f = fixture();
    const error = new Error('retryable business error');
    await expect(
      f.run(async () => {
        const execution = catalogTransactionExecution();
        await execution.begin();
        await execution.settled('rolled-back');
        f.patch({ status: 'processing' });
        throw error;
      }),
    ).rejects.toBe(error);
    expect(f.snapshot()).toMatchObject({
      state: 'open',
      terminal: null,
      pendingPins: 0,
      uncertainPins: 0,
    });
    expect(f.repository.close).not.toHaveBeenCalled();
    expect(f.repository.release).not.toHaveBeenCalled();
    await expect(
      f.run(async () => {
        const execution = catalogTransactionExecution();
        await execution.begin();
        await execution.settled('committed');
        f.patch({ status: 'completed' });
        return 'retry completed';
      }),
    ).resolves.toBe('retry completed');
    expect(f.repository.beginPin).toHaveBeenCalledTimes(2);
    expect(f.snapshot()).toBeNull();
  });
  it.each([
    ['open', 0, 0],
    ['closed', 1, 0],
    ['uncertain', 0, 1],
  ] as const)(
    'terminal metadata leaves %s marker with pending=%s uncertain=%s untouched',
    async (state, pendingPins, uncertainPins) => {
      const f = fixture();
      const result = completedReplay(f);
      const original = {
        ...f.snapshot()!,
        state,
        pendingPins,
        uncertainPins,
        terminal: null,
      };
      f.setSnapshot(original);
      const business = vi.fn(async () => undefined);
      await expect(f.run(business)).resolves.toEqual(result);
      expect(f.snapshot()).toEqual(original);
      expect(business).not.toHaveBeenCalled();
      expect(f.repository.close).not.toHaveBeenCalled();
      expect(f.repository.release).not.toHaveBeenCalled();
    },
  );
  it.each([
    'taskId',
    'userId',
    'taskType',
    'taskSubType',
    'createdAt',
  ] as const)(
    'a drained marker with different %s binding is never released',
    async (field) => {
      const f = fixture();
      const result = completedReplay(f);
      const original = {
        ...f.snapshot()!,
        state: 'closed' as const,
        terminal: null,
        task: { ...f.task, [field]: 'changed' },
      };
      f.setSnapshot(original);
      const business = vi.fn(async () => undefined);
      await expect(f.run(business)).resolves.toEqual(result);
      expect(f.snapshot()).toEqual(original);
      expect(business).not.toHaveBeenCalled();
      expect(f.repository.beginPin).not.toHaveBeenCalled();
      expect(f.repository.close).not.toHaveBeenCalled();
      expect(f.repository.release).not.toHaveBeenCalled();
    },
  );
});
