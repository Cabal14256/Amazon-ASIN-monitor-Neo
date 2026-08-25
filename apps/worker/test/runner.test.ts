import { afterEach, describe, expect, it, vi } from 'vitest';

import { runWorker } from '../src/runner';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Worker 启动失败', () => {
  it('仅记录 Error 最小上下文并以失败码退出', async () => {
    const password = 'super-secret-password';
    const failure = Object.assign(new Error('REDIS_URL 格式无效'), {
      input: `redis://user:${password}@`,
    });
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const exit = vi.fn();

    await runWorker(async () => Promise.reject(failure), exit);

    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith('[ERROR] [worker]', 'Worker 启动失败', {
      name: 'Error',
      message: 'REDIS_URL 格式无效',
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain(password);
  });
});
