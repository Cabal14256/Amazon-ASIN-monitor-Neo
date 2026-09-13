import { variantCheckResultReferenceSchema } from '@asin-monitor/contracts';
import {
  VariantCheckError,
  type VariantCheckRepositoryPort,
} from '@asin-monitor/db';
import { variantCheckResultOperation } from '@asin-monitor/variant-check';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { authorizeAdministration } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import { VARIANT_CHECK_REPOSITORY } from '../variant-check/variant-check-storage.module';

type OwnedCheckTask = Parameters<typeof variantCheckResultOperation>[0] & {
  result?: unknown;
};
const privateKey =
  /password|token|secret|authorization|cookie|credential|file.?path|^path$|directory|^stack$|^__proto__$|^constructor$|^prototype$/i;
function fail(status: number, message: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
}
/** Receipt decoding already detached and bounded the complete payload. Walk it
 * iteratively so deep valid catalog objects are not truncated or stack-recursed. */
function publicResult(result: unknown, ensureOpen: () => void): unknown {
  const pending: unknown[] = [result];
  let visited = 0;
  while (pending.length) {
    if (++visited % 1024 === 0) ensureOpen();
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (const item of value)
        if (item && typeof item === 'object') pending.push(item);
    } else
      for (const [key, item] of Object.entries(value)) {
        if (privateKey.test(key))
          delete (value as Record<string, unknown>)[key];
        else if (item && typeof item === 'object') pending.push(item);
      }
  }
  ensureOpen();
  return result;
}
@Injectable()
export class VariantCheckTaskResults {
  private active = 0;
  constructor(
    @Inject(VARIANT_CHECK_REPOSITORY)
    private readonly repository: VariantCheckRepositoryPort,
  ) {}
  isReference(value: unknown): boolean {
    return variantCheckResultReferenceSchema.safeParse(value).success;
  }
  async read(
    task: OwnedCheckTask,
    principal: AuthPrincipal,
    ensureOpen: () => void,
    allowMissing = false,
  ): Promise<unknown> {
    if (!task.userId || task.userId !== principal.userId)
      fail(403, '无权访问此任务');
    if (this.active >= 2) fail(429, '检查结果读取繁忙，请稍后再试');
    this.active++;
    try {
      ensureOpen();
      const operation = variantCheckResultOperation(task, task.result);
      const result = await this.repository.transaction(async (unit) => {
        ensureOpen();
        await authorizeAdministration(unit, principal, 'asin:read');
        // Recovery waits for an in-flight COMMIT before concluding that no
        // receipt exists. Normal completed-result reads need no advisory lock.
        const value = await unit.readReceipt(operation, allowMissing);
        await authorizeAdministration(unit, principal, 'asin:read');
        ensureOpen();
        return value;
      });
      if (result === undefined) {
        if (allowMissing) return undefined;
        fail(404, '检查结果不存在或已过期');
      }
      return publicResult(result, ensureOpen);
    } catch (error) {
      if (
        error instanceof VariantCheckError &&
        [
          'operation-expired',
          'operation-mismatch',
          'invalid-input',
          'invalid-result',
        ].includes(error.code)
      )
        fail(404, '检查结果不存在或已过期');
      throw error;
    } finally {
      this.active--;
    }
  }
}
