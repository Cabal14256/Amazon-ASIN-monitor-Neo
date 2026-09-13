import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MonitorAnalyticsResultLimitError } from '../src/domain/monitor-abnormal-duration';
import type { MonitorDurationSourceRow } from '../src/domain/monitor-duration-groups';
import { MonitorDurationStream } from '../src/domain/monitor-duration-stream';

const range = {
  startTime: '2024-01-01 03:00:00',
  endTime: '2024-01-20 03:30:00',
};
const rows = Array.from({ length: 4000 }, (_, index) => ({
  slot_period: `2024-01-${String(1 + Math.floor(index / 200)).padStart(
    2,
    '0',
  )} 03:00:00`,
  country: index % 2 ? 'US' : 'UK',
  asin_key: `A${index % 200}`,
  total_checks: 7,
  broken_count: index % 8,
  has_peak: index % 2,
}));
function legacy(grouping: 'period' | 'country') {
  const script = `
const fs=require('node:fs'),vm=require('node:vm');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const m={exports:{}};
vm.runInNewContext(fs.readFileSync(input.filename,'utf8'),{module:m,require:name=>{
  if(['../config/database','../services/cacheService','../services/analyticsCacheService','../services/analyticsAggService','../utils/logger'].includes(name)) return {};
  throw new Error('Unexpected Legacy dependency');
}});
const value=m.exports.buildDurationRowsByGroup(input.rows,{
  sourceGranularity:'hour',targetGranularity:'day',
  queryStartDate:new Date(input.range.startTime.replace(' ','T')),
  queryEndDate:new Date(input.range.endTime.replace(' ','T')),
  buildGroupKey:(period,row)=>input.grouping==='period'?period:row.country,
  buildGroupMeta:(period,row)=>({key:input.grouping==='period'?period:row.country,first:row.asin_key}),
});
process.stdout.write(JSON.stringify(value));`;
  return JSON.parse(
    execFileSync(process.execPath, ['-e', script], {
      input: JSON.stringify({
        rows,
        grouping,
        range,
        filename: resolve(
          __dirname,
          '../../../server/src/models/MonitorHistory.js',
        ),
      }),
      env: { ...process.env, TZ: 'Asia/Shanghai' },
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }),
  );
}
function stream(
  grouping: 'period' | 'country',
  maximum = 200,
  maxResults = 5000,
) {
  return new MonitorDurationStream<
    MonitorDurationSourceRow,
    { key: string; first: string }
  >({
    ...range,
    sourceGranularity: 'hour',
    targetGranularity: 'day',
    periodScoped: grouping === 'period',
    maxStateEntries: maximum,
    maxResults,
    buildGroupKey: (period, row) =>
      grouping === 'period' ? period : row.country,
    buildGroupMeta: (period, row) => ({
      key: grouping === 'period' ? period : row.country || '',
      first: row.asin_key || '',
    }),
  });
}
describe('monitor duration stream / actual Legacy grouping', () => {
  it('flushes completed periods and preserves partial buckets, rounding and first metadata across arbitrary batch boundaries', () => {
    const value = stream('period');
    for (let offset = 0; offset < rows.length; offset += 73)
      value.add(rows.slice(offset, offset + 73));
    expect(value.finish()).toEqual(legacy('period'));
    expect(value.finish()).toHaveLength(20);
    expect(() => value.add(rows.slice(0, 1))).toThrow();
  });
  it('deduplicates an ASIN over the complete query range for non-period groups', () => {
    const value = stream('country');
    for (let offset = 0; offset < rows.length; offset += 211)
      value.add(rows.slice(offset, offset + 211));
    expect(value.finish()).toEqual(legacy('country'));
    expect(value.finish().map((row) => row.totalAsinsDedup)).toEqual([
      100, 100,
    ]);
  });
  it('enforces live state/output limits and rejects unordered period input instead of emitting split duplicate groups', () => {
    expect(() => stream('country', 199).add(rows)).toThrow(
      MonitorAnalyticsResultLimitError,
    );
    expect(() => stream('period', 200, 19).add(rows)).toThrow(
      MonitorAnalyticsResultLimitError,
    );
    const value = stream('period');
    value.add(rows.slice(200, 201));
    expect(() => value.add(rows.slice(0, 1))).toThrow();
  });
});
