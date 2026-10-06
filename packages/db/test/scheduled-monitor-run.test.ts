import { describe, expect, it } from 'vitest';
import {
  scheduledMonitorGroupBatch,
  scheduledMonitorJobDigest,
} from '../src/domain/scheduled-monitor-policy';
import {
  assertScheduledMonitorFollowUp,
  createScheduledMonitorFollowUp,
  freezeScheduledMonitorSnapshot,
  parseScheduledMonitorSnapshot,
  scheduledMonitorGroupOperation,
  scheduledMonitorGroupSnapshotDigest,
  scheduledMonitorSnapshotDigest,
  scheduledMonitorStorageBytes,
} from '../src/domain/scheduled-monitor-run';
import {
  scheduledGroup,
  scheduledJob,
  scheduledMember,
} from './helpers/scheduled-monitor-fixtures';

describe.each(['primary', 'competitor'] as const)(
  '%s scheduled complete frozen member domain',
  (domain) => {
    it('detaches complete native rows, raw Unicode IDs, all status/notification inputs and six digit clocks', () => {
      const job = scheduledJob(domain);
      const group = scheduledGroup(domain),
        member = scheduledMember(domain);
      if (domain === 'primary') {
        group.manual_broken = true;
        group.manual_broken_reason = '人工异常';
        member.manual_excluded_from_group = true;
        member.manual_excluded_reason = '独立排除';
      }
      const frozen = freezeScheduledMonitorSnapshot(job, [group], [member]);
      expect(frozen[0].group).toEqual(group);
      expect(frozen[0].members).toEqual([member]);
      expect(frozen[0].group.create_time).toBe('2026-09-27 08:30:00.000001');
      const digest = scheduledMonitorSnapshotDigest(job, frozen);
      group.name = '之后重命名';
      member.asin = 'B000000009';
      expect(frozen[0].group.name).toBe('原始名称');
      expect(frozen[0].members[0].asin).toBe('B000000001');
      expect(
        parseScheduledMonitorSnapshot(
          job,
          JSON.parse(JSON.stringify(frozen)),
          digest,
          1,
        ),
      ).toEqual(frozen);
    });
    it('orders NULLs, native microseconds and raw UTF-8 ID ties without millisecond Date conversion', () => {
      const rows = ['😀', '\uE000', 'later', 'null'].map((id) =>
        scheduledGroup(domain, id),
      );
      rows[0].create_time = '2026-09-27 08:30:00.000001';
      rows[1].create_time = '2026-09-27 08:30:00.000001';
      rows[2].create_time = '2026-09-27 08:30:00.000002';
      rows[3].create_time = null;
      const frozen = freezeScheduledMonitorSnapshot(
        scheduledJob(domain),
        rows,
        [],
      );
      expect(frozen.map((row) => row.group.id)).toEqual([
        'null',
        '\uE000',
        '😀',
        'later',
      ]);
      expect(frozen.map((row) => row.ordinal)).toEqual([0, 1, 2, 3]);
      expect(() =>
        parseScheduledMonitorSnapshot(
          scheduledJob(domain),
          [...frozen].reverse(),
        ),
      ).toThrow();
    });
    it('freezes an empty catalog and an empty group without fabricating members', () => {
      const job = scheduledJob(domain);
      expect(freezeScheduledMonitorSnapshot(job, [], [])).toEqual([]);
      expect(
        freezeScheduledMonitorSnapshot(job, [scheduledGroup(domain)], [])[0]
          .members,
      ).toEqual([]);
    });
    it.each([
      {
        name: 'rename',
        change: (rows: ReturnType<typeof freezeScheduledMonitorSnapshot>) => {
          rows[0].group.name = '篡改';
        },
      },
      {
        name: 'member',
        change: (rows: ReturnType<typeof freezeScheduledMonitorSnapshot>) => {
          rows[0].members[0].asin = 'B000000009';
        },
      },
      {
        name: 'ordinal',
        change: (rows: ReturnType<typeof freezeScheduledMonitorSnapshot>) => {
          rows[0].ordinal = 1;
        },
      },
      {
        name: 'digest',
        change: (rows: ReturnType<typeof freezeScheduledMonitorSnapshot>) => {
          rows[0].snapshotDigest = 'a'.repeat(64);
        },
      },
      {
        name: 'country',
        change: (rows: ReturnType<typeof freezeScheduledMonitorSnapshot>) => {
          rows[0].country = 'UK';
        },
      },
    ])('rejects $name snapshot pollution', ({ change }) => {
      const job = scheduledJob(domain);
      const frozen = freezeScheduledMonitorSnapshot(
        job,
        [scheduledGroup(domain)],
        [scheduledMember(domain)],
      );
      change(frozen);
      expect(() => parseScheduledMonitorSnapshot(job, frozen)).toThrow();
    });
    it('rejects duplicate groups/members, orphaned membership, mixed country and calendar corruption', () => {
      const job = scheduledJob(domain),
        group = scheduledGroup(domain),
        member = scheduledMember(domain);
      expect(() =>
        freezeScheduledMonitorSnapshot(job, [group, group], []),
      ).toThrow();
      expect(() =>
        freezeScheduledMonitorSnapshot(job, [group], [member, member]),
      ).toThrow();
      expect(() =>
        freezeScheduledMonitorSnapshot(
          job,
          [group],
          [{ ...member, variant_group_id: 'elsewhere' }],
        ),
      ).toThrow();
      expect(() =>
        freezeScheduledMonitorSnapshot(
          job,
          [group],
          [{ ...member, country: 'UK' }],
        ),
      ).toThrow();
      expect(() =>
        freezeScheduledMonitorSnapshot(
          job,
          [{ ...group, create_time: '2026-02-31 00:00:00.000001' }],
          [],
        ),
      ).toThrow();
      expect(() =>
        freezeScheduledMonitorSnapshot(
          job,
          [{ ...group, create_time: new Date() }],
          [],
        ),
      ).toThrow();
      expect(() =>
        freezeScheduledMonitorSnapshot(
          job,
          [{ ...group, extra: 'payload' }],
          [],
        ),
      ).toThrow();
    });
    it('checks original batch modulo and rejects a valid snapshot under a replacement job digest', () => {
      const job = scheduledJob(domain, {
        batchConfig: { totalBatches: 3, batchIndex: 0 },
      });
      // Select the same batch policy as the immutable planned slot, never rehash a trimmed ID.
      let id = ' original ';
      while (scheduledMonitorGroupBatch(id, 3) !== job.batchConfig.batchIndex)
        id += 'x';
      const frozen = freezeScheduledMonitorSnapshot(
        job,
        [scheduledGroup(domain, id)],
        [],
      );
      const digest = scheduledMonitorSnapshotDigest(job, frozen);
      expect(() =>
        parseScheduledMonitorSnapshot(
          {
            ...job,
            requestedAt: '2026-10-07T00:00:01.000Z',
            createdAt: '2026-10-07T00:00:01.000Z',
          },
          frozen,
          digest,
          0,
        ),
      ).toThrow();
      let other = 'wrong';
      while (
        scheduledMonitorGroupBatch(other, 3) === job.batchConfig.batchIndex
      )
        other += 'x';
      expect(() =>
        freezeScheduledMonitorSnapshot(
          job,
          [scheduledGroup(domain, other)],
          [],
        ),
      ).toThrow();
    });
    it('rejects oversized counts before materializing or silently truncating the directory', () => {
      const job = scheduledJob(domain);
      expect(() =>
        freezeScheduledMonitorSnapshot(
          job,
          Array(1001).fill(scheduledGroup(domain)),
          [],
        ),
      ).toThrowError(/capacity/);
      expect(() =>
        freezeScheduledMonitorSnapshot(
          job,
          [scheduledGroup(domain)],
          Array(20_001).fill(scheduledMember(domain)),
        ),
      ).toThrowError(/capacity/);
      const frozen = freezeScheduledMonitorSnapshot(
        job,
        [scheduledGroup(domain)],
        [scheduledMember(domain)],
      );
      expect(() =>
        parseScheduledMonitorSnapshot(
          job,
          frozen,
          scheduledMonitorSnapshotDigest(job, frozen),
          2,
        ),
      ).toThrow();
    });
    it('binds receipt identity to the original ordinal while a replacement digest conflicts with the same operation key', () => {
      const job = scheduledJob(domain);
      const [group] = freezeScheduledMonitorSnapshot(
        job,
        [scheduledGroup(domain)],
        [scheduledMember(domain)],
      );
      const operation = scheduledMonitorGroupOperation(job, group);
      expect(operation.jobDigest).toBe(scheduledMonitorJobDigest(job));
      expect(operation.resultKind).toBe(
        domain === 'primary' ? 'group' : 'competitor-group',
      );
      const replacement = structuredClone(group);
      replacement.group.name = 'replacement';
      const { snapshotDigest: _old, ...content } = replacement;
      replacement.snapshotDigest = scheduledMonitorGroupSnapshotDigest(content);
      const replaced = scheduledMonitorGroupOperation(job, replacement);
      expect(replaced.operationKey).toBe(operation.operationKey);
      expect(replaced.requestHash).not.toBe(operation.requestHash);
      expect(() =>
        scheduledMonitorGroupOperation(job, {
          ...group,
          snapshotDigest: 'a'.repeat(64),
        }),
      ).toThrow();
      expect(() =>
        scheduledMonitorGroupOperation(job, { ...group, country: 'UK' }),
      ).toThrow();
    });
  },
);
describe('scheduled US follow-up identity boundary', () => {
  it('creates one system competitor child with the original slot/batch and actual business-completion clock', () => {
    const parent = scheduledJob();
    const child = createScheduledMonitorFollowUp(
      parent,
      '2026-10-07T00:24:59.999Z',
    );
    expect(child).toMatchObject({
      domain: 'competitor',
      country: 'US',
      plannedSlot: parent.plannedSlot,
      batchConfig: parent.batchConfig,
      requestedAt: '2026-10-07T00:24:59.999Z',
      createdAt: '2026-10-07T00:24:59.999Z',
      expiresAt: parent.expiresAt,
    });
    expect(child.taskId).not.toBe(parent.taskId);
    expect('userId' in child).toBe(false);
    expect(
      assertScheduledMonitorFollowUp(
        parent,
        child.createdAt,
        child,
        scheduledMonitorJobDigest(child),
      ),
    ).toEqual(child);
  });
  it('rejects alternate actor, earlier requestedAt, forged digest, non-US parent and competitor recursion', () => {
    const parent = scheduledJob(),
      at = '2026-10-07T00:24:59.999Z';
    const child = createScheduledMonitorFollowUp(parent, at);
    expect(() =>
      assertScheduledMonitorFollowUp(parent, at, {
        ...child,
        userId: 'fabricated',
      }),
    ).toThrow();
    expect(() =>
      assertScheduledMonitorFollowUp(parent, at, {
        ...child,
        requestedAt: '2026-10-07T00:24:59.998Z',
      }),
    ).toThrow();
    expect(() =>
      assertScheduledMonitorFollowUp(parent, at, child, 'a'.repeat(64)),
    ).toThrow();
    expect(() =>
      createScheduledMonitorFollowUp(
        scheduledJob('primary', { country: 'UK' }),
        at,
      ),
    ).toThrow();
    expect(() =>
      createScheduledMonitorFollowUp(scheduledJob('competitor'), at),
    ).toThrow();
  });
  it.each([
    {
      requestedAt: '2026-10-07T00:25:00.000Z',
      createdAt: '2026-10-07T00:25:00.000Z',
    },
    { createdAt: '2026-10-07T00:25:00.000Z' },
    { expiresAt: '2026-10-14T00:00:00.001Z' },
    { expiresAt: '2026-10-13T23:59:59.999Z' },
  ])(
    'rejects refreshed child clocks or changed retention even with a matching replacement digest: %j',
    (changes) => {
      const parent = scheduledJob(),
        at = '2026-10-07T00:24:59.999Z';
      const child = {
        ...createScheduledMonitorFollowUp(parent, at),
        ...changes,
      };
      expect(() =>
        assertScheduledMonitorFollowUp(
          parent,
          at,
          child,
          scheduledMonitorJobDigest(child),
        ),
      ).toThrowError('Scheduled monitor run identity');
    },
  );
  it('rejects child creation before the parent existed or exactly at the original retention boundary', () => {
    const parent = scheduledJob('primary', {
      requestedAt: '2026-10-07T00:01:00.000Z',
      createdAt: '2026-10-07T00:02:00.000Z',
    });
    expect(() =>
      createScheduledMonitorFollowUp(parent, '2026-10-07T00:01:59.999Z'),
    ).toThrow();
    expect(() =>
      createScheduledMonitorFollowUp(parent, parent.expiresAt),
    ).toThrow();
    const child = createScheduledMonitorFollowUp(
      parent,
      '2026-10-13T23:59:59.999Z',
    );
    expect(child.expiresAt).toBe(parent.expiresAt);
    expect(() =>
      assertScheduledMonitorFollowUp(
        { ...parent, taskId: child.taskId },
        child.createdAt,
        child,
      ),
    ).toThrow();
  });
  it('counts JSONB punctuation overhead while leaving punctuation inside Unicode strings alone', () => {
    const value = { raw: '组, : 😀', nested: [null, true] };
    expect(scheduledMonitorStorageBytes(value)).toBe(
      Buffer.byteLength(JSON.stringify(value)) + 4,
    );
  });
});
