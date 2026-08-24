import { describe, expect, it } from 'vitest';

import {
  getPhysicalQueueName,
  QUEUE_NAMES,
  resolveEnabledQueues,
  resolveQueueSelection,
  shouldInitializeQueueRuntime,
} from '../src/queues';

describe('队列注册表', () => {
  it('恰好包含旧系统 8 个队列', () => {
    expect(QUEUE_NAMES).toEqual([
      'monitor',
      'competitor-monitor',
      'export',
      'import',
      'batch-check',
      'batch-delete',
      'backup',
      'variant-check',
    ]);
  });

  it('未设置 WORKER_ENABLED_QUEUES 时启用全部', () => {
    expect(resolveEnabledQueues(undefined)).toEqual([...QUEUE_NAMES]);
    expect(resolveEnabledQueues('')).toEqual([...QUEUE_NAMES]);
    expect(resolveEnabledQueues('   ')).toEqual([...QUEUE_NAMES]);
  });

  it('按逗号选择子集并容忍空白', () => {
    expect(resolveEnabledQueues('monitor, export')).toEqual([
      'monitor',
      'export',
    ]);
  });

  it('兼容 all/*、none/off 与旧选择器别名', () => {
    expect(resolveEnabledQueues('all')).toEqual([...QUEUE_NAMES]);
    expect(resolveEnabledQueues('*')).toEqual([...QUEUE_NAMES]);
    expect(resolveEnabledQueues('none,off')).toEqual([]);
    expect(shouldInitializeQueueRuntime(resolveEnabledQueues('none'))).toBe(
      false,
    );
    expect(shouldInitializeQueueRuntime(resolveEnabledQueues('monitor'))).toBe(
      true,
    );
    expect(resolveEnabledQueues('competitor,batchCheck,variantCheck')).toEqual([
      'competitor-monitor',
      'batch-check',
      'variant-check',
    ]);
  });

  it('选择器解析为旧系统物理队列名', () => {
    expect(getPhysicalQueueName('monitor')).toBe('monitor-task-queue');
    expect(getPhysicalQueueName('competitor-monitor')).toBe(
      'competitor-monitor-task-queue',
    );
    expect(getPhysicalQueueName('export')).toBe('export-task-queue');
  });

  it('忽略未知队列并保留有效选择器供 Worker 继续启动', () => {
    expect(resolveQueueSelection('monitor,old-export')).toEqual({
      enabledQueues: ['monitor'],
      unknownQueues: ['old-export'],
    });
    expect(resolveEnabledQueues('monitor,old-export')).toEqual(['monitor']);
  });
});
