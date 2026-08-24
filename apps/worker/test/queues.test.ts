import { describe, expect, it } from 'vitest';

import { QUEUE_NAMES, resolveEnabledQueues } from '../src/queues';

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

  it('未知队列名直接报错', () => {
    expect(() => resolveEnabledQueues('monitor,nope')).toThrow(/未知队列/);
  });
});
