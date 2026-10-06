import mysql, { type Connection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  orderScheduledMonitorGroups,
  scheduledMonitorGroupBatch,
  scheduledMonitorIdCrc32,
} from '../src/domain/scheduled-monitor-policy';
import crcGolden from './fixtures/scheduled-monitor-crc32.json';

// Read-only SQL on explicitly configured integration MySQL. Never load .env.
const suite =
  process.env.RUN_NEO_SCHEDULED_MONITOR_INTEGRATION === '1'
    ? describe
    : describe.skip;
suite('scheduled membership and native order against real MySQL', () => {
  let connection: Connection | undefined;
  const query = async (sql: string, values: unknown[]) => {
    if (!connection)
      throw new Error('Scheduled MySQL fixture is not connected');
    const [rows] = await connection.query(sql, values);
    return rows as { crc32: number; batch: number; id: string }[];
  };
  beforeAll(async () => {
    const host = process.env.INTEGRATION_MYSQL_HOST;
    const user = process.env.INTEGRATION_MYSQL_USER;
    const port = Number(process.env.INTEGRATION_MYSQL_PORT);
    if (!host || !user || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('Scheduled fixture requires explicit integration MySQL');
    connection = await mysql.createConnection({
      host,
      user,
      port,
      password: process.env.INTEGRATION_MYSQL_PASSWORD ?? '',
      charset: 'utf8mb4',
      connectTimeout: 5000,
    });
  });
  afterAll(async () => {
    await connection?.end();
  });
  it.each(crcGolden.cases)(
    'matches MySQL CRC32 UTF-8 bytes and unsigned modulo for $id',
    async ({ id, crc32 }) => {
      for (const count of [1, 2, 3, 17, 1000]) {
        const [row] = await query(
          'SELECT CRC32(?) AS crc32,MOD(CRC32(?),?) AS batch',
          [id, id, count],
        );
        expect(row.crc32).toBe(crc32);
        expect(scheduledMonitorIdCrc32(id)).toBe(row.crc32);
        expect(scheduledMonitorGroupBatch(id, count)).toBe(Number(row.batch));
      }
    },
  );
  it('preserves NULL-first native microseconds and raw binary ID tie order', async () => {
    const groups = [
      { id: 'A-later', createTimeNative: '2026-10-01 00:00:00.123457' },
      { id: 'Z-earlier', createTimeNative: '2026-10-01 00:00:00.123456' },
      { id: 'é', createTimeNative: '2026-10-01 00:00:00.100000' },
      { id: 'e\u0301', createTimeNative: '2026-10-01 00:00:00.1' },
      { id: 'A', createTimeNative: '2026-10-01 00:00:00.100000' },
      { id: ' null', createTimeNative: null },
      { id: '0', createTimeNative: null },
      { id: '😀', createTimeNative: '2026-10-01 00:00:00.100000' },
    ];
    const rows = await query(
      `SELECT id FROM (${groups
        .map(
          () =>
            'SELECT CAST(? AS CHAR CHARACTER SET utf8mb4) AS id,CAST(? AS DATETIME(6)) AS create_time',
        )
        .join(' UNION ALL ')}) AS native_groups
       ORDER BY create_time ASC,CAST(id AS BINARY) ASC`,
      groups.flatMap((group) => [group.id, group.createTimeNative]),
    );
    expect(rows.map((row) => row.id)).toEqual([
      ' null',
      '0',
      'A',
      'e\u0301',
      'é',
      '😀',
      'Z-earlier',
      'A-later',
    ]);
    expect(
      orderScheduledMonitorGroups(groups).map((group) => group.id),
    ).toEqual(rows.map((row) => row.id));
  });
});
