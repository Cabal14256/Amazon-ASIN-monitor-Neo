import type { AuditEntry, AuditRepositoryPort } from '@asin-monitor/db';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { AppLogger } from '../logger/app-logger.service';

export const AUDIT_REPOSITORY = Symbol('AUDIT_REPOSITORY');
const MAX_PENDING = 256;

@Injectable()
export class AuditService implements OnModuleDestroy {
  private readonly pending = new Set<Promise<void>>();
  private closing = false;
  private lastWarning = -Infinity;

  constructor(
    @Inject(AUDIT_REPOSITORY) private readonly repository: AuditRepositoryPort,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  record(entry: AuditEntry): void {
    if (this.closing || this.pending.size >= MAX_PENDING) {
      if (Date.now() - this.lastWarning >= 60_000) {
        this.lastWarning = Date.now();
        this.logger.warn('审计写入容量不足，记录已丢弃', 'AuditService', {
          reason: this.closing ? 'shutdown' : 'capacity',
        });
      }
      return;
    }
    const pending = Promise.resolve()
      .then(() => this.repository.append(entry))
      .catch(() => {
        this.logger.error('操作审计写入失败', 'AuditService', {
          reason: 'audit_write_failed',
        });
      })
      .finally(() => this.pending.delete(pending));
    this.pending.add(pending);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.flush(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
