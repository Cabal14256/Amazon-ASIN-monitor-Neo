import { BadRequestException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { z } from 'zod';
import { ZodValidationPipe } from '../src/common/zod-validation.pipe';
import { AppLogger, sanitize, utc8Iso } from '../src/logger/app-logger.service';
import { createNestLoggerAdapter } from '../src/logger/nest-logger.adapter';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('AppLogger.sanitize（对齐旧 logger.js 脱敏清单）', () => {
  it('脱敏敏感字段（大小写不敏感、子串匹配）', () => {
    const input = {
      password: 'p',
      accessToken: 't',
      Authorization: 'a',
      cookie: 'session=raw',
      'set-cookie': 'refresh=raw',
      nested: { apiKey: 'k', safe: 's' },
      list: [{ secret: 'x' }],
    };
    const out = sanitize(input) as Record<string, unknown>;
    expect(out.password).toBe('***REDACTED***');
    expect(out.accessToken).toBe('***REDACTED***');
    expect(out.Authorization).toBe('***REDACTED***');
    expect(out.cookie).toBe('***REDACTED***');
    expect(out['set-cookie']).toBe('***REDACTED***');
    expect((out.nested as Record<string, unknown>).apiKey).toBe(
      '***REDACTED***',
    );
    expect((out.nested as Record<string, unknown>).safe).toBe('s');
    expect((out.list as Array<Record<string, unknown>>)[0].secret).toBe(
      '***REDACTED***',
    );
  });

  it('非对象原样返回', () => {
    expect(sanitize('str')).toBe('str');
    expect(sanitize(null)).toBe(null);
  });

  it('Error 只保留最小上下文，主消息对象同样脱敏', () => {
    expect(
      sanitize(Object.assign(new Error('boom'), { code: 'E_TEST' })),
    ).toEqual({ name: 'Error', message: 'boom', code: 'E_TEST' });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const logger = new AppLogger();
    logger.info({ authorization: 'Bearer raw', safe: 'ok' }, 'Test');
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('[INFO] [Test]'),
      { authorization: '***REDACTED***', safe: 'ok' },
    );
  });

  it('UTC+8 时间戳不受宿主时区偏移影响', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T12:00:00.000Z'));
    expect(utc8Iso()).toBe('2026-08-24T20:00:00.000+08:00');
  });

  it('Logger 级别遵循 LOG_LEVEL', () => {
    vi.stubEnv('LOG_LEVEL', ' ERROR ');
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const logger = new AppLogger();

    logger.info('below threshold');
    logger.error('at threshold');

    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });

  it('Nest 异常日志保留 stack 与真实 context 并继续脱敏', () => {
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const adapter = createNestLoggerAdapter(new AppLogger());

    adapter.error?.(
      { authorization: 'Bearer raw', safe: 'boom' },
      'Error: boom\n    at handler.ts:1:1',
      'ExceptionsHandler',
    );

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('[ERROR] [ExceptionsHandler]'),
      { authorization: '***REDACTED***', safe: 'boom' },
      'Error: boom\n    at handler.ts:1:1',
    );
  });

  it('Nest 无 context 的单独 stack 不会被误放进日志前缀', () => {
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const adapter = createNestLoggerAdapter(new AppLogger());

    adapter.error?.('boom', 'Error: boom\n    at handler.ts:1:1');

    expect(error).toHaveBeenCalledWith(
      expect.not.stringContaining('[Error: boom'),
      'boom',
      'Error: boom\n    at handler.ts:1:1',
    );
  });
});

describe('ZodValidationPipe', () => {
  it('无 schema 的 metatype 直接透传', () => {
    const pipe = new ZodValidationPipe();
    expect(
      pipe.transform({ a: 1 }, { type: 'body', metatype: Object }),
    ).toEqual({ a: 1 });
  });

  it('有 schema 时校验并返回解析结果', () => {
    class CreateDto {
      static schema = z.object({ name: z.string(), n: z.coerce.number() });
    }
    const pipe = new ZodValidationPipe();
    expect(
      pipe.transform(
        { name: 'x', n: '3' },
        { type: 'body', metatype: CreateDto },
      ),
    ).toEqual({
      name: 'x',
      n: 3,
    });
  });

  it('校验失败抛出 BadRequestException（信封格式）', () => {
    class Dto {
      static schema = z.object({ name: z.string() });
    }
    const pipe = new ZodValidationPipe();
    try {
      pipe.transform({ name: 1 }, { type: 'body', metatype: Dto });
      expect.unreachable('应当抛出 BadRequestException');
    } catch (e) {
      const response = (e as BadRequestException).getResponse() as Record<
        string,
        unknown
      >;
      expect(response).toMatchObject({
        success: false,
        errorMessage: '请求参数校验失败',
        errorCode: 400,
      });
    }
  });
});
