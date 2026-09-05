import { AuditRepository, createDb, createPgPool } from '@asin-monitor/db';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'AuditRepository PostgreSQL',
  () => {
    it('persists audit fields and JSON in the primary database without requiring a PG user replica', async () => {
      const pool = createPgPool(process.env.DATABASE_URL!, {
        max: 1,
        connectionTimeoutMillis: 3000,
      });
      const resourceId = randomUUID();
      try {
        await new AuditRepository(createDb(pool)).append({
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
