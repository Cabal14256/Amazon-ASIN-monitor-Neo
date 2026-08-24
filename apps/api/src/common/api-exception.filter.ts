import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type { AppLogger } from '../logger/app-logger.service';

interface ErrorEnvelope {
  success: false;
  errorMessage: string;
  errorCode: number;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getStatus(exception: unknown): number {
  if (exception instanceof HttpException) return exception.getStatus();
  if (isRecord(exception)) {
    const status = exception.statusCode;
    if (
      typeof status === 'number' &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
    ) {
      return status;
    }
  }
  return 500;
}

function getExceptionResponse(exception: unknown): unknown {
  return exception instanceof HttpException
    ? exception.getResponse()
    : exception;
}

function getMessage(raw: unknown, status: number): string {
  if (status >= 500) return '服务器内部错误';

  if (isRecord(raw)) {
    if (typeof raw.errorMessage === 'string') return raw.errorMessage;
    if (status === 404) return '接口不存在';
    if (Array.isArray(raw.message)) return raw.message.join('; ');
    if (typeof raw.message === 'string') return raw.message;
  }
  if (status === 404) return '接口不存在';
  if (raw instanceof Error && raw.message) return raw.message;
  if (typeof raw === 'string') return raw;
  return '请求失败';
}

function toEnvelope(raw: unknown, status: number): ErrorEnvelope {
  if (status >= 500) {
    return {
      success: false,
      errorMessage: '服务器内部错误',
      errorCode: status,
    };
  }
  if (
    isRecord(raw) &&
    ('success' in raw || 'errorMessage' in raw || 'errorCode' in raw)
  ) {
    return {
      ...raw,
      success: false,
      errorMessage: getMessage(raw, status),
      errorCode: typeof raw.errorCode === 'number' ? raw.errorCode : status,
    } as ErrorEnvelope;
  }
  return {
    success: false,
    errorMessage: getMessage(raw, status),
    errorCode: status,
  };
}

/** 将 Nest、Fastify 与应用异常统一为 legacy Result 错误信封。 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const status = getStatus(exception);
    if (status >= 500) {
      this.logger.error('API 请求处理失败', 'ApiExceptionFilter', exception);
    }
    host
      .switchToHttp()
      .getResponse<FastifyReply>()
      .status(status)
      .send(toEnvelope(getExceptionResponse(exception), status));
  }
}
