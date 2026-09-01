import { describe, expect, it } from 'vitest';

import {
  createPgPool,
  createShanghaiTimestampTypeOverrides,
  parseShanghaiTimestamp,
} from '../src/client';

describe('PostgreSQL timestamp without time zone D8 解析', () => {
  it('固定按 Asia/Shanghai 解释而不依赖 Node 宿主时区', () => {
    expect(
      parseShanghaiTimestamp('2026-09-01 15:54:39.123').toISOString(),
    ).toBe('2026-09-01T07:54:39.123Z');
  });

  it('API 可为共享连接池显式安装 OID 1114 parser', async () => {
    const pool = createPgPool('postgresql://localhost/test', {
      types: createShanghaiTimestampTypeOverrides(),
    });
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
