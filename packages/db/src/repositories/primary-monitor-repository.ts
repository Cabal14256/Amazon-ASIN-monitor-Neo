import type { PrimaryMonitorJob } from '@asin-monitor/contracts';
import type { Pool, PoolClient } from 'pg';
import { createDb } from '../client';
import type { CatalogPhysicalOutcome } from '../domain/catalog-operation';
import {
  assertCatalogWriteExecution,
  catalogTransactionExecution,
} from './catalog-operation-execution';

export interface PrimaryMonitorGroup {
  country: PrimaryMonitorJob['countries'][number];
  groupId: string;
}
export type NotificationClaim = 'new' | 'claimed' | 'sent' | 'failed';
const MAX_GROUPS = 1000;

/** The PostgreSQL snapshot makes a retry resume the same ordered catalog. */
export class PgPrimaryMonitorRepository {
  constructor(private readonly pool: Pool) {}
  async assertReady(): Promise<void> {
    await this.pool.query(
      `SELECT run.task_id, notice.country, history.monitor_task_id
       FROM primary_monitor_runs AS run
       LEFT JOIN primary_monitor_notifications AS notice ON notice.task_id=run.task_id
       LEFT JOIN monitor_history AS history ON history.monitor_task_id=run.task_id
       LIMIT 0`,
    );
  }
  async purgeExpiredRuns(): Promise<number> {
    const removed = await this.pool.query(
      `DELETE FROM primary_monitor_runs WHERE task_id IN (
         SELECT task_id FROM primary_monitor_runs
         WHERE expires_at < now()
         ORDER BY expires_at, task_id LIMIT 1000 FOR UPDATE SKIP LOCKED
       )`,
    );
    return removed.rowCount ?? 0;
  }
  private async transaction<T>(action: (client: PoolClient) => Promise<T>) {
    const execution = catalogTransactionExecution();
    await execution.begin();
    let client: PoolClient | undefined;
    let commitStarted = false;
    let connectionFailed = false;
    let outcome: CatalogPhysicalOutcome = 'uncertain';
    const connectionError = () => {
      connectionFailed = true;
    };
    try {
      client = await this.pool.connect();
      client.on('error', connectionError);
      await client.query('BEGIN');
      const db = createDb(client);
      await execution.guard(db);
      // Actual notification/snapshot writes are catalog work. Only internal
      // scheduled monitors may omit the owner fence; anonymous checks may not.
      assertCatalogWriteExecution(db, 'asin', 'scheduled-system');
      if (connectionFailed) throw new Error('MONITOR_DATABASE_CONNECTION_LOST');
      const value = await action(client);
      if (connectionFailed) throw new Error('MONITOR_DATABASE_CONNECTION_LOST');
      commitStarted = true;
      await client.query('COMMIT');
      if (connectionFailed)
        throw new Error('MONITOR_DATABASE_COMMIT_UNCERTAIN');
      outcome = 'committed';
      return value;
    } catch (error) {
      if (!client) outcome = 'rolled-back'; // No SQL was started.
      else if (!commitStarted && !connectionFailed) {
        try {
          await client.query('ROLLBACK');
          if (!connectionFailed) outcome = 'rolled-back';
        } catch {
          // A failed ROLLBACK or lost COMMIT ACK must keep its durable pin.
        }
      }
      throw error;
    } finally {
      try {
        client?.removeListener('error', connectionError);
        client?.release(outcome === 'uncertain');
      } finally {
        // Record physical settlement only after the actual query promise has
        // ended and the borrowed client is returned. The Worker may have
        // already timed out/cancelled its outer promise without stopping SQL.
        await execution.settled(outcome);
      }
    }
  }
  async groups(job: PrimaryMonitorJob): Promise<PrimaryMonitorGroup[]> {
    return this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('neo:primary-monitor:' || $1, 0))",
        [job.taskId],
      );
      const existing = await client.query<{
        user_id: string;
        task_created_at: string;
        countries: unknown;
        groups: unknown;
      }>(
        'SELECT user_id, task_created_at, countries, groups FROM primary_monitor_runs WHERE task_id=$1',
        [job.taskId],
      );
      if (existing.rowCount) {
        const row = existing.rows[0];
        if (
          row.user_id !== job.userId ||
          row.task_created_at !== job.createdAt ||
          JSON.stringify(row.countries) !== JSON.stringify(job.countries) ||
          !Array.isArray(row.groups) ||
          row.groups.length > MAX_GROUPS ||
          row.groups.some((item) => {
            const group = item as Partial<PrimaryMonitorGroup>;
            return (
              !group ||
              !job.countries.includes(group.country!) ||
              typeof group.groupId !== 'string' ||
              !group.groupId ||
              group.groupId.length > 50
            );
          })
        )
          throw new Error('MONITOR_SNAPSHOT_IDENTITY_CHANGED');
        return row.groups as PrimaryMonitorGroup[];
      }
      const selected = await client.query<{ id: string; country: string }>(
        `SELECT id, upper(rtrim(country)) AS country FROM variant_groups
         WHERE upper(rtrim(country)) = ANY($1::text[])
           AND COALESCE(is_competitor, false) = false
         ORDER BY array_position($1::text[], upper(rtrim(country))), id
         LIMIT $2`,
        [job.countries, MAX_GROUPS + 1],
      );
      if (selected.rows.length > MAX_GROUPS)
        throw new Error('MONITOR_GROUP_LIMIT');
      const groups = selected.rows.map((row) => ({
        country: row.country as PrimaryMonitorGroup['country'],
        groupId: row.id,
      }));
      await client.query(
        `INSERT INTO primary_monitor_runs
         (task_id,user_id,task_created_at,countries,groups,expires_at)
         VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::timestamptz)`,
        [
          job.taskId,
          job.userId,
          job.createdAt,
          JSON.stringify(job.countries),
          JSON.stringify(groups),
          job.expiresAt,
        ],
      );
      return groups;
    });
  }
  async claimNotification(
    taskId: string,
    country: string,
  ): Promise<NotificationClaim> {
    return this.transaction(async (client) => {
      const claimed = await client.query(
        `INSERT INTO primary_monitor_notifications(task_id,country)
         VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING state`,
        [taskId, country],
      );
      if (claimed.rowCount) return 'new';
      const existing = await client.query<{ state: NotificationClaim }>(
        'SELECT state FROM primary_monitor_notifications WHERE task_id=$1 AND country=$2',
        [taskId, country],
      );
      if (!existing.rowCount)
        throw new Error('MONITOR_NOTIFICATION_CLAIM_LOST');
      return existing.rows[0].state;
    });
  }
  async completeNotification(
    taskId: string,
    country: string,
    sent: boolean,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const updated = await client.query(
        `UPDATE primary_monitor_notifications
         SET state=$3, completed_at=now()
         WHERE task_id=$1 AND country=$2 AND state='claimed'`,
        [taskId, country, sent ? 'sent' : 'failed'],
      );
      if (updated.rowCount !== 1)
        throw new Error('MONITOR_NOTIFICATION_CLAIM_CHANGED');
      if (sent)
        await client.query(
          `UPDATE monitor_history SET notification_sent=true
           WHERE monitor_task_id=$1 AND country=$2 AND is_broken=true`,
          [taskId, country],
        );
    });
  }
}
