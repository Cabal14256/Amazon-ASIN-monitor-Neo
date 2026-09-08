import type {
  AuthSessionRecord,
  AuthUserRecord,
  TaskState,
} from '@asin-monitor/db';
import { vi } from 'vitest';

export const taskUserId = 'owner-95',
  taskSessionId = 'session-95';
export function taskFixture(patch: Partial<TaskState> = {}): TaskState {
  return {
    taskId: 'task-95',
    userId: taskUserId,
    taskType: 'export',
    taskSubType: 'asin',
    title: 'ASIN 导出',
    status: 'pending',
    progress: 0,
    message: '任务已创建，等待处理',
    error: null,
    result: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    cancelRequestedAt: null,
    cancelledAt: null,
    revision: 0,
    ...patch,
  };
}
export function taskAuthFixture() {
  const user: AuthUserRecord = {
    id: taskUserId,
    username: 'fixture-owner',
    realName: null,
    status: 'ACTIVE',
    lastLoginTime: null,
    lastLoginIp: null,
    passwordExpiresAt: null,
    passwordChangedAt: null,
    forcePasswordChange: false,
    failedLoginAttempts: 0,
    lockedUntil: null,
    createTime: null,
    updateTime: null,
  };
  const session: AuthSessionRecord = {
    id: taskSessionId,
    userId: taskUserId,
    userAgent: null,
    ipAddress: null,
    status: 'ACTIVE',
    rememberMe: false,
    createdAt: new Date(),
    lastActiveAt: new Date(),
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  };
  return {
    user,
    session,
    repository: {
      findUserById: vi.fn(async () => user),
      findSessionById: vi.fn(async () => session),
      touchSession: vi.fn(),
      revokeSession: vi.fn(),
      markPasswordChangeRequired: vi.fn(),
      getPermissionCodes: vi.fn(async () => []),
      getRoles: vi.fn(async () => []),
      listSessionsByUserId: vi.fn(async () => []),
      revokeOwnedSession: vi.fn(async () => false),
    },
  };
}
