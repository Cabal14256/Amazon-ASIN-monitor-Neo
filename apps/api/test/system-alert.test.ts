import { loadEnv } from '@asin-monitor/config';
import { systemAlertResultSchema } from '@asin-monitor/contracts';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigModule, ENV } from '../src/config/config.module';
import { configureHttpApp } from '../src/http-app';
import { SystemModule } from '../src/system/system.module';

const validEnv = {
  DATABASE_URL: 'postgresql://localhost/system_alert_111',
  COMPETITOR_DATABASE_URL: 'postgresql://localhost/system_alert_competitor_111',
  REDIS_URL: 'redis://localhost/15',
  JWT_SECRET: 'fixture-system-111',
  AUTH_DATA_AUTHORITY: 'postgresql',
};
const legacyConfig = readFileSync(
  resolve(__dirname, '../../../server/src/config/system.js'),
  'utf8',
);
const legacyController = readFileSync(
  resolve(__dirname, '../../../server/src/controllers/systemController.js'),
  'utf8',
);
async function legacyResult(env: NodeJS.ProcessEnv) {
  const configModule = { exports: {} };
  runInNewContext(legacyConfig, { module: configModule, process: { env } });
  const exports = {} as {
    getAlert(req: object, res: { json(value: unknown): void }): Promise<void>;
  };
  runInNewContext(legacyController, {
    exports,
    require: (path: string) => {
      if (path !== '../config/system')
        throw new Error('Unexpected Legacy import');
      return configModule.exports;
    },
  });
  let response: unknown;
  await exports.getAlert(
    {},
    {
      json: (value) => {
        response = value;
      },
    },
  );
  return JSON.parse(JSON.stringify(response)) as unknown;
}

describe('public system announcement / actual Legacy HTTP response parity', () => {
  let app: NestFastifyApplication | undefined;
  async function start(overrides: NodeJS.ProcessEnv = {}) {
    const builder = await Test.createTestingModule({
      imports: [ConfigModule, SystemModule],
    })
      .overrideProvider(ENV)
      .useValue(loadEnv({ ...validEnv, ...overrides }))
      .compile();
    app = builder.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false }),
      { logger: false },
    );
    configureHttpApp(app);
    await app.init();
    const http = app.getHttpAdapter().getInstance();
    await http.ready();
    return http;
  }
  afterEach(async () => {
    await app?.close();
  });

  it.each<[string, NodeJS.ProcessEnv]>([
    ['unset announcement', {}],
    [
      'public before authority cutover',
      {
        AUTH_DATA_AUTHORITY: 'legacy-mysql',
        DB_HOST: 'localhost',
        DB_USER: 'fixture',
        DB_PASSWORD: '',
        DB_NAME: 'fixture_system_111',
        GLOBAL_ALERT_MESSAGE: '切换前公告',
      },
    ],
    [
      'empty message forces info',
      { GLOBAL_ALERT_MESSAGE: '', GLOBAL_ALERT_TYPE: 'error' },
    ],
    ['default type', { GLOBAL_ALERT_MESSAGE: '维护公告' }],
    ['empty type', { GLOBAL_ALERT_MESSAGE: '维护公告', GLOBAL_ALERT_TYPE: '' }],
    [
      'custom severity',
      { GLOBAL_ALERT_MESSAGE: '公告', GLOBAL_ALERT_TYPE: 'custom' },
    ],
    [
      'preserved whitespace',
      { GLOBAL_ALERT_MESSAGE: '   ', GLOBAL_ALERT_TYPE: ' warning ' },
    ],
    [
      'Unicode and multiple lines',
      {
        GLOBAL_ALERT_MESSAGE: '  公告😀\n第二行\t  ',
        GLOBAL_ALERT_TYPE: 'warning',
      },
    ],
    [
      'markup remains plain JSON text',
      {
        GLOBAL_ALERT_MESSAGE: '<script>"公告"</script>\\end',
        GLOBAL_ALERT_TYPE: 'info',
      },
    ],
  ])('matches Legacy for %s without authentication', async (_name, env) => {
    const http = await start(env);
    const response = await http.inject({
      method: 'GET',
      url: '/api/v1/system/alert',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual(await legacyResult(env));
    expect(systemAlertResultSchema.parse(response.json())).toEqual(
      response.json(),
    );
    expect(response.body).not.toContain(validEnv.JWT_SECRET);
  });

  it('takes values only from configuration and retains public GET routing', async () => {
    const env = {
      GLOBAL_ALERT_MESSAGE: '配置公告',
      GLOBAL_ALERT_TYPE: 'warning',
    };
    const http = await start(env);
    const response = await http.inject({
      method: 'GET',
      url: '/api/v1/system/alert?message=override&type=error',
      headers: { authorization: 'Bearer invalid-public-request' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(await legacyResult(env));
    expect(
      (await http.inject({ method: 'POST', url: '/api/v1/system/alert' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await http.inject({ method: 'GET', url: '/api/api/v1/system/alert' }))
        .statusCode,
    ).toBe(404);
  });
});
