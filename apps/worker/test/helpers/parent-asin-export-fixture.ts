import type {
  ParentAsinExportJobData,
  ParentAsinQueryItem,
} from '@asin-monitor/contracts';
import { transitionTask, type TaskState } from '@asin-monitor/db';
import { ExportArtifactStore } from '@asin-monitor/export';
import {
  CatalogParentQuery,
  parseCatalogVariantResult,
  type CatalogVariantChecker,
} from '@asin-monitor/sp-api';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { createParentAsinExportProcessor } from '../../src/parent-asin-export-processor';

export const parentExportAt = new Date('2026-09-26T16:01:02.000Z');
export async function parentExportFixture(maxBytes?: number) {
  const taskId = randomUUID();
  const data: ParentAsinExportJobData = {
    taskId,
    userId: 'owner',
    taskType: 'export',
    taskSubType: 'parent-asin-query',
    exportType: 'parent-asin-query',
    createdAt: parentExportAt.toISOString(),
    params: {
      asins: ['B000000001', 'B000000004', 'B000000002', 'B000000001'],
      country: 'US',
    },
  };
  let state = {
    ...data,
    title: '父变体查询结果导出',
    status: 'pending',
    progress: 0,
    message: '',
    error: null,
    result: null,
    updatedAt: data.createdAt,
    startedAt: null,
    completedAt: null,
    cancelRequestedAt: null,
    cancelledAt: null,
    revision: 0,
  } as TaskState;
  const directory = await mkdtemp(join(tmpdir(), 'neo-parent-export-'));
  const artifacts = new ExportArtifactStore(directory, maxBytes);
  const checker = {
    check: vi.fn<CatalogVariantChecker['check']>(async (asin) => {
      if (asin === 'B000000002') throw new Error('private upstream detail');
      return parseCatalogVariantResult(
        {
          asin,
          summaries: [{ itemName: '=literal ' + asin, brand: 'Fixture' }],
          relationships:
            asin === 'B000000004'
              ? []
              : [
                  {
                    relationships: [
                      {
                        type: 'VARIATION',
                        ...(asin === 'B000000003'
                          ? { childAsins: ['B000000001'] }
                          : { parentAsins: ['B000000003'] }),
                      },
                    ],
                  },
                ],
        },
        asin,
      );
    }),
  };
  const parents = new CatalogParentQuery(checker);
  let returned: ParentAsinQueryItem[] = [],
    lostAck = false;
  const query = vi.fn<CatalogParentQuery['query']>(async (...args) => {
    returned = await parents.query(...args);
    return returned;
  });
  const store = {
    read: vi.fn(async () => state),
    mutate: vi.fn(
      async (
        _id: string,
        change: Parameters<typeof transitionTask>[1],
        identity?: Record<string, unknown>,
      ) => {
        if (
          Object.entries(identity ?? {}).some(
            ([key, value]) => state[key as keyof TaskState] !== value,
          )
        )
          throw new Error('wrong identity');
        if (lostAck && change.kind === 'completed') throw new Error('ACK lost');
        return (state = transitionTask(state, change, parentExportAt));
      },
    ),
  };
  const shutdown = new AbortController();
  const options = {
    shutdownSignal: shutdown.signal,
    isClosing: () => false,
    authorize: vi.fn(async (_id: string) => undefined),
    assertJobLock: vi.fn(async () => undefined),
    updateProgress: vi.fn(async () => undefined),
    now: () => parentExportAt,
  };
  const processor = createParentAsinExportProcessor(
    { query },
    store,
    artifacts,
    options,
  );
  const job = {
    id: taskId,
    name: data.exportType,
    data,
    attemptsMade: 0,
    opts: { attempts: 2 },
  };
  return {
    taskId,
    data,
    directory,
    artifacts,
    checker,
    query,
    store,
    shutdown,
    options,
    job,
    processor,
    get state() {
      return state;
    },
    get returned() {
      return returned;
    },
    loseAck(value: boolean) {
      lostAck = value;
    },
    cancel() {
      state = transitionTask(state, { kind: 'cancel-request' }, parentExportAt);
    },
    async close() {
      parents.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
