import { ENDPOINTS } from '@asin-monitor/contracts';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/** Execute the frozen Express routes and permission middleware. Only session
 * identity, user lookup and business mutations are replaced with fixtures. */
async function legacyApp(permissions: string[]) {
  const root = resolve(__dirname, '../../../server/src');
  const nativeRequire = createRequire(
    resolve(root, 'routes/competitorAsinRoutes.js'),
  );
  const user = {
    hasPermission: vi.fn(async (_id: string, code: string) =>
      permissions.includes(code),
    ),
  };
  const load = (path: string, dependencies: Record<string, unknown>) => {
    const filename = resolve(root, path);
    const module = { exports: {} as Record<string, unknown> };
    vm.runInNewContext(
      readFileSync(filename, 'utf8'),
      {
        module,
        exports: module.exports,
        require: (name: string) => {
          if (!Object.hasOwn(dependencies, name))
            throw new Error('Unexpected Legacy permission dependency');
          return dependencies[name];
        },
      },
      { filename },
    );
    return module.exports;
  };
  const auth = load('middleware/auth.js', {
    jsonwebtoken: {},
    '../config/jwt': { secret: 'fixture-unused' },
    '../models/User': user,
    '../models/Session': {},
    '../utils/logger': { debug() {}, info() {}, warn() {}, error() {} },
    '../utils/authCookie': {},
    '../utils/userStatus': {},
  });
  const controller = vi.fn(
    (_req: unknown, res: { json: (value: unknown) => void }) =>
      res.json({ success: true, errorCode: 0, data: '删除成功' }),
  );
  const router = load('routes/competitorAsinRoutes.js', {
    express: nativeRequire('express'),
    multer: nativeRequire('multer'),
    '../controllers/competitorAsinController': new Proxy(
      {},
      { get: () => controller },
    ),
    '../middleware/auth': {
      checkPermission: auth.checkPermission,
      authenticateToken: (
        req: { userId?: string },
        _res: unknown,
        next: () => void,
      ) => {
        req.userId = 'fixture-operator';
        next();
      },
    },
  });
  const app = nativeRequire('express')();
  app.use('/api/v1', router);
  const server: Server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    user,
    controller,
    request: (path: string) =>
      fetch(
        `http://127.0.0.1:${
          (server.address() as AddressInfo).port
        }/api/v1/competitor/${path}`,
        { method: 'DELETE' },
      ),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe('actual frozen Legacy competitor DELETE authorization', () => {
  it.each([
    { permissions: ['asin:write'], status: 200 },
    { permissions: ['asin:delete'], status: 403 },
    { permissions: ['asin:write', 'asin:delete'], status: 200 },
    { permissions: [], status: 403 },
  ])(
    'requires the existing write grant for both endpoints: $permissions',
    async ({ permissions, status }) => {
      const app = await legacyApp(permissions);
      try {
        for (const path of ['variant-groups/group-1', 'asins/asin-1']) {
          const response = await app.request(path);
          expect(response.status).toBe(status);
          expect((await response.json()).success).toBe(status === 200);
        }
        expect(app.user.hasPermission.mock.calls).toEqual([
          ['fixture-operator', 'asin:write'],
          ['fixture-operator', 'asin:write'],
        ]);
        expect(app.controller).toHaveBeenCalledTimes(status === 200 ? 2 : 0);
        for (const path of [
          '/competitor/variant-groups/:groupId',
          '/competitor/asins/:asinId',
        ])
          expect(
            ENDPOINTS.find(
              (entry) => entry.method === 'DELETE' && entry.path === path,
            )?.permission,
          ).toBe('asin:write');
      } finally {
        await app.close();
      }
    },
  );
});
