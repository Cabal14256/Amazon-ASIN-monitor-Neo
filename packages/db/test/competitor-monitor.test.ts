import type { CompetitorMonitorJob } from '@asin-monitor/contracts';
import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { CompetitorGroupCheckSnapshot } from '../src/domain/competitor-check';
import {
  assertCompetitorMonitorControl,
  assertCompetitorMonitorNotificationCandidate,
  competitorMonitorEnabled,
  competitorMonitorJobDigest,
  competitorMonitorSnapshotDigest,
  parseCompetitorMonitorCompletion,
} from '../src/domain/competitor-monitor';
import { createVariantCheckOperation } from '../src/domain/variant-check-receipt';
import { PgCompetitorMonitorRepository } from '../src/repositories/competitor-monitor-repository';
const created = new Date('2026-01-01T00:00:00.000Z');
const snapshot: CompetitorGroupCheckSnapshot = {
  group: {
    id: ' Gróup ',
    name: 'group',
    country: 'US',
    brand: 'brand',
    feishuNotifyEnabled: false,
    isBroken: false,
    variantStatus: 'NORMAL',
    createTime: created,
    updateTime: created,
    lastCheckTime: null,
  },
  asins: [
    {
      id: 'asin-1',
      asin: 'B000000001',
      name: 'child',
      asinType: 'MAIN_LINK',
      country: 'US',
      brand: 'brand',
      variantGroupId: ' Gróup ',
      feishuNotifyEnabled: false,
      isBroken: false,
      variantStatus: 'NORMAL',
      createTime: created,
      updateTime: created,
      lastCheckTime: null,
    },
  ],
};
const job: CompetitorMonitorJob = {
  taskId: '5f14b965-a86e-45c9-bb40-28c83959040a',
  userId: 'fixture-owner',
  taskType: 'competitor-monitor',
  taskSubType: 'competitor',
  createdAt: '2026-10-03T01:00:00.000Z',
  expiresAt: '2026-10-10T01:00:00.000Z',
  countries: ['US'],
};
function control() {
  return {
    lockOperator: vi.fn(async () => ({
      id: job.userId,
      status: 'ACTIVE',
      lockedUntil: null,
      forcePasswordChange: false,
      passwordExpiresAt: null,
    })),
    operatorPermissionCodes: vi.fn(async () => ['monitor:write']),
    competitorMonitorConfiguration: vi.fn(
      async () => undefined as string | null | undefined,
    ),
  };
}
describe('competitor monitor snapshot and control', () => {
  it('requires current canonical parent/member identity and both notification switches before new delivery', () => {
    const g = { ...snapshot.group, feishuNotifyEnabled: true },
      a = { ...snapshot.asins[0], feishuNotifyEnabled: true };
    const candidate = {
      groupId: g.id,
      groupName: g.name,
      groupCreatedAt: g.createTime!.toISOString(),
      asinId: a.id,
      asin: a.asin,
      brand: a.brand,
      asinCreatedAt: a.createTime!.toISOString(),
    };
    expect(() =>
      assertCompetitorMonitorNotificationCandidate('US', candidate, g, a),
    ).not.toThrow();
    for (const delta of [
      { id: 'foreign' },
      { name: 'renamed' },
      { country: 'DE' },
      { feishuNotifyEnabled: false },
      { createTime: new Date() },
    ])
      expect(() =>
        assertCompetitorMonitorNotificationCandidate(
          'US',
          candidate,
          { ...g, ...delta },
          a,
        ),
      ).toThrow();
    for (const delta of [
      { id: 'foreign' },
      { asin: 'B000000002' },
      { brand: 'changed' },
      { country: 'DE' },
      { variantGroupId: 'moved' },
      { feishuNotifyEnabled: false },
      { createTime: new Date() },
    ])
      expect(() =>
        assertCompetitorMonitorNotificationCandidate('US', candidate, g, {
          ...a,
          ...delta,
        }),
      ).toThrow();
    expect(() =>
      assertCompetitorMonitorNotificationCandidate(
        'US',
        candidate,
        undefined,
        a,
      ),
    ).toThrow();
    expect(() =>
      assertCompetitorMonitorNotificationCandidate(
        'US',
        candidate,
        g,
        undefined,
      ),
    ).toThrow();
  });
  it.each(['name', 'country', 'brand', 'feishuNotifyEnabled', 'id'] as const)(
    'binds group %s input',
    (key) => {
      const changed = structuredClone(snapshot);
      (changed.group as Record<string, unknown>)[key] =
        key === 'feishuNotifyEnabled' ? true : 'changed';
      expect(competitorMonitorSnapshotDigest(changed)).not.toBe(
        competitorMonitorSnapshotDigest(snapshot),
      );
    },
  );
  it.each([
    'asin',
    'country',
    'brand',
    'name',
    'asinType',
    'feishuNotifyEnabled',
    'variantGroupId',
    'id',
  ] as const)('binds member %s input', (key) => {
    const changed = structuredClone(snapshot);
    (changed.asins[0] as Record<string, unknown>)[key] =
      key === 'feishuNotifyEnabled' ? true : 'changed';
    expect(competitorMonitorSnapshotDigest(changed)).not.toBe(
      competitorMonitorSnapshotDigest(snapshot),
    );
  });
  it('binds membership/create identity without incidental update timestamps', () => {
    const changed = structuredClone(snapshot);
    changed.group.updateTime = new Date();
    changed.asins[0].updateTime = new Date();
    expect(competitorMonitorSnapshotDigest(changed)).toBe(
      competitorMonitorSnapshotDigest(snapshot),
    );
    changed.asins[0].createTime = new Date();
    expect(competitorMonitorSnapshotDigest(changed)).not.toBe(
      competitorMonitorSnapshotDigest(snapshot),
    );
    changed.asins = [];
    expect(competitorMonitorSnapshotDigest(changed)).not.toBe(
      competitorMonitorSnapshotDigest(snapshot),
    );
  });
  it('allows an accepted background task without a session lookup but requires current monitor permission', async () => {
    const unit = control();
    await assertCompetitorMonitorControl(unit, job.userId, true);
    unit.operatorPermissionCodes.mockResolvedValue([]);
    await expect(
      assertCompetitorMonitorControl(unit, job.userId, true),
    ).rejects.toMatchObject({ code: 'denied' });
  });
  it.each([
    { status: 'LOCKED' },
    { status: 'DISABLED' },
    { forcePasswordChange: true },
    { lockedUntil: new Date(Date.now() + 60000) },
    { passwordExpiresAt: created },
  ])('rejects changed account control %j', async (delta) => {
    const unit = control();
    unit.lockOperator.mockResolvedValue({
      ...(await unit.lockOperator()),
      ...delta,
    } as never);
    await expect(
      assertCompetitorMonitorControl(unit, job.userId, true),
    ).rejects.toMatchObject({ code: 'denied' });
    expect(unit.competitorMonitorConfiguration).not.toHaveBeenCalled();
  });
  it('uses current DB override and never masks a dependency error as a cached enable', async () => {
    const unit = control();
    unit.competitorMonitorConfiguration.mockResolvedValue(' false ');
    await expect(
      assertCompetitorMonitorControl(unit, job.userId, true),
    ).rejects.toMatchObject({ code: 'disabled' });
    unit.competitorMonitorConfiguration.mockRejectedValue(
      new Error('fixture-private-query'),
    );
    await expect(
      assertCompetitorMonitorControl(unit, job.userId, true),
    ).rejects.toThrow('fixture-private-query');
    expect(competitorMonitorEnabled(null, false)).toBe(false);
    expect(competitorMonitorEnabled('unknown', true)).toBe(true);
  });
  it('permits only the competitor monitor operation/result pairing', () => {
    const identity = {
      taskId: job.taskId,
      userId: job.userId,
      taskCreatedAt: job.createdAt,
      taskType: job.taskType,
      taskSubType: job.taskSubType,
      step: 'monitor-1234567890abcdef12345678',
      resultKind: 'competitor-group' as const,
      expiresAt: job.expiresAt,
    };
    expect(
      createVariantCheckOperation(identity, { groupId: 'group' }).taskType,
    ).toBe('competitor-monitor');
    expect(() =>
      createVariantCheckOperation(
        { ...identity, resultKind: 'group' },
        { groupId: 'group' },
      ),
    ).toThrow();
    expect(() =>
      createVariantCheckOperation(
        { ...identity, taskType: 'monitor' },
        { groupId: 'group' },
      ),
    ).toThrow();
  });
  it('binds completion proof to countries/owner/incarnation and exact count summaries', () => {
    const result = {
      success: true,
      totalChecked: 1,
      totalBroken: 1,
      totalNormal: 0,
      countryResults: {
        US: {
          totalGroups: 1,
          brokenGroups: 1,
          checkTime: job.createdAt,
          brokenByType: { SP_API_ERROR: 0, NOT_FOUND: 1, NO_VARIANTS: 0 },
        },
      },
      notificationResults: { US: 'unconfirmed' },
      _competitorMonitorCommit: {
        version: 1,
        requestHash: competitorMonitorJobDigest(job),
      },
    };
    expect(
      parseCompetitorMonitorCompletion(job, result).notificationResults.US,
    ).toBe('unconfirmed');
    for (const changed of [
      { userId: 'foreign' },
      { countries: ['DE'] },
      { createdAt: '2026-10-03T02:00:00.000Z' },
    ])
      expect(() =>
        parseCompetitorMonitorCompletion(
          { ...job, ...changed } as CompetitorMonitorJob,
          result,
        ),
      ).toThrow();
    expect(() =>
      parseCompetitorMonitorCompletion(job, { ...result, totalChecked: 2 }),
    ).toThrow();
  });
});

