import type { Pool, PoolClient } from 'pg';
import { createDb } from '../client';
import { auditLogs, type NewAuditLog } from '../schema';

export type AuditEntry = Omit<NewAuditLog, 'id' | 'createTime'>;

export interface AuditRepositoryPort {
  append(entry: AuditEntry): Promise<void>;
}

export const AUDIT_MAX_ACTIVE_WRITES = 2;

/** 操作审计写入 Neo 主库；身份允许来自双跑期的 MySQL 权威源。 */
export class AuditRepository implements AuditRepositoryPort {
  private activeOperations = 0;
  constructor(private readonly pool: Pool) {}

  append(entry: AuditEntry): Promise<void> {
    if (this.activeOperations >= AUDIT_MAX_ACTIVE_WRITES) {
      return Promise.reject(
        Object.assign(new Error('audit operations at capacity'), {
          code: '53300',
        }),
      );
    }
    this.activeOperations += 1;
    // Bound acquisition and actual I/O, not just the caller's flush await.
    // Only this exclusive audit transaction receives a SQL timeout.
    return new Promise<void>((resolve, reject) => {
      let client: PoolClient | undefined;
      let settled = false;
      let slotReleased = false;
      const releaseSlot = () => {
        if (slotReleased) return;
        slotReleased = true;
        this.activeOperations -= 1;
      };
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (client) {
          client.removeListener('error', onError);
          client.release(error !== undefined);
          releaseSlot();
        }
        if (error !== undefined) reject(error);
        else resolve();
      };
      const onError = (error: Error) => finish(error);
      const timeoutError = Object.assign(
        new Error('audit write deadline exceeded'),
        { code: 'ETIMEDOUT' },
      );
      const timer = setTimeout(() => finish(timeoutError), 2_000);
      void Promise.resolve()
        .then(() => this.pool.connect())
        .then(async (acquired) => {
          if (settled) {
            // Acquisition may complete after the deadline; never execute late work.
            acquired.release();
            releaseSlot();
            return;
          }
          client = acquired;
          client.on('error', onError);
          await client.query('BEGIN');
          if (settled) return;
          await client.query('SET LOCAL statement_timeout = 1500');
          if (settled) return;
          await createDb(client).insert(auditLogs).values(entry);
          if (settled) return;
          await client.query('COMMIT');
          finish();
        })
        .catch((error: unknown) => {
          finish(error);
          releaseSlot();
        });
    });
  }
}
