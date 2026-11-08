import type { MonitorHistoryExportJobData } from '@asin-monitor/contracts';
import {
  transitionTask,
  type MonitorHistoryExportRepositoryPort,
  type MonitorHistoryExportRow,
  type TaskState,
} from '@asin-monitor/db';
import { ExportArtifactStore } from '@asin-monitor/export';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { createMonitorHistoryExportProcessor } from '../../src/monitor-history-export-processor';

export const historyExportAt = new Date('2026-09-26T16:01:02.000Z');
export const historyExportRecords = (): MonitorHistoryExportRow[] => [
  {
    cursor: {
      id: '9223372036854775807',
      checkTime: '2026-09-27 00:00:00.123456',
    },
    record: {
      checkTime: '2026-09-27 00:00:00',
      checkType: 'GROUP',
      variantGroupName: '=literal',
      asin: null,
      asinName: null,
      asinType: 'MAIN_LINK',
      country: 'US',
      isBroken: 1,
      checkResult: JSON.stringify({
        source: 'MANUAL_ACTION',
        action: 'MARK_BROKEN',
        statusSource: 'AUTO+MANUAL',
        reason: '原因,引号"\n换行',
        operator: 'Fixture operator',
        details: { fixture: true },
      }),
    },
  },
  {
    cursor: { id: '9007199254740993', checkTime: '2026-09-27 00:00:00.123456' },
    record: {
      checkTime: '2026-09-27 00:00:00',
      checkType: 'ASIN',
      variantGroupName: 'Other',
      asin: 'B000000001',
      asinName: 'Title',
      asinType: 'SUB_REVIEW',
      country: 'DE',
      isBroken: 0,
      checkResult: JSON.stringify({
        source: 'MANUAL_ACTION',
        action: 'CLEAR',
        statusSource: true,
        manualBrokenReason: 'Fallback reason',
        manualBrokenUpdatedBy: 7,
      }),
    },
  },
  {
    cursor: { id: '2', checkTime: '2026-09-26 23:00:00' },
    record: {
      checkTime: '2026-09-26 23:00:00',
      checkType: 'OTHER',
      variantGroupName: null,
      asin: null,
      asinName: null,
      asinType: 'other',
      country: 'FR',
      isBroken: null,
      checkResult: 'null',
    },
  },
  {
    cursor: { id: '1', checkTime: '2026-09-26 22:00:00' },
    record: {
      checkTime: '2026-09-26 22:00:00',
      checkType: null,
      variantGroupName: '',
      asin: '',
      asinName: '',
      asinType: null,
      country: 'US',
      isBroken: null,
      checkResult: null,
    },
  },
];
export async function historyExportFixture(maxBytes?: number) {
  const taskId = randomUUID(),
    directory = await mkdtemp(join(tmpdir(), 'neo-history-export-'));
  const data: MonitorHistoryExportJobData = {
    taskId,
    userId: 'owner',
    taskType: 'export',
    taskSubType: 'monitor-history',
    exportType: 'monitor-history',
    createdAt: historyExportAt.toISOString(),
    params: { country: 'US', startTime: '2026-09-01', endTime: '2026-10-01' },
  };
  let state = {
    ...data,
    title: '监控历史导出',
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
  let rows = historyExportRecords(),
    lostAck = false;
  const page = vi.fn(
    async (
      _params: MonitorHistoryExportJobData['params'],
      cursor?: MonitorHistoryExportRow['cursor'],
    ) => {
      const after = cursor
        ? rows.findIndex(
            (row) =>
              row.cursor.id === cursor.id &&
              row.cursor.checkTime === cursor.checkTime,
          ) + 1
        : 0;
      return rows.slice(after, after + 500);
    },
  );
  const repository: MonitorHistoryExportRepositoryPort = {
    read: async (action) => action({ page }, () => undefined),
  };
  const read = vi.spyOn(repository, 'read');
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
          throw new Error('Wrong identity');
        if (lostAck && change.kind === 'completed')
          throw new Error('Completion ACK lost');
        return (state = transitionTask(state, change, historyExportAt));
      },
    ),
  };
  const artifacts = new ExportArtifactStore(directory, maxBytes),
    shutdown = new AbortController();
  const options = {
    shutdownSignal: shutdown.signal,
    isClosing: () => false,
    authorize: vi.fn(async (_id: string) => undefined),
    assertJobLock: vi.fn(async () => undefined),
    updateProgress: vi.fn(async () => undefined),
    now: () => historyExportAt,
  };
  const processor = createMonitorHistoryExportProcessor(
    repository,
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
    directory,
    data,
    repository,
    page,
    read,
    store,
    artifacts,
    shutdown,
    options,
    processor,
    job,
    get state() {
      return state;
    },
    get rows() {
      return rows;
    },
    setRows(next: MonitorHistoryExportRow[]) {
      rows = next;
    },
    loseAck(value: boolean) {
      lostAck = value;
    },
    cancel() {
      state = transitionTask(
        state,
        { kind: 'cancel-request' },
        historyExportAt,
      );
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
