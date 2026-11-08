import { MonitorHistoryQueryError } from '@asin-monitor/db';
import ExcelJS from 'exceljs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { historyExportFixture } from './helpers/monitor-history-export-fixture';

describe('monitor-history bounded workbook recovery', () => {
  it('streams multiple bounded pages in one repository snapshot and freezes the omitted end time once', async () => {
    const f = await historyExportFixture();
    try {
      const source = f.rows[0]!.record;
      f.setRows(
        Array.from({ length: 1001 }, (_, index) => ({
          cursor: {
            id: String(1001 - index),
            checkTime: '2026-09-27 00:00:00.123456',
          },
          record: { ...source, asin: `B${String(index).padStart(9, '0')}` },
        })),
      );
      f.data.params.endTime = '';
      await f.processor(f.job as never, 'lock');
      expect(f.read).toHaveBeenCalledTimes(1);
      expect(f.page).toHaveBeenCalledTimes(3);
      expect(f.page.mock.calls.map(([params]) => params.endTime)).toEqual(
        Array(3).fill('2026-09-27 00:01:02'),
      );
      expect(f.state).toMatchObject({
        status: 'completed',
        result: { rowCount: 1001 },
      });
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(
        join(f.directory, `export-${f.taskId}.xlsx`),
      );
      const sheet = workbook.worksheets[0]!;
      expect(sheet.rowCount).toBe(1002);
      expect(sheet.getCell('D2').value).toBe('B000000000');
      expect(sheet.getCell('D1002').value).toBe('B000001000');
    } finally {
      await f.close();
    }
  });
  it('reconciles a published workbook after lost ACK without reading a new snapshot', async () => {
    const f = await historyExportFixture();
    try {
      f.loseAck(true);
      await expect(f.processor(f.job as never, 'lock')).rejects.toThrow(
        'EXPORT_COMPLETION_UNCONFIRMED',
      );
      const artifact = await f.artifacts.read(f.taskId);
      expect(artifact).not.toBeNull();
      f.loseAck(false);
      f.job.attemptsMade = 1;
      await f.processor(f.job as never, 'lock');
      expect(f.state).toMatchObject({
        status: 'completed',
        result: { artifact },
      });
      expect(f.read).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });
  it('deletes an uncertain published workbook when cancellation wins before retry', async () => {
    const f = await historyExportFixture();
    try {
      f.loseAck(true);
      await expect(f.processor(f.job as never, 'lock')).rejects.toThrow(
        'EXPORT_COMPLETION_UNCONFIRMED',
      );
      f.loseAck(false);
      f.cancel();
      f.job.attemptsMade = 1;
      await expect(f.processor(f.job as never, 'lock')).resolves.toMatchObject({
        cancelled: true,
      });
      expect(f.state.status).toBe('cancelled');
      expect(await readdir(f.directory)).toEqual([]);
      expect(f.read).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });
  it('honors a cancellation that races the atomic artifact publication', async () => {
    const f = await historyExportFixture();
    try {
      const publish = f.artifacts.publish.bind(f.artifacts);
      vi.spyOn(f.artifacts, 'publish').mockImplementation(async (...args) => {
        const artifact = await publish(...args);
        f.cancel();
        return artifact;
      });
      await expect(f.processor(f.job as never, 'lock')).resolves.toMatchObject({
        cancelled: true,
      });
      expect(f.state.status).toBe('cancelled');
      expect(await readdir(f.directory)).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it('checks current monitor authority before querying any business data', async () => {
    const f = await historyExportFixture();
    try {
      f.options.authorize.mockRejectedValue(new Error('revoked'));
      f.job.attemptsMade = 1;
      await expect(f.processor(f.job as never, 'lock')).rejects.toThrow(
        'MONITOR_HISTORY_EXPORT_ATTEMPT_FAILED',
      );
      expect(f.state.status).toBe('failed');
      expect(f.read).not.toHaveBeenCalled();
      expect(await readdir(f.directory)).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it.each(['cell', 'bytes', 'page'] as const)(
    'fails the %s budget without publishing partial content',
    async (kind) => {
      const f = await historyExportFixture(kind === 'bytes' ? 1024 : undefined);
      try {
        if (kind === 'cell')
          f.setRows([
            {
              ...f.rows[0]!,
              record: {
                ...f.rows[0]!.record,
                checkResult: JSON.stringify({ reason: 'x'.repeat(32768) }),
              },
            },
          ]);
        if (kind === 'page')
          f.page.mockRejectedValue(new MonitorHistoryQueryError('too-large'));
        await expect(f.processor(f.job as never, 'lock')).rejects.toThrow(
          '超过上限',
        );
        expect(f.state.status).toBe('failed');
        expect(await readdir(f.directory)).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );
});
