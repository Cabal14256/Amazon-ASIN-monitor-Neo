import { HttpException, type ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import { ExportSubmissionRejectedException } from '../src/common/export-submission-rejected.exception';
import type { AppLogger } from '../src/logger/app-logger.service';

function send(exception: unknown) {
  const logger = { warn: vi.fn(), error: vi.fn() };
  const response = { status: vi.fn(), send: vi.fn() };
  response.status.mockReturnValue(response);
  const host = { switchToHttp: () => ({ getResponse: () => response }) };
  new ApiExceptionFilter(logger as unknown as AppLogger).catch(
    exception,
    host as unknown as ArgumentsHost,
  );
  return { logger, response };
}

describe('definitive export rejection HTTP envelope', () => {
  it('exposes only the validated task identity and fixed rejection message', () => {
    const taskId = '10000000-0000-4000-8000-000000000166';
    const f = send(new ExportSubmissionRejectedException(taskId, 'asin'));
    expect(f.response.status).toHaveBeenCalledWith(503);
    expect(f.response.send).toHaveBeenCalledWith({
      success: false,
      errorCode: 503,
      errorMessage: '导出未入队，请在任务中心核对状态后重试',
      data: { taskId, exportType: 'asin', status: 'rejected' },
    });
    expect(f.logger.warn).toHaveBeenCalledWith(
      '导出提交已拒绝',
      'ApiExceptionFilter',
      { status: 503, reason: 'export_enqueue_rejected' },
    );
    expect(f.logger.error).not.toHaveBeenCalled();
  });
  it('continues masking arbitrary 503 payloads even when they imitate a rejection', () => {
    const f = send(
      new HttpException(
        {
          success: false,
          errorCode: 503,
          errorMessage: 'private fixture failure',
          data: { status: 'rejected', password: 'synthetic-secret' },
        },
        503,
      ),
    );
    expect(f.response.send).toHaveBeenCalledWith({
      success: false,
      errorMessage: '服务器内部错误',
      errorCode: 503,
    });
  });
  it('rejects malformed public identities before building an envelope', () => {
    expect(
      () => new ExportSubmissionRejectedException('../foreign', 'asin'),
    ).toThrow('EXPORT_REJECTION_IDENTITY_INVALID');
  });
});
