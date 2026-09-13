import type { MonitorAnalyticsOperation } from '@asin-monitor/db';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { legacyAnalyticsFixture } from '../../../../packages/db/test/helpers/monitor-analytics-legacy';

const methods: Record<MonitorAnalyticsOperation, string> = {
  statistics: 'getStatistics',
  'by-time': 'getStatisticsByTime',
  'by-country': 'getStatisticsByCountry',
  'by-variant-group': 'getStatisticsByVariantGroup',
  'peak-hours': 'getPeakHoursStatistics',
  'analytics-monthly-breakdown': 'getAnalyticsMonthlyBreakdown',
  'peak-mark-areas': 'getAnalyticsPeakMarkAreas',
  'all-countries-summary': 'getAllCountriesSummary',
  'region-summary': 'getRegionSummary',
  'period-summary': 'getPeriodSummary',
  'period-summary/details': 'getPeriodSummaryTimeSlotDetails',
  'asin-by-country': 'getASINStatisticsByCountry',
  'asin-by-variant-group': 'getASINStatisticsByVariantGroup',
  'abnormal-duration-statistics': 'getAbnormalDurationStatistics',
};
/** Executes the actual Legacy controller and view service with the actual model
 * and a private MySQL schema. Only logger/cache/dependency transport are stubbed. */
export async function legacyAnalyticsHttpFixture() {
  const legacy = await legacyAnalyticsFixture();
  try {
    const filename = resolve(
      __dirname,
      '../../../../server/src/controllers/monitorController.js',
    );
    const localRequire = createRequire(filename);
    const exports: Record<
      string,
      (request: unknown, response: unknown) => Promise<void>
    > = {};
    vm.runInNewContext(
      readFileSync(filename, 'utf8'),
      {
        exports,
        module: { exports },
        setTimeout,
        require(name: string) {
          if (name === '../models/MonitorHistory') return legacy.model;
          if (name === '../utils/logger')
            return { debug() {}, info() {}, warn() {}, error() {} };
          if (
            name === '../utils/analyticsBenchmark' ||
            name === '../services/analyticsViewService'
          )
            return localRequire(name);
          throw new Error('Unexpected Legacy controller fixture dependency');
        },
      },
      { filename },
    );
    return {
      ...legacy,
      async http(
        operation: MonitorAnalyticsOperation,
        query: Record<string, string>,
      ) {
        let statusCode = 200,
          body: unknown;
        const response = {
          status(code: number) {
            statusCode = code;
            return response;
          },
          json(value: unknown) {
            body = value;
          },
        };
        await exports[methods[operation]](
          { query, get: () => undefined },
          response,
        );
        return {
          statusCode,
          body: JSON.parse(JSON.stringify(body)) as Record<string, unknown>,
        };
      },
    };
  } catch (error) {
    await legacy.close();
    throw error;
  }
}
