import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PgAuthMaintenanceRepository } from '../src/repositories/auth-maintenance-repository';

describe('Authentication maintenance input bounds', () => {
  it.each([0, -1, 1001, 1.5, NaN, Infinity])(
    'rejects batch size %s before acquiring a connection',
    (limit) => {
      const connect = vi.fn();
      const repo = new PgAuthMaintenanceRepository({
        connect,
      } as unknown as Pool);
      expect(() => repo.cleanupSessions(limit)).toThrow(
        'Invalid maintenance batch size',
      );
      expect(() => repo.archiveAuditLogs(90, limit)).toThrow(
        'Invalid maintenance batch size',
      );
      expect(connect).not.toHaveBeenCalled();
    },
  );
  it.each([0, -1, 3651, 1.5, NaN])(
    'rejects retention days %s before acquiring a connection',
    (days) => {
      const connect = vi.fn();
      const repo = new PgAuthMaintenanceRepository({
        connect,
      } as unknown as Pool);
      expect(() => repo.archiveAuditLogs(days)).toThrow(
        'Invalid audit retention days',
      );
      expect(connect).not.toHaveBeenCalled();
    },
  );
  it('rejects invalid or unsupported dates before opening a transaction', () => {
    const connect = vi.fn();
    const repo = new PgAuthMaintenanceRepository({
      connect,
    } as unknown as Pool);
    expect(() => repo.cleanupSessions(1, new Date(NaN))).toThrow(
      'Invalid timestamp instant',
    );
    expect(() =>
      repo.archiveAuditLogs(90, 1, new Date('+010000-01-01T00:00:00Z')),
    ).toThrow('Unsupported maintenance timestamp');
    expect(connect).not.toHaveBeenCalled();
  });
});
