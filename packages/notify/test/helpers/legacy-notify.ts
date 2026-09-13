import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import type {
  FeishuCard,
  NotificationData,
  NotificationDomain,
} from '../../src/types';

/** Execute the unchanged services and UTC8 utility; never call real webhooks. */
export function legacyNotify(domain: NotificationDomain) {
  const root = resolve(__dirname, '../../../..');
  function load(relative: string, dependencies: Record<string, unknown>) {
    const module = { exports: {} };
    runInNewContext(readFileSync(resolve(root, relative), 'utf8'), {
      module,
      Date,
      Intl,
      setInterval: () => ({ unref() {} }),
      setTimeout,
      require(name: string) {
        if (!Object.hasOwn(dependencies, name))
          throw new Error('Unexpected Legacy notification dependency');
        return dependencies[name];
      },
    });
    return module.exports;
  }
  const dateTime = load('server/src/utils/dateTime.js', {});
  const name =
    domain === 'primary' ? 'feishuService' : 'competitorFeishuService';
  const model =
    domain === 'primary' ? 'FeishuConfig' : 'CompetitorFeishuConfig';
  const service = load(`server/src/services/${name}.js`, {
    axios: {
      post() {
        throw new Error('Legacy card oracle must not send');
      },
    },
    [`../models/${model}`]: {
      findByRegion() {
        throw new Error('Legacy card oracle must not query credentials');
      },
    },
    '../utils/dateTime': dateTime,
    '../utils/logger': { debug() {}, info() {}, warn() {}, error() {} },
  }) as {
    buildFeishuCard?: (data: NotificationData) => FeishuCard;
    buildCompetitorFeishuCard?: (data: NotificationData) => FeishuCard;
  };
  return domain === 'primary'
    ? service.buildFeishuCard!
    : service.buildCompetitorFeishuCard!;
}
