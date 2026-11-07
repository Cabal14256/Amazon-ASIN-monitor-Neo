import { trackWorkSettlement } from '@asin-monitor/sp-api';
import { readdir } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { parentExportFixture } from './helpers/parent-asin-export-fixture';

describe('parent ASIN export actual artifact and execution ownership', () => {
  it('reuses a published workbook after lost completion ACK without querying Amazon again', async () => {
    const f = await parentExportFixture();
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
      expect(f.query).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });
  it('removes an uncertain published artifact when cancellation wins before retry', async () => {
    const f = await parentExportFixture();
    try {
      f.loseAck(true);
      await expect(f.processor(f.job as never, 'lock')).rejects.toThrow(
        'EXPORT_COMPLETION_UNCONFIRMED',
      );
      f.cancel();
      f.loseAck(false);
      f.job.attemptsMade = 1;
      await expect(f.processor(f.job as never, 'lock')).resolves.toMatchObject({
        cancelled: true,
      });
      expect(f.state.status).toBe('cancelled');
      expect(await readdir(f.directory)).toEqual([]);
      expect(f.query).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });
  it('does not start upstream work after live primary authority is revoked', async () => {
    const f = await parentExportFixture();
    try {
      f.options.authorize.mockRejectedValue(new Error('revoked'));
      f.job.attemptsMade = 1;
      await expect(f.processor(f.job as never, 'lock')).rejects.toThrow(
        'PARENT_ASIN_EXPORT_ATTEMPT_FAILED',
      );
      expect(f.query).not.toHaveBeenCalled();
      expect(f.state.status).toBe('failed');
      expect(await readdir(f.directory)).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it.each(['cell', 'bytes'] as const)(
    'fails the %s budget without retaining any output',
    async (limit) => {
      const f = await parentExportFixture(limit === 'bytes' ? 1024 : undefined);
      try {
        if (limit === 'cell')
          f.query.mockImplementation(async () =>
            f.data.params.asins.map((asin) => ({
              asin,
              hasParentAsin: false,
              parentAsin: null,
              parentTitle: '',
              title: 'x'.repeat(32768),
              brand: null,
              hasVariants: false,
              variantCount: 0,
              error: null,
            })),
          );
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
  it('retains physical execution ownership after logical cancellation until native work closes', async () => {
    const f = await parentExportFixture();
    let release!: () => void;
    const closed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.query.mockImplementation(async (_asins, _country, options) => {
      trackWorkSettlement(options?.signal, closed);
      entered();
      return new Promise((_resolve, reject) =>
        options!.signal!.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true },
        ),
      );
    });
    let settled = false;
    const work = f.processor(f.job as never, 'lock').finally(() => {
      settled = true;
    });
    try {
      await started;
      f.cancel();
      await vi.waitFor(() => expect(f.state.status).toBe('cancelled'), {
        timeout: 2000,
      });
      expect(settled).toBe(false);
      release();
      await expect(work).resolves.toMatchObject({ cancelled: true });
      expect(await readdir(f.directory)).toEqual([]);
    } finally {
      release();
      await work.catch(() => undefined);
      await f.close();
    }
  });
});
