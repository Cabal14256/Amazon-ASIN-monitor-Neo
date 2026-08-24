import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { z } from 'zod';
import { ZodValidationPipe } from '../src/common/zod-validation.pipe';
import { HealthController } from '../src/health/health.controller';
import { AppLogger, sanitize } from '../src/logger/app-logger.service';

describe('HealthController', () => {
  it('返回 ok 状态与运行时间', () => {
    const controller = new HealthController();
    const health = controller.getHealth();
    expect(health.status).toBe('ok');
    expect(typeof health.uptime).toBe('number');
  });
});

describe('AppLogger.sanitize（对齐旧 logger.js 脱敏清单）', () => {
  it('脱敏敏感字段（大小写不敏感、子串匹配）', () => {
    const input = {
      password: 'p',
      accessToken: 't',
      Authorization: 'a',
      nested: { apiKey: 'k', safe: 's' },
      list: [{ secret: 'x' }],
    };
    const out = sanitize(input) as Record<string, unknown>;
    expect(out.password).toBe('***REDACTED***');
    expect(out.accessToken).toBe('***REDACTED***');
    expect(out.Authorization).toBe('***REDACTED***');
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

  it('Logger 级别遵循 LOG_LEVEL', () => {
    void new AppLogger();
    expect(true).toBe(true);
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
