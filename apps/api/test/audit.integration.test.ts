import { AuditRepository, createPgPool } from '@asin-monitor/db';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '../src/audit/audit.service';
import type { AppLogger } from '../src/logger/app-logger.service';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'AuditRepository PostgreSQL',
  () => {
    it('cancels a lock-blocked insert before pool shutdown without leaking SQL timeout settings', async () => {
      const blockerPool = createPgPool(process.env.DATABASE_URL!, {
        max: 1,
        connectionTimeoutMillis: 3000,
      });
      const pool = createPgPool(process.env.DATABASE_URL!, {
        max: 1,
        connectionTimeoutMillis: 3000,
      });
      const blocker = await blockerPool.connect();
      const resourceId = randomUUID();
      const log = { error: vi.fn(), warn: vi.fn() };
      const audit = new AuditService(
        new AuditRepository(pool),
        log as unknown as AppLogger,
      );
      let ended = false;
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE audit_logs IN ACCESS EXCLUSIVE MODE');
        const started = Date.now();
        audit.record({ action: 'CREATE', resource: 'asin', resourceId });
        await audit.onApplicationShutdown();
        expect(log.error).toHaveBeenCalledWith(
          '操作审计写入失败',
          'AuditService',
          { reason: 'audit_write_failed', code: '57014' },
        );
        expect(pool.totalCount).toBe(0);
        const { rows } = await pool.query('SHOW statement_timeout');
        expect(rows[0].statement_timeout).toBe('0');
        await pool.end();
        ended = true;
        expect(Date.now() - started).toBeLessThan(5_000);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        if (!ended) await pool.end();
        await blockerPool.query(
          'DELETE FROM audit_logs WHERE resource_id = $1',
          [resourceId],
        );
        await blockerPool.end();
      }
    });

    it('persists audit fields and JSON in the primary database without requiring a PG user replica', async () => {
      const pool = createPgPool(process.env.DATABASE_URL!, {
        max: 1,
        connectionTimeoutMillis: 3000,
      });
      const resourceId = randomUUID();
      try {
        await new AuditRepository(pool).append({
          userId: `legacy-${resourceId}`,
          username: 'audit-fixture',
          action: 'UPDATE',
          resource: 'asin',
          resourceId,
          resourceName: 'B012345678',
          method: 'PUT',
          path: '/api/v1/asins/:asinId',
          ipAddress: '198.51.100.23',
          userAgent: 'integration',
          requestData: { password: '***REDACTED***', name: 'fixture' },
          responseStatus: 403,
          errorMessage: '操作失败',
        });
        const { rows } = await pool.query(
          'SELECT * FROM audit_logs WHERE resource_id = $1',
          [resourceId],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          action: 'UPDATE',
          response_status: 403,
          user_id: `legacy-${resourceId}`,
          request_data: { password: '***REDACTED***', name: 'fixture' },
        });
        expect(rows[0].create_time).toBeInstanceOf(Date);
      } finally {
        await pool.query('DELETE FROM audit_logs WHERE resource_id = $1', [
          resourceId,
        ]);
        await pool.end();
      }
    });
  },
);
