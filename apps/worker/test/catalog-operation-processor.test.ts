import {
  assertCatalogWriteExecution,
  CatalogOperationError,
  catalogTransactionExecution,
  type CatalogOperationIdentity,
  type CatalogOperationPin,
  type CatalogOperationSnapshot,
  type CatalogOperationTerminalProof,
  type CatalogPhysicalOutcome,
  type CatalogTaskBinding,
  type PgCatalogOperationRepository,
  type TaskState,
} from '@asin-monitor/db';
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
        expect(f.repository.close).toHaveBeenCalledExactlyOnceWith(f.identity, {
          status: 'completed',
          source: 'worker',
          task: f.task,
        });
        expect(f.events).toEqual(['begin', 'committed', 'close', 'release']);
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
        expect(f.events).toEqual(['begin', outcome, 'close', 'release']);
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
      f.patch({ status: 'completed' });
      return { success: true };
    });
    expect(f.snapshot()).toMatchObject({
      state: 'uncertain',
      uncertainPins: 1,
    });
    expect(f.repository.close).not.toHaveBeenCalled();
    expect(f.repository.release).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2030-09-27T00:30:00.000Z'));
    const retry = vi.fn(async () => undefined);
    await expect(f.run(retry)).rejects.toThrow('目录操作状态暂不可用');
    expect(retry).not.toHaveBeenCalled();
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
    'closed %s blocks a late/retried business run',
    async (status) => {
      const f = fixture();
      f.patch({ status });
      f.setSnapshot({
        ...f.snapshot()!,
        state: 'closed',
        terminal: { status, source: 'worker', task: f.task },
      });
      const business = vi.fn(async () => undefined);
      await expect(f.run(business)).rejects.toBeInstanceOf(UnrecoverableError);
      expect(business).not.toHaveBeenCalled();
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
  it('preserves the gate when final metadata read is unavailable and logs only fixed context', async () => {
    const f = fixture();
    await expect(
      f.run(async () => {
        f.patch({ status: 'completed' });
        f.store.read.mockRejectedValueOnce(new Error('private endpoint'));
        return 'completed';
      }),
    ).resolves.toBe('completed');
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
    expect(f.events).toEqual(['begin', 'rolled-back', 'close', 'release']);
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
});
