import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import type {
  FeishuCard,
  NotificationData,
  NotificationDomain,
} from '../../src/types';

export interface LegacyNotifyOptions {
  read?: (region: string) => Promise<{ webhook_url: string } | undefined>;
  post?: (
    url: string,
    body: { msg_type: string; card: FeishuCard },
    options: { timeout: number; headers: Record<string, string> },
  ) => Promise<{ status: number; data: unknown }>;
  random?: () => number;
  onDelay?: (ms: number) => void;
}
/** Execute unchanged Legacy services; all I/O must be supplied by a fixture. */
export function legacyNotifyRuntime(
  domain: NotificationDomain,
  options: LegacyNotifyOptions = {},
) {
  const root = resolve(__dirname, '../../../..');
  function load(relative: string, dependencies: Record<string, unknown>) {
    const module = { exports: {} };
    runInNewContext(readFileSync(resolve(root, relative), 'utf8'), {
      module,
      Date,
      Intl,
      setInterval: () => ({ unref() {} }),
      setTimeout: (callback: () => void, ms: number) => {
        options.onDelay?.(ms);
        return setTimeout(callback, ms);
      },
      Math: Object.assign(Object.create(Math), {
        random: options.random ?? Math.random,
      }),
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
      post:
        options.post ??
        function () {
          throw new Error('Legacy card oracle must not send');
        },
    },
    [`../models/${model}`]: {
      findByRegion:
        options.read ??
        function () {
          throw new Error('Legacy card oracle must not query credentials');
        },
    },
    '../utils/dateTime': dateTime,
    '../utils/logger': { debug() {}, info() {}, warn() {}, error() {} },
  }) as {
    buildFeishuCard?: (data: NotificationData) => FeishuCard;
    buildCompetitorFeishuCard?: (data: NotificationData) => FeishuCard;
    sendFeishuNotification?: (
      region: string,
      data: NotificationData,
    ) => Promise<unknown>;
    sendCompetitorFeishuNotification?: (
      region: string,
      data: NotificationData,
    ) => Promise<unknown>;
    sendSingleCountryNotification?: (
      country: string,
      data: NotificationData,
    ) => Promise<unknown>;
    sendBatchNotifications?: (
      countries: Record<string, NotificationData>,
    ) => Promise<unknown>;
    sendCompetitorBatchNotifications?: (
      countries: Record<string, NotificationData>,
    ) => Promise<unknown>;
  };
  return {
    build:
      domain === 'primary'
        ? service.buildFeishuCard!
        : service.buildCompetitorFeishuCard!,
    sendOnce:
      domain === 'primary'
        ? service.sendFeishuNotification!
        : service.sendCompetitorFeishuNotification!,
    sendCountry: service.sendSingleCountryNotification,
    sendBatch:
      domain === 'primary'
        ? service.sendBatchNotifications!
        : service.sendCompetitorBatchNotifications!,
  };
}
export const legacyNotify = (domain: NotificationDomain) =>
  legacyNotifyRuntime(domain).build;
