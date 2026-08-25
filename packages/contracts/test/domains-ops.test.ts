import { describe, expect, it } from 'vitest';

import {
  backupConfigResultSchema,
  backupListResultSchema,
  createBackupResultSchema,
  saveBackupConfigRequestSchema,
} from '../src/domains/backup';
import { parentAsinQueryExportQuerySchema } from '../src/domains/export';
import {
  createExportTaskRequestSchema,
  taskInfoResultSchema,
  taskListResultSchema,
} from '../src/domains/tasks';

/**
 * tasks / backup / export 域契约测试。
 */

describe('tasks 域', () => {
  it('任务信息含完整生命周期字段', () => {
    const parsed = taskInfoResultSchema.parse({
      success: true,
      errorCode: 0,
      data: {
        taskId: 't1',
        taskType: 'export',
        taskSubType: 'asin',
        title: 'ASIN导出',
        status: 'completed',
        progress: 100,
        message: '导出完成',
        error: null,
        createdAt: '2026-08-24T10:00:00Z',
        updatedAt: null,
        startedAt: null,
        completedAt: '2026-08-24T10:01:00Z',
        cancelRequestedAt: null,
        cancelledAt: null,
        canCancel: false,
        filename: '导出.xlsx',
        downloadUrl: '/api/tasks/t1/download',
        result: { filename: '导出.xlsx' },
      },
    });
    expect(parsed.data?.status).toBe('completed');
  });

  it('任务列表为任务数组', () => {
    const parsed = taskListResultSchema.parse({ success: true, data: [] });
    expect(parsed.data).toEqual([]);
  });

  it('导出任务请求校验 exportType 枚举', () => {
    expect(() =>
      createExportTaskRequestSchema.parse({ exportType: 'unknown' }),
    ).toThrow();
    expect(
      createExportTaskRequestSchema.parse({
        exportType: 'monitor-history',
        params: { country: 'US' },
      }).exportType,
    ).toBe('monitor-history');
  });
});

describe('backup 域', () => {
  it('备份列表项含 filename/size/createdAt', () => {
    const parsed = backupListResultSchema.parse({
      success: true,
      data: [
        {
          filename: 'backup_20260824.sql',
          size: 1024,
          createdAt: '2026-08-24',
        },
      ],
    });
    expect(parsed.data?.[0].size).toBe(1024);
  });

  it('创建备份同步/异步受理均可解析', () => {
    expect(
      createBackupResultSchema.parse({
        success: true,
        data: { filename: 'b.sql', size: 1, createdAt: 't' },
      }).data,
    ).toMatchObject({ filename: 'b.sql' });
    expect(
      createBackupResultSchema.parse({
        success: true,
        data: { taskId: 'bt1', status: 'pending' },
      }).data,
    ).toMatchObject({ taskId: 'bt1' });
  });

  it('备份配置含默认值形态（无记录时 id 为 null）', () => {
    const parsed = backupConfigResultSchema.parse({
      success: true,
      data: {
        id: null,
        enabled: false,
        scheduleType: 'daily',
        scheduleValue: null,
        backupTime: '03:00',
      },
    });
    expect(parsed.data?.enabled).toBe(false);
  });

  it('每周与每月备份的 scheduleValue 使用 INT 数字', () => {
    expect(
      saveBackupConfigRequestSchema.parse({
        scheduleType: 'weekly',
        scheduleValue: 7,
      }).scheduleValue,
    ).toBe(7);
    expect(
      backupConfigResultSchema.parse({
        success: true,
        data: {
          id: 1,
          enabled: true,
          scheduleType: 'monthly',
          scheduleValue: 31,
          backupTime: '02:00',
          createTime: '2026-08-24T10:00:00Z',
          updateTime: '2026-08-25T10:00:00Z',
        },
      }).data,
    ).toMatchObject({
      scheduleValue: 31,
      createTime: '2026-08-24T10:00:00Z',
      updateTime: '2026-08-25T10:00:00Z',
    });
    expect(saveBackupConfigRequestSchema.parse({ enabled: 0 }).enabled).toBe(0);
    expect(() =>
      saveBackupConfigRequestSchema.parse({ enabled: 'false' }),
    ).toThrow();
  });
});

describe('export 域（流端点）', () => {
  it('父变体导出 query 要求 asins 与 country', () => {
    expect(() =>
      parentAsinQueryExportQuerySchema.parse({ asins: 'B0ABC12345' }),
    ).toThrow();
    expect(
      parentAsinQueryExportQuerySchema.parse({
        asins: 'B0ABC12345,B0DEF67890',
        country: 'US',
        useProgress: 'false',
      }).country,
    ).toBe('US');
  });
});
