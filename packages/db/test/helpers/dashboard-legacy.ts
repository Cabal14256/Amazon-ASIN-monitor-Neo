import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

export type DashboardLegacyRows = Record<string, unknown>[][];
/** Execute the frozen controller with its real status SQL builders. Only its
 * database transport, logger and host-local clock are supplied by the fixture. */
export async function legacyDashboard(
  query: (
    statement: string,
    params?: unknown[],
  ) => Promise<Record<string, unknown>[]>,
  now: number,
) {
  class Clock extends Date {
    constructor(value?: string | number | Date) {
      super(
        value === undefined
          ? now
          : value instanceof Date
          ? value.getTime()
          : value,
      );
    }
    static now() {
      return now;
    }
    getFullYear() {
      return new Date(this.getTime() + 8 * 3600_000).getUTCFullYear();
    }
    getMonth() {
      return new Date(this.getTime() + 8 * 3600_000).getUTCMonth();
    }
    getDate() {
      return new Date(this.getTime() + 8 * 3600_000).getUTCDate();
    }
  }
  const root = resolve(__dirname, '../../../..');
  const status = { exports: {} };
  runInNewContext(
    readFileSync(resolve(root, 'server/src/utils/variantStatus.js'), 'utf8'),
    { module: status },
  );
  const controller = {} as {
    getDashboardData(req: object, res: object): Promise<void>;
  };
  const noop = () => {};
  runInNewContext(
    readFileSync(
      resolve(root, 'server/src/controllers/dashboardController.js'),
      'utf8',
    ),
    {
      exports: controller,
      Date: Clock,
      require: (name: string) => {
        if (name === '../config/database') return { query };
        if (name === '../utils/variantStatus') return status.exports;
        if (name === '../utils/logger')
          return { debug: noop, info: noop, warn: noop, error: noop };
        throw new Error('Unexpected Legacy dashboard dependency');
      },
    },
  );
  let statusCode = 200,
    body: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(value: unknown) {
      body = JSON.parse(JSON.stringify(value));
    },
  };
  await controller.getDashboardData({}, response);
  return { statusCode, body };
}
