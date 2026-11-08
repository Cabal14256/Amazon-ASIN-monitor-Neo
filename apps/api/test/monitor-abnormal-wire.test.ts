import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MONITOR_ANALYTICS_REPOSITORY } from '../src/monitor/monitor-analytics.service';
import { MonitorHistoryModule } from '../src/monitor/monitor-history.module';
import { ApplicationRedisClient } from '../src/redis/redis.service';
import { monitorAnalyticsFixture } from './helpers/monitor-analytics-fixture';
import { sessionApp } from './helpers/session-app';

describe('Issue 241 scoped abnormal bracket wire through real Fastify', () => {
  let fixture: ReturnType<typeof monitorAnalyticsFixture>;
  let app: Awaited<ReturnType<typeof sessionApp>>;
  let headers: { authorization: string };
  beforeEach(async () => {
    fixture = monitorAnalyticsFixture();
    app = await sessionApp(
      fixture.auth,
      {},
      (builder) =>
        builder
          .overrideProvider(MONITOR_ANALYTICS_REPOSITORY)
          .useValue(fixture.repository)
          .overrideProvider(ApplicationRedisClient)
          .useValue(fixture.redis),
      [MonitorHistoryModule],
    );
    headers = {
      authorization: `Bearer ${jwt.sign(
        { userId: fixture.user.id, sessionId: fixture.session.id },
        app.env.JWT_SECRET,
        { expiresIn: '1h' },
      )}`,
    };
  });
  afterEach(async () => {
    await app.app.close();
    vi.restoreAllMocks();
  });
  const get = (
    entries: [string, string][],
    path = 'abnormal-duration-statistics',
  ) =>
    app.http.inject({
      method: 'GET',
      url: `/api/v1/monitor-history/${path}?${new URLSearchParams(entries)}`,
      headers,
    });

  it('CONTROL: ordinary scalar CSV and repeated regular parameters retain Legacy behavior', async () => {
    expect(
      (
        await get([
          ['asinIds', ' first, second ,,first '],
          ['includeSeries', '0'],
        ])
      ).statusCode,
    ).toBe(200);
    expect(fixture.unit.abnormal).toHaveBeenLastCalledWith({
      operation: 'abnormal-duration-statistics',
      asinIds: ['first', 'second', 'first'],
      includeSeries: '0',
    });
    expect(
      (
        await get([
          ['asinIds', '  raw,one  '],
          ['asinIds', ''],
          ['asinIds', 'second'],
        ])
      ).statusCode,
    ).toBe(200);
    expect(fixture.unit.abnormal).toHaveBeenLastCalledWith({
      operation: 'abnormal-duration-statistics',
      asinIds: ['  raw,one  ', '', 'second'],
      includeSeries: '1',
    });
  });

  it('RED: wraps a single bracket ID/code without trimming, splitting, or affecting other scalar rules', async () => {
    const response = await get([
      ['asinIds[]', ' 00042,MiXeD '],
      ['asinCodes[]', ' B,RAW '],
      ['variantGroupId', ' group,id '],
      ['asinName', ' name %_ '],
      ['variantGroupName', ' group %_ '],
      ['asinType', ' MAIN_LINK '],
      ['includeSeries', '0'],
    ]);
    expect(response.statusCode, response.body).toBe(200);
    expect(fixture.unit.abnormal).toHaveBeenLastCalledWith({
      operation: 'abnormal-duration-statistics',
      asinIds: [' 00042,MiXeD '],
      asinCodes: [' B,RAW '],
      variantGroupId: ' group,id ',
      asinName: ' name %_ ',
      variantGroupName: ' group %_ ',
      asinType: 'MAIN_LINK',
      includeSeries: '0',
    });
  });

  it('RED: keeps empty, duplicate and multiple bracket values as genuine arrays', async () => {
    expect(
      (
        await get([
          ['asinIds[]', ''],
          ['asinIds[]', ' id '],
          ['asinIds[]', ' id '],
        ])
      ).statusCode,
    ).toBe(200);
    expect(fixture.unit.abnormal).toHaveBeenLastCalledWith({
      operation: 'abnormal-duration-statistics',
      asinIds: ['', ' id ', ' id '],
      includeSeries: '1',
    });
  });

  it.each(
    (
      [
        [
          ['asinIds', 'id'],
          ['asinIds[]', 'id'],
        ],
        [
          ['asinCodes', 'code'],
          ['asinCodes[]', 'code'],
        ],
        [
          ['asinIds', ''],
          ['asinIds[]', 'id'],
        ],
        [['asinIds[0]', 'id']],
        [['asinIds[][]', 'id']],
        [['asinCodes[name]', 'code']],
        [['asinIds[]', 'x'.repeat(51)]],
        [['asinCodes[]', 'x'.repeat(201)]],
        [['asinIds[]', '\u0000']],
      ] satisfies [string, string][][]
    ).map((entries) => ({ entries })),
  )(
    'RED: rejects ambiguous, nested and invalid identifier shapes %# before repository execution',
    async ({ entries }) => {
      const response = await get(entries);
      expect(response.statusCode, response.body).toBe(400);
      expect(fixture.unit.abnormal).not.toHaveBeenCalled();
    },
  );

  it('RED: preserves the existing 1,000 item boundary and rejects a 1,001 item alias', async () => {
    const accepted: [string, string][] = Array.from({ length: 1000 }, () => [
      'asinIds[]',
      'a',
    ]);
    expect((await get(accepted)).statusCode).toBe(200);
    expect(fixture.unit.abnormal).toHaveBeenLastCalledWith({
      operation: 'abnormal-duration-statistics',
      asinIds: Array(1000).fill('a'),
      includeSeries: '1',
    });
    vi.mocked(fixture.unit.abnormal).mockClear();
    expect((await get([...accepted, ['asinIds[]', 'a']])).statusCode).toBe(400);
    expect(fixture.unit.abnormal).not.toHaveBeenCalled();
  });

  it('CONTROL: a scalar bracket field on another analytics route remains an unrelated ignored field', async () => {
    const response = await get([['asinIds[]', ' raw,id ']], 'statistics');
    expect(response.statusCode).toBe(200);
    expect(fixture.unit.duration).toHaveBeenLastCalledWith({
      operation: 'statistics',
    });
    expect(fixture.unit.abnormal).not.toHaveBeenCalled();
  });
});
