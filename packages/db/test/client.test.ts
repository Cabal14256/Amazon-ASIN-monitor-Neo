import type { Pool } from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';

import {
  createPgPool,
  createShanghaiTimestampTypeOverrides,
  parseShanghaiTimestamp,
} from '../src/client';
import { LegacyMysqlSessionRepository } from '../src/repositories/legacy-mysql-session-repository';

const legacyConfig = {
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: 'unused',
  database: 'amazon_asin_monitor',
  connectionLimit: 5,
  connectTimeoutMs: 1_000,
  queryTimeoutMs: 2_000,
};

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

describe('Legacy MySQL Session 权威 repository', () => {
  it('参数化读取并按 D8 将 MySQL DATETIME 映射为 Session 记录', async () => {
    const query = vi.fn().mockResolvedValue([
      [
        {
          id: 'session-1',
          user_id: 'user-1',
          user_agent: null,
          ip_address: '127.0.0.1',
          status: 'ACTIVE',
          remember_me: 1,
          created_at: '2026-09-01 15:54:39.123',
          last_active_at: '2026-09-01 16:00:00.000',
          expires_at: '2026-09-02 15:54:39.123',
        },
      ],
      [],
    ]);
    const repository = new LegacyMysqlSessionRepository(legacyConfig, {
      query,
      end: vi.fn(),
    } as unknown as Pool);

    await expect(
      repository.findSessionById('session-1'),
    ).resolves.toMatchObject({
      id: 'session-1',
      userId: 'user-1',
      rememberMe: true,
      createdAt: new Date('2026-09-01T07:54:39.123Z'),
      expiresAt: new Date('2026-09-02T07:54:39.123Z'),
    });
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        values: ['session-1'],
        timeout: legacyConfig.queryTimeoutMs,
      }),
    );
  });

  it('撤销、touch 与连接池关闭保持参数化且关闭幂等', async () => {
    const query = vi.fn().mockResolvedValue([{}, []]);
    const end = vi.fn().mockResolvedValue(undefined);
    const repository = new LegacyMysqlSessionRepository(legacyConfig, {
      query,
      end,
    } as unknown as Pool);

    await repository.revokeSession('session-2');
    await repository.touchSession('session-2');
    await repository.onModuleDestroy();
    await repository.onModuleDestroy();

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ values: ['session-2'] }),
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ values: ['session-2'] }),
    );
    expect(end).toHaveBeenCalledOnce();
  });
});
