import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

export type FeishuLegacyOperation =
  | 'getFeishuConfigs'
  | 'getFeishuConfigByCountry'
  | 'upsertFeishuConfig'
  | 'deleteFeishuConfig'
  | 'toggleFeishuConfig';
/** Load the actual Legacy model and controller. SQL and HTTP result mapping
 * remain unchanged; only the disposable database transport/logger are supplied. */
export function feishuConfigurationLegacy(
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<Record<string, unknown>[]>,
) {
  const root = resolve(__dirname, '../../../..'),
    model = { exports: {} };
  runInNewContext(
    readFileSync(resolve(root, 'server/src/models/FeishuConfig.js'), 'utf8'),
    {
      module: model,
      require(name: string) {
        if (name === '../config/database') return { query };
        throw new Error('Unexpected Legacy Feishu model dependency');
      },
    },
  );
  const controller = {} as Record<
    FeishuLegacyOperation,
    (req: object, res: object) => Promise<void>
  >;
  runInNewContext(
    readFileSync(
      resolve(root, 'server/src/controllers/feishuController.js'),
      'utf8',
    ),
    {
      exports: controller,
      require(name: string) {
        if (name === '../models/FeishuConfig') return model.exports;
        if (name === '../utils/logger')
          return { error() {}, warn() {}, info() {}, debug() {} };
        throw new Error('Unexpected Legacy Feishu controller dependency');
      },
    },
  );
  return async (
    operation: FeishuLegacyOperation,
    body: unknown = {},
    country = 'US',
  ) => {
    let statusCode = 200,
      value: unknown;
    const res = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(data: unknown) {
        value = JSON.parse(JSON.stringify(data));
      },
    };
    await controller[operation]({ body, params: { country } }, res);
    return { statusCode, body: value };
  };
}
