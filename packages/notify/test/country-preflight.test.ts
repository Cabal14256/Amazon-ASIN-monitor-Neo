import { describe, expect, it } from 'vitest';
import { buildFeishuCard } from '../src/cards';
import { NotificationError } from '../src/errors';
import { snapshotNotification } from '../src/input';
import { validateCountryNotification } from '../src/service';
import type { NotificationData } from '../src/types';

describe('country notification preflight', () => {
  it('rejects Markdown expansion even when both raw text and raw JSON fit', () => {
    const data: NotificationData = {
      brokenGroups: 1,
      brokenASINs: Array.from({ length: 5000 }, (_, index) => ({
        asin: `B${String(index).padStart(9, '0')}`,
        brand: 'B'.repeat(120),
        groupName: 'G',
        statusSource: 'AUTO',
      })),
    };
    expect(() => snapshotNotification(data)).not.toThrow();
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThan(1024 * 1024);
    expect(
      Buffer.byteLength(
        JSON.stringify(
          buildFeishuCard({
            ...data,
            country: 'US',
            countryDisplay: '美国(US)',
            region: 'US',
          }),
        ),
      ),
    ).toBeGreaterThan(1024 * 1024);
    expect(() => validateCountryNotification('primary', 'US', data)).toThrow(
      NotificationError,
    );
  });
  it.each(['primary', 'competitor'] as const)(
    'accepts a complete small %s card without mutating the source',
    (domain) => {
      const data = {
        brokenGroups: 1,
        brokenASINs: [
          { asin: 'B000000001', groupName: '', statusSource: 'MANUAL' },
        ],
      };
      const before = structuredClone(data);
      expect(() =>
        validateCountryNotification(domain, 'DE', data),
      ).not.toThrow();
      expect(data).toEqual(before);
    },
  );
});
