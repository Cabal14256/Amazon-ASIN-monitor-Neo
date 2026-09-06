import type { TaskInfo, WsMessage } from '@asin-monitor/contracts';
import { vi } from 'vitest';

export const taskFixture = (patch: Partial<TaskInfo> = {}): TaskInfo => ({
  taskId: 'job-1',
  taskType: 'export',
  taskSubType: 'asin',
  title: 'Fixture export',
  status: 'processing',
  progress: 35,
  message: '正在处理',
  error: null,
  createdAt: null,
  updatedAt: null,
  startedAt: null,
  completedAt: null,
  cancelRequestedAt: null,
  cancelledAt: null,
  canCancel: true,
  filename: null,
  downloadUrl: null,
  result: null,
  ...patch,
});

export const completedMessage = (taskId = 'job-1'): WsMessage => ({
  type: 'task_complete',
  taskId,
  timestamp: '2026-09-06T00:00:00Z',
  filename: 'hint.xlsx',
  downloadUrl: 'https://untrusted.test/hint.xlsx',
});

export class TaskMessageFixture {
  readonly handlers = new Set<(message: WsMessage) => void>();
  onMessage = vi.fn((handler: (message: WsMessage) => void) => {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  });
  emit(message: WsMessage) {
    for (const handler of [...this.handlers]) handler(message);
  }
}
