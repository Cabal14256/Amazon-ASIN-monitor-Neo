import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  Post,
} from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureHttpApp } from '../src/http-app';

@Controller('test-errors')
class TestErrorsController {
  @Post('echo')
  echo(@Body() body: unknown): unknown {
    return body;
  }

  @Get('custom')
  custom(): never {
    throw new BadRequestException({
      success: false,
      errorMessage: '请求参数校验失败',
      errorCode: 400,
      data: [{ path: 'name', message: 'Required' }],
    });
  }

  @Get('boom')
  boom(): never {
    throw new Error('database unavailable');
  }

  @Get('wrapped-500')
  wrapped500(): never {
    throw new HttpException(
      {
        success: false,
        errorMessage: 'internal database details',
        errorCode: 503,
        data: { diagnostics: 'private' },
      },
      503,
    );
  }
}

describe('HTTP 全局边界', () => {
  let app: NestFastifyApplication;
  let enableShutdownHooks: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [TestErrorsController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false }),
    );
    enableShutdownHooks = vi.spyOn(app, 'enableShutdownHooks');
    configureHttpApp(app, { corsOrigin: 'https://dashboard.example' });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it('注册 Nest shutdown hooks 以关闭 Fastify 与依赖客户端', () => {
    expect(enableShutdownHooks).toHaveBeenCalledOnce();
  });

  it('为配置的跨源前端启用 credentialed CORS', async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'OPTIONS',
        url: '/api/v1/test-errors/echo',
        headers: {
          origin: 'https://dashboard.example',
          'access-control-request-method': 'POST',
        },
      });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(
      'https://dashboard.example',
    );
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('404、Malformed JSON 与未知 500 均使用统一错误信封', async () => {
    const fastify = app.getHttpAdapter().getInstance();
    const notFound = await fastify.inject({ method: 'GET', url: '/missing' });
    const malformed = await fastify.inject({
      method: 'POST',
      url: '/api/v1/test-errors/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    const failure = await fastify.inject({
      method: 'GET',
      url: '/api/v1/test-errors/boom',
    });

    expect(notFound.json()).toEqual({
      success: false,
      errorMessage: '接口不存在',
      errorCode: 404,
    });
    expect(malformed.json()).toMatchObject({
      success: false,
      errorCode: 400,
    });
    expect(failure.json()).toEqual({
      success: false,
      errorMessage: '服务器内部错误',
      errorCode: 500,
    });
  });

  it('保留 Zod/应用自定义错误信封的数据字段', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/v1/test-errors/custom',
    });

    expect(response.json()).toEqual({
      success: false,
      errorMessage: '请求参数校验失败',
      errorCode: 400,
      data: [{ path: 'name', message: 'Required' }],
    });
  });

  it('5xx 自定义信封仅返回固定白名单字段', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/v1/test-errors/wrapped-500',
    });

    expect(response.json()).toEqual({
      success: false,
      errorMessage: '服务器内部错误',
      errorCode: 503,
    });
  });
});