function deliveryFixture(state: unknown) {
  const group = {
    groupId: snapshot.group.id,
    country: 'US',
    snapshotDigest: 'a'.repeat(64),
  };
  const client = (name: string) =>
    Object.assign(new EventEmitter(), {
      query: vi.fn(
        async (
          input: string | { text: string },
          params: unknown[] = [],
        ): Promise<{ rows: Record<string, unknown>[] }> => {
          const text = typeof input === 'string' ? input : input.text;
          if (text.includes('current_database')) return { rows: [{ name }] };
          if (text.includes('FROM competitor_monitor_runs'))
            return {
              rows:
                params[0] === job.taskId
                  ? [
                      {
                        user_id: job.userId,
                        task_created_at: job.createdAt,
                        countries: job.countries,
                        expires_at: new Date(job.expiresAt),
                        groups: [group],
                      },
                    ]
                  : [],
            };
          if (text.includes('FROM competitor_monitor_notifications'))
            return { rows: state === undefined ? [] : [{ state }] };
          return { rows: [] };
        },
      ),
      release: vi.fn(),
    });
  const p = client('primary'),
    c = client('competitor');
  const pool = (value: typeof p) =>
    ({ connect: async () => value as unknown as PoolClient } as Pool);
  const repository = new PgCompetitorMonitorRepository(pool(p), pool(c));
  const authorize = vi.fn(async () => {});
  return { repository, p, c, authorize };
}
describe('identity-bound persisted competitor delivery reads through the public repository', () => {
  it.each(['sent', 'failed', 'claimed', undefined])(
    'reads %s without querying or changing current catalog or history',
    async (state) => {
      const f = deliveryFixture(state);
      try {
        expect(
          await f.repository.readNotification(job, 'US', f.authorize),
        ).toBe(state);
        expect(f.authorize).toHaveBeenCalledTimes(2);
        const queries = f.c.query.mock.calls.map(([q]) =>
          typeof q === 'string' ? q : q.text,
        );
        expect(queries.join('\n')).not.toMatch(
          /competitor_asins|competitor_variant_groups|competitor_monitor_history|INSERT|UPDATE|DELETE/,
        );
        const notice = f.c.query.mock.calls.find(
          ([q]) => typeof q !== 'string' && q.text.includes('SELECT state'),
        )!;
        expect(notice[1]).toEqual([job.taskId, 'US']);
        expect(f.p.release).toHaveBeenCalledExactlyOnceWith(false);
        expect(f.c.release).toHaveBeenCalledExactlyOnceWith(false);
      } finally {
        f.repository.close();
      }
    },
  );
  it.each([
    { userId: 'foreign' },
    { taskId: '29c62db2-6075-472d-9169-643e0f2a4628' },
    { taskType: 'monitor' },
    { taskSubType: 'primary' },
    { createdAt: '2026-10-03T02:00:00.000Z' },
    { expiresAt: '2026-10-11T01:00:00.000Z' },
    { countries: ['US', 'DE'] },
  ])('refuses a delivery for changed immutable job %j', async (change) => {
    const f = deliveryFixture('sent');
    try {
      await expect(
        f.repository.readNotification(
          { ...job, ...change } as CompetitorMonitorJob,
          'US',
          f.authorize,
        ),
      ).rejects.toThrow();
      expect(
        f.c.query.mock.calls.some(
          ([q]) => typeof q !== 'string' && q.text.includes('SELECT state'),
        ),
      ).toBe(false);
    } finally {
      f.repository.close();
    }
  });
  it('refuses an unrequested country and an unknown persisted state', async () => {
    const f = deliveryFixture('private-invalid-state');
    try {
      await expect(
        f.repository.readNotification(job, 'DE', f.authorize),
      ).rejects.toThrow('COMPETITOR_MONITOR_CLAIM_IDENTITY_CHANGED');
      await expect(
        f.repository.readNotification(job, 'US', f.authorize),
      ).rejects.toThrow('COMPETITOR_MONITOR_CLAIM_LOST');
    } finally {
      f.repository.close();
    }
  });
  it('rechecks current control before returning an old delivery and fails closed', async () => {
    const f = deliveryFixture('sent');
    f.authorize.mockImplementationOnce(async () => {});
    f.authorize.mockImplementationOnce(async () => {
      throw new Error('CURRENT_CONTROL_DENIED');
    });
    try {
      await expect(
        f.repository.readNotification(job, 'US', f.authorize),
      ).rejects.toThrow('CURRENT_CONTROL_DENIED');
      expect(f.c.query).not.toHaveBeenCalledWith('COMMIT');
      expect(f.c.release).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      f.repository.close();
    }
  });
});
