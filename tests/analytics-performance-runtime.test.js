const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createStartupCapture,
  migrationPlan,
} = require('../scripts/analytics-performance-runtime');

test('upgrade bootstrap targets both logical domains without loading rollback SQL', () => {
  assert.deepEqual(
    migrationPlan([
      '0016_scheduled_monitor_primary.sql',
      '0016_scheduled_monitor_competitor.rollback.sql',
      '0000_baseline.sql',
      '0009_notification_country_collation.sql',
      '0016_scheduled_monitor_competitor.sql',
      '0015_competitor_monitor.sql',
      '0001_timescale_aggregates.sql',
    ]),
    [
      { filename: '0001_timescale_aggregates.sql', domains: ['primary'] },
      {
        filename: '0009_notification_country_collation.sql',
        domains: ['primary', 'competitor'],
      },
      { filename: '0015_competitor_monitor.sql', domains: ['competitor'] },
      {
        filename: '0016_scheduled_monitor_competitor.sql',
        domains: ['competitor'],
      },
      { filename: '0016_scheduled_monitor_primary.sql', domains: ['primary'] },
    ],
  );
  assert.throws(() => migrationPlan(['0017_unclassified.sql']));
  assert.throws(() => migrationPlan(['0016_unclassified.sql']));
  assert.throws(() => migrationPlan(['0017_other.v2.sql']));
});

test('every new filename requires an explicit domain mapping even when its version exists', () => {
  for (const filename of [
    '0001_primary_fix.sql',
    '0009_primary_fix.sql',
    '0015_primary_fix.sql',
    '0016_primary_fix.sql',
    'migration.sql',
  ])
    assert.throws(
      () => migrationPlan([filename]),
      /Unclassified migration requires fixture review/,
      filename,
    );
});

test('startup artifacts redact secrets split at every chunk boundary before truncation', () => {
  const secret = 'synthetic-secret-that-must-not-survive';
  for (let split = 1; split < secret.length; split++) {
    const capture = createStartupCapture(new Set([secret]), 96);
    capture.write('stdout', `old diagnostic ${'x'.repeat(64)}\n`);
    capture.write('stdout', `password=${secret.slice(0, split)}`);
    capture.write('stderr', 'independent stderr diagnostic\n');
    capture.write('stdout', `${secret.slice(split)}; Bearer any.jwt.value\n`);
    const text = capture.finish();
    assert.ok(text.includes('password=<redacted>; Bearer <redacted>'));
    assert.ok(!text.includes(secret));
    assert.ok(Buffer.byteLength(text) <= 96);
  }
});

test('oversized and unfinished lines never become partially exposed artifact suffixes', () => {
  const secret = 'synthetic-private-value';
  const capture = createStartupCapture(new Set([secret]), 96);
  capture.write('stdout', `${'x'.repeat(97)}password=${secret}`);
  capture.write('stdout', '\nuseful complete diagnostic\n');
  capture.write('stderr', `password=${secret.slice(0, 12)}`);
  const text = capture.finish();
  assert.ok(text.includes('useful complete diagnostic'));
  assert.ok(text.includes('unfinished startup line omitted'));
  assert.ok(!text.includes('password='));
  assert.ok(!text.includes(secret));
  assert.ok(Buffer.byteLength(text) <= 96);
});
