import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  parseErrorStatsHours,
  parseQuotaStatusQuery,
} from '../src/sp-api-runtime/sp-api-status-values';

function legacyFixture() {
  const snapshots = vi.fn(async (region: string, operation: string | null) => ({
    region,
    operation,
  }));
  const statistics = vi.fn((options: { hours: number }) => options);
  const module = {
    exports: {} as {
      getRateLimiterStatus(req: object, res: object): Promise<unknown>;
      getErrorStats(req: object, res: object): Promise<unknown>;
    },
  };
  runInNewContext(
    readFileSync(
      resolve(
        __dirname,
        '../../../server/src/controllers/spApiConfigController.js',
      ),
      'utf8',
    ),
    {
      module,
      exports: module.exports,
      require(name: string) {
        if (name === '../services/rateLimiter')
          return {
            DEFAULT_OPERATION_CONFIGS: {
              getCatalogItem: {},
              searchCatalogItems: {},
              default: {},
            },
            getStatusSnapshot: snapshots,
          };
        if (name === '../services/errorStatsService')
          return { getErrorStats: statistics };
        if (name === '../utils/logger')
          return { debug() {}, info() {}, warn() {}, error() {} };
        return {}; // No actual database, scheduler, timers or remote clients.
      },
    },
  );
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return { controller: module.exports, snapshots, statistics, response };
}
describe('SP-API status query compatibility / actual Legacy controller', () => {
  it.each([
    {},
    { region: 'US' },
    { region: ' eu ' },
    { region: '', operation: '' },
    { operation: 'getCatalogItem' },
    { region: 'EU', operation: ' searchCatalogItems ' },
  ])('keeps selected region/operation for %j', async (query) => {
    const f = legacyFixture();
    await f.controller.getRateLimiterStatus({ query }, f.response);
    expect(f.response.statusCode).toBe(200);
    const parsed = parseQuotaStatusQuery(query);
    expect(parsed.regions).toEqual(
      f.snapshots.mock.calls.map((call) => call[0]),
    );
    expect(parsed.operation ?? null).toBe(f.snapshots.mock.calls[0][1]);
  });
  it.each([
    { region: 'CA' },
    { operation: 'default' },
    { operation: 'private-product-id' },
  ])('rejects the same unsupported filters %j', async (query) => {
    const f = legacyFixture();
    await f.controller.getRateLimiterStatus({ query }, f.response);
    expect(f.response.statusCode).toBe(400);
    expect(() => parseQuotaStatusQuery(query)).toThrow(
      'Invalid SP-API status query',
    );
  });
  it.each([{}, { hours: '1' }, { hours: '0.5' }, { hours: '168' }])(
    'keeps supported Legacy hours %j',
    async (query) => {
      const f = legacyFixture();
      await f.controller.getErrorStats({ query }, f.response);
      expect(parseErrorStatsHours(query)).toBe(
        f.statistics.mock.calls[0][0].hours,
      );
    },
  );
  it('rejects arrays, objects and ambiguous query value types', () => {
    for (const query of [
      null,
      [],
      { region: ['US'] },
      { operation: {} },
      { region: true },
    ])
      expect(() => parseQuotaStatusQuery(query)).toThrow(
        'Invalid SP-API status query',
      );
    for (const hours of [
      null,
      '',
      ' ',
      '0',
      '-1',
      '169',
      'Infinity',
      'NaN',
      ['1'],
      {},
      true,
    ])
      expect(() => parseErrorStatsHours({ hours })).toThrow(
        'Invalid SP-API status query',
      );
  });
});
