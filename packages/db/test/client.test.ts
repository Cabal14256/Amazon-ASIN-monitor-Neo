import { describe, expect, it } from 'vitest';

import { createPgPool, parseShanghaiTimestamp } from '../src/client';

describe('PostgreSQL timestamp without time zone D8 解析', () => {
  it('固定按 Asia/Shanghai 解释而不依赖 Node 宿主时区', () => {
    expect(
      parseShanghaiTimestamp('2026-09-01 15:54:39.123').toISOString(),
    ).toBe('2026-09-01T07:54:39.123Z');
  });

  it('每个共享连接池都安装相同的 OID 1114 parser', async () => {
    const pool = createPgPool('postgresql://localhost/test');
    try {
      const parser = pool.options.types?.getTypeParser(1114, 'text');
      expect(parser?.('2026-09-01 15:54:39').toISOString()).toBe(
        '2026-09-01T07:54:39.000Z',
      );
    } finally {
      await pool.end();
    }
  });
});
