import { afterEach, describe, expect, it, vi } from 'vitest';

import { runApi } from '../src/runner';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('API 启动失败', () => {
  it('经 AppLogger 记录最小 Error 并以失败码退出', async () => {
    const failure = Object.assign(new Error('listen failed'), {
      authorization: 'Bearer secret',
    });
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const exit = vi.fn();

    await runApi(async () => Promise.reject(failure), undefined, exit);

    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('[ERROR] [Bootstrap]'),
      'API 启动失败',
      { name: 'Error', message: 'listen failed' },
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain('Bearer secret');
  });
});
