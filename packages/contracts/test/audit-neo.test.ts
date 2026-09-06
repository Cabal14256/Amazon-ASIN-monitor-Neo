import { describe, expect, it } from 'vitest';
import { auditLogListQuerySchema } from '../src/domains/audit';
import {
  neoAuditLogIdParamsSchema,
  neoAuditLogListQuerySchema,
  neoAuditLogSchema,
  neoAuditStatisticsQuerySchema,
} from '../src/domains/audit-neo';

describe('Neo audit HTTP boundary', () => {
  it('keeps Legacy schema while bounding Neo pages and normalizing defaults', () => {
    expect(auditLogListQuerySchema.parse({ pageSize: '101' }).pageSize).toBe(
      101,
    );
    expect(neoAuditLogListQuerySchema.parse({})).toEqual({
      current: 1,
      pageSize: 10,
    });
    expect(
      neoAuditLogListQuerySchema.parse({
        current: '02',
        pageSize: '100',
        action: '',
      }),
    ).toEqual({ current: 2, pageSize: 100, action: undefined });
  });
  it.each([
    '0',
    '-1',
    '1.5',
    '',
    'Infinity',
    '1e3',
    true,
    ['1'],
    {},
    '9007199254740992',
  ])('rejects malformed page %#', (current) => {
    expect(neoAuditLogListQuerySchema.safeParse({ current }).success).toBe(
      false,
    );
  });
  it('rejects excessive size, unsafe offsets, repeated fields and oversized/control filters', () => {
    for (const input of [
      { pageSize: 101 },
      { current: Number.MAX_SAFE_INTEGER, pageSize: 100 },
      { username: ['one', 'two'] },
      { username: 'x'.repeat(51) },
      { action: 'READ\0' },
      { unknown: 'value' },
    ]) {
      expect(neoAuditLogListQuerySchema.safeParse(input).success).toBe(false);
    }
  });
  it.each([
    ['2026-09-06 12:30:15', '2026-09-06T04:30:15.000Z'],
    ['2026-09-06T12:30:15.123+08:00', '2026-09-06T04:30:15.123Z'],
    ['2026-09-06T00:30:15-04:00', '2026-09-06T04:30:15.000Z'],
    ['2026-09-06T04:30:15Z', '2026-09-06T04:30:15.000Z'],
    ['2024-02-29', '2024-02-28T16:00:00.000Z'],
    ['2026-01-01 00:00:00.1', '2025-12-31T16:00:00.100Z'],
  ])('interprets %s without host timezone guessing', (startTime, expected) => {
    expect(neoAuditStatisticsQuerySchema.parse({ startTime }).startTime).toBe(
      expected,
    );
  });
  it.each([
    '2023-02-29',
    '2026-02-30',
    '2026-13-01',
    '2026-00-01',
    '2026-01-00',
    '2026-09-06 24:00:00',
    '2026-09-06 12:60:00',
    '2026-09-06 12:30:60',
    '2026-09-06T12:30:00+24:00',
    '2026-09-06T12:30:00+08:60',
    '0000-01-01',
    '9999-12-31T23:59:59-23:00',
    'September 6 2026',
    '2026-09-06; SELECT 1',
  ])('rejects invalid date %s', (startTime) => {
    expect(neoAuditStatisticsQuerySchema.safeParse({ startTime }).success).toBe(
      false,
    );
  });
  it('compares instants across offsets and accepts an inclusive equal range', () => {
    expect(
      neoAuditStatisticsQuerySchema.safeParse({
        startTime: '2026-09-06T12:00:00+08:00',
        endTime: '2026-09-06T03:59:59Z',
      }).success,
    ).toBe(false);
    expect(
      neoAuditStatisticsQuerySchema.parse({
        startTime: '2026-09-06T12:00:00+08:00',
        endTime: '2026-09-06T04:00:00Z',
      }),
    ).toEqual({
      startTime: '2026-09-06T04:00:00.000Z',
      endTime: '2026-09-06T04:00:00.000Z',
    });
    expect(
      neoAuditStatisticsQuerySchema.parse({ startTime: '', endTime: '' }),
    ).toEqual({ startTime: undefined, endTime: undefined });
  });
  it('validates numeric identifiers without silently rounding or accepting path syntax', () => {
    expect(neoAuditLogIdParamsSchema.parse({ id: '9007199254740991' }).id).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    for (const id of [
      '0',
      '-1',
      '01',
      '1.5',
      '1e3',
      '../1',
      '9007199254740992',
    ])
      expect(neoAuditLogIdParamsSchema.safeParse({ id }).success).toBe(false);
  });
  it('allows JSON values while rejecting legacy aliases in Neo responses', () => {
    const row = {
      id: 1,
      userId: null,
      username: null,
      action: 'READ',
      resource: null,
      resourceId: null,
      resourceName: null,
      method: null,
      path: null,
      ipAddress: null,
      userAgent: null,
      requestData: ['masked', { password: '***' }],
      responseStatus: null,
      errorMessage: null,
    };
    expect(neoAuditLogSchema.parse(row)).toEqual(row);
    expect(neoAuditLogSchema.safeParse({ ...row, user_id: null }).success).toBe(
      false,
    );
  });
});
