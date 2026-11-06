import { describe, expect, it } from 'vitest';
import {
  CAPTURE_MONITOR_ANALYTICS_GENERATION as capture,
  WRITE_MONITOR_ANALYTICS_CACHE as fill,
  LOOKUP_MONITOR_ANALYTICS_CACHE as lookup,
  ROTATE_MONITOR_ANALYTICS_GENERATION as rotate,
} from '../src/monitor/monitor-analytics-cache-control';
import { analyticsCacheRedisMemoryModel } from './helpers/analytics-cache-redis-memory-model';

// Semantic fixture oracles only; this suite does not execute Redis Lua.
const generation = 'fixture:neo:ops:analytics-cache:generation';
const data = 'fixture:neo:analytics:v1:data';
const status = 'fixture:neo:ops:analytics-cache:last-cleared-at';
const a = 'a'.repeat(64),
  b = 'b'.repeat(64),
  c = 'c'.repeat(64);
function fixture() {
  let time = 100000;
  const values = new Map<string, string>();
  const model = analyticsCacheRedisMemoryModel({
    dataValues: values,
    serverNow: () => time,
    legacyEval: async () => {
      throw new Error('UNEXPECTED_LEGACY_SCRIPT');
    },
  });
  return {
    ...model,
    values,
    setTime: (value: number) => {
      time = value;
    },
  };
}
describe('analytics generation memory port semantics', () => {
  it('atomically captures a persistent missing generation and returns a two-element cold tuple', async () => {
    const f = fixture();
    expect(await f.eval(lookup, [generation, data], [a, 2097152])).toEqual([
      a,
      null,
    ]);
    expect(await f.eval(capture, [generation], [b])).toEqual([a, '100000']);
    expect(f.controls.get(generation)).toEqual({ kind: 'string', value: a });
  });
  it.each([
    { label: 'wrong type', stored: { kind: 'other' as const } },
    {
      label: 'oversize',
      stored: { kind: 'string' as const, value: 'x'.repeat(2097153) },
    },
    {
      label: 'TTL',
      stored: { kind: 'string' as const, value: a, expiresAt: 105000 },
    },
    {
      label: 'non hex',
      stored: { kind: 'string' as const, value: 'z'.repeat(64) },
    },
  ])(
    'rejects $label control metadata without payload reads or repairing it',
    async ({ stored: bad }) => {
      const f = fixture();
      f.controls.set(generation, bad);
      f.values.set(data, 'payload');
      expect(await f.eval(lookup, [generation, data], [b, 2097152])).toBeNull();
      expect(await f.eval(capture, [generation], [b])).toBeNull();
      expect(f.controls.get(generation)).toEqual(bad);
      expect(f.diagnostics.payloadGets).toBe(0);
      if (bad.kind === 'other' || bad.value.length !== 64 || 'expiresAt' in bad)
        expect(f.diagnostics.generationGets).toBe(0);
    },
  );
  it('retains the captured lease for an oversized data miss without reading the payload', async () => {
    const f = fixture();
    f.values.set(data, 'x'.repeat(2097153));
    expect(await f.eval(lookup, [generation, data], [a, 2097152])).toEqual([
      a,
      null,
    ]);
    expect(f.diagnostics.payloadGets).toBe(0);
  });
  it('fences late fills and concurrent/retried clears without returning to a previous token', async () => {
    const f = fixture();
    await f.eval(capture, [generation], [a]);
    expect(await f.eval(fill, [generation, data], [a, 'old', 1000])).toBe('OK');
    expect(
      await f.eval(
        rotate,
        [generation, status],
        [a, b, 'first', 2592000, 105000],
      ),
    ).toBe(1);
    expect(await f.eval(fill, [generation, data], [a, 'late-old', 1000])).toBe(
      0,
    );
    expect(f.values.get(data)).toBe('old');
    expect(
      await f.eval(
        rotate,
        [generation, status],
        [a, c, 'retry-old', 2592000, 105000],
      ),
    ).toBe(0);
    expect(
      await f.eval(
        rotate,
        [generation, status],
        [b, c, 'second', 2592000, 105000],
      ),
    ).toBe(1);
    expect(
      await f.eval(
        rotate,
        [generation, status],
        [a, b, 'late-first', 2592000, 105000],
      ),
    ).toBe(0);
    expect(f.controls.get(generation)).toEqual({ kind: 'string', value: c });
    expect(await f.get(status)).toBe('second');
  });
  it('never initializes a missing generation during fill, and a new lookup fences the deleted lease', async () => {
    const f = fixture();
    await f.eval(capture, [generation], [a]);
    f.controls.delete(generation);
    expect(await f.eval(fill, [generation, data], [a, 'old', 1000])).toBe(0);
    expect(f.controls.has(generation)).toBe(false);
    await f.eval(lookup, [generation, data], [b, 2097152]);
    expect(await f.eval(fill, [generation, data], [a, 'old', 1000])).toBe(0);
    expect(f.values.size).toBe(0);
  });
  it('rejects execution at the fixed server deadline before changing either control field', async () => {
    const f = fixture();
    await f.eval(capture, [generation], [a]);
    f.setTime(100500);
    expect(
      await f.eval(
        rotate,
        [generation, status],
        [a, b, 'late', 2592000, 100500],
      ),
    ).toBe(-1);
    expect(f.controls.get(generation)).toEqual({ kind: 'string', value: a });
    expect(await f.get(status)).toBeNull();
  });
});
