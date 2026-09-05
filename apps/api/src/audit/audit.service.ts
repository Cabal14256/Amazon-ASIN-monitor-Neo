import type { AuditEntry, AuditRepositoryPort } from '@asin-monitor/db';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { AppLogger } from '../logger/app-logger.service';

export const AUDIT_REPOSITORY = Symbol('AUDIT_REPOSITORY');
const MAX_PENDING = 256;
const SAFE_ERROR_CODES = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '28P01',
  '28000',
  '42501',
  '42P01',
  '42703',
  '23502',
  '23503',
  '23505',
  '23514',
  '57014',
  '53300',
  '57P01',
  '57P02',
  '57P03',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

function failureCode(error: unknown): string {
  let current = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === 'object';
    depth++
  ) {
    if (
      'code' in current &&
      typeof current.code === 'string' &&
      SAFE_ERROR_CODES.has(current.code)
    )
      return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return 'unknown';
}

@Injectable()
export class AuditService implements OnApplicationShutdown {
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
      .catch((error: unknown) => {
        this.logger.error('操作审计写入失败', 'AuditService', {
          reason: 'audit_write_failed',
          code: failureCode(error),
        });
      })
      .finally(() => this.pending.delete(pending));
    this.pending.add(pending);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  /** Nest 在 HTTP adapter 完成 drain 后调用；先收完 onResponse 再关闭写入。 */
  async onApplicationShutdown(): Promise<void> {
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
