import { HttpException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

interface Admission {
  pending: number;
  finished: boolean;
  released: boolean;
  release(): void;
  ensureOpen(): void;
}
const fail = (status: number, message: string): never => {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
};

/** Reserve before authentication so a session touch blocked by another read
 * cannot hide overload until that earlier query times out. Authentication,
 * data work and response delivery share one reservation without double counting. */
export class MonitorAnalyticsAdmission {
  private active = 0;
  private readonly requests = new WeakMap<FastifyReply, Admission>();
  private reserve(reply: FastifyReply) {
    const existing = this.requests.get(reply);
    if (existing) return existing;
    if (reply.raw.destroyed)
      fail(504, '查询超时，请尝试缩小时间范围或稍后重试');
    if (this.active >= 2) fail(429, '统计查询繁忙，请稍后再试');
    this.active++;
    const admission: Admission = {
      pending: 0,
      finished: false,
      released: false,
      release: () => {
        if (admission.pending || !admission.finished || admission.released)
          return;
        admission.released = true;
        this.active--;
        clearTimeout(timer);
        reply.raw.off('finish', finish);
        reply.raw.off('close', finish);
      },
      ensureOpen: () => {
        if (admission.finished || admission.released || reply.raw.destroyed)
          fail(504, '查询超时，请尝试缩小时间范围或稍后重试');
      },
    };
    const finish = () => {
      admission.finished = true;
      admission.release();
    };
    const timer = setTimeout(() => reply.raw.destroy(), 60000);
    timer.unref();
    reply.raw.once('finish', finish);
    reply.raw.once('close', finish);
    this.requests.set(reply, admission);
    return admission;
  }
  async run<T>(
    reply: FastifyReply,
    action: (ensureOpen: () => void) => Promise<T>,
  ): Promise<T> {
    const admission = this.reserve(reply);
    admission.ensureOpen();
    admission.pending++;
    try {
      const result = await action(admission.ensureOpen);
      admission.ensureOpen();
      return result;
    } finally {
      admission.pending--;
      admission.release();
    }
  }
}
