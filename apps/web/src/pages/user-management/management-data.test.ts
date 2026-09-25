import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/http';
import {
  managementError,
  managementTime,
  permissionDenied,
  visibleManagementData,
} from './management-data';

describe('user management display boundaries', () => {
  it('uses Shanghai wall time and hides raw API error payloads', () => {
    expect(managementTime('2026-09-24T01:30:00Z')).toBe('2026-09-24 09:30:00');
    expect(managementTime(null)).toBe('未记录');
    expect(
      managementError(new ApiError('HTTP', 'raw personal data', 403)),
    ).toContain('没有执行');
    expect(
      managementError(new ApiError('HTTP', 'raw personal data', 503)),
    ).not.toContain('raw personal data');
  });

  it('keeps privileged snapshots hidden after revocation until a newer read succeeds', () => {
    const old = {
      value: [{ username: 'previously authorized' }],
      generation: 0,
    };
    const fresh = { value: [{ username: 'newly authorized' }], generation: 1 };
    expect(permissionDenied(new ApiError('HTTP', 'denied', 403))).toBe(true);
    expect(permissionDenied(new ApiError('HTTP', 'expired', 401))).toBe(true);
    expect(permissionDenied(new ApiError('HTTP', 'unavailable', 503))).toBe(
      false,
    );
    expect(visibleManagementData(old, null, false)).toBe(old.value);
    expect(visibleManagementData(old, 1, false)).toBeUndefined();
    expect(visibleManagementData(old, 1, true)).toBeUndefined();
    expect(visibleManagementData(fresh, 1, false)).toBe(fresh.value);
    expect(visibleManagementData(fresh, 1, true)).toBeUndefined();
  });
});
