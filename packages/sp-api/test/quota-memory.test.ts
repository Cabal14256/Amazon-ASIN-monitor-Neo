import { describe, expect, it } from 'vitest';
import { QuotaMemory } from '../src/quota-memory';
import { buildQuotaWindows, DEFAULT_QUOTA_SETTINGS } from '../src/quota-policy';

describe('Atomic memory quota fallback', () => {
  it('does not consume regional capacity when an operation is blocked', () => {
    const memory = new QuotaMemory();
    const settings = {
      ...DEFAULT_QUOTA_SETTINGS,
      regionPerMinute: 1,
      regionPerHour: 1,
    };
    const blocked = buildQuotaWindows(settings, 'US', 'getCatalogItem');
    const available = buildQuotaWindows(settings, 'US', 'searchCatalogItems');
    expect(memory.consume(blocked.slice(2), 0).allowed).toBe(true);
    expect(memory.consume(blocked, 0).allowed).toBe(false);
    expect(
      memory.snapshot(blocked.slice(0, 2), 0).map((window) => window.remaining),
    ).toEqual([1, 1]);
    expect(memory.consume(available, 0).allowed).toBe(true);
    expect(
      memory
        .snapshot(available.slice(0, 2), 0)
        .map((window) => window.remaining),
    ).toEqual([0, 0]);
  });
  it('shares regional buckets across operations but keeps regions independent', () => {
    const memory = new QuotaMemory();
    const settings = {
      ...DEFAULT_QUOTA_SETTINGS,
      regionPerMinute: 1,
      regionPerHour: 1,
    };
    expect(
      memory.consume(buildQuotaWindows(settings, 'US', 'getCatalogItem'), 0)
        .allowed,
    ).toBe(true);
    const rejected = memory.consume(
      buildQuotaWindows(settings, 'US', 'searchCatalogItems'),
      0,
    );
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryMs).toBe(3600_000);
    expect(
      memory.consume(buildQuotaWindows(settings, 'EU', 'getCatalogItem'), 0)
        .allowed,
    ).toBe(true);
  });
  it('refills continuously and does not grant extra credit after a clock rollback', () => {
    const memory = new QuotaMemory();
    const windows = buildQuotaWindows(
      DEFAULT_QUOTA_SETTINGS,
      'US',
      'getCatalogItem',
    );
    expect(memory.consume(windows, 0).allowed).toBe(true);
    expect(memory.consume(windows, 500)).toEqual({
      allowed: false,
      retryMs: 167,
    });
    expect(memory.consume(windows, 1000).allowed).toBe(true);
    expect(memory.snapshot(windows, 750)[2]?.remaining).toBe(0);
    expect(memory.snapshot(windows, 1250)[2]?.remaining).toBe(0.375);
  });
  it('keeps consumed debt through lower and higher response-header limits', () => {
    const memory = new QuotaMemory();
    const original = buildQuotaWindows(
      DEFAULT_QUOTA_SETTINGS,
      'US',
      'getCatalogItem',
    ).slice(3, 4);
    expect(memory.consume(original, 0, 80).allowed).toBe(true);
    const lowered = buildQuotaWindows(
      DEFAULT_QUOTA_SETTINGS,
      'US',
      'getCatalogItem',
      { rate: 0.1, burst: 2 },
    ).slice(3, 4);
    expect(memory.snapshot(lowered, 0)[0]).toMatchObject({
      limit: 4,
      remaining: 0,
      used: 80,
    });
    expect(memory.consume(lowered, 0).allowed).toBe(false);
    expect(memory.snapshot(original, 0)[0]?.remaining).toBe(10);
  });
  it('does not reset buckets when building repeated snapshots', () => {
    const memory = new QuotaMemory();
    const windows = buildQuotaWindows(
      DEFAULT_QUOTA_SETTINGS,
      'US',
      'getCatalogItem',
    );
    memory.consume(windows, 0);
    for (let i = 0; i < 20; i++)
      expect(memory.snapshot(windows, 0)[2]?.remaining).toBe(0);
    expect(memory.consume(windows, 0).allowed).toBe(false);
  });
  it('bounds retained keys before allocating any part of an oversized set', () => {
    const memory = new QuotaMemory(2);
    const windows = buildQuotaWindows(
      DEFAULT_QUOTA_SETTINGS,
      'US',
      'getCatalogItem',
    );
    expect(() => memory.consume(windows, 0)).toThrow('SP-API CAPACITY');
    expect(memory.consume(windows.slice(0, 2), 0).allowed).toBe(true);
  });
  it.each([0, -1, 1.5, Infinity, 2])(
    'rejects an impossible token count %s before consuming anything',
    (tokens) => {
      const memory = new QuotaMemory();
      const windows = buildQuotaWindows(
        DEFAULT_QUOTA_SETTINGS,
        'US',
        'getCatalogItem',
      );
      expect(() => memory.consume(windows, 0, tokens)).toThrow(
        'SP-API INVALID_INPUT',
      );
      expect(memory.consume(windows, 0).allowed).toBe(true);
    },
  );
});
