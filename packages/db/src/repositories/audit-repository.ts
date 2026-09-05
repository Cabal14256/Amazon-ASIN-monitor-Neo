import type { Db } from '../client';
import { auditLogs, type NewAuditLog } from '../schema';

export type AuditEntry = Omit<NewAuditLog, 'id' | 'createTime'>;

export interface AuditRepositoryPort {
  append(entry: AuditEntry): Promise<void>;
}

/** 操作审计写入 Neo 主库；身份允许来自双跑期的 MySQL 权威源。 */
export class AuditRepository implements AuditRepositoryPort {
  constructor(private readonly db: Db) {}

  async append(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLogs).values(entry);
  }
}
