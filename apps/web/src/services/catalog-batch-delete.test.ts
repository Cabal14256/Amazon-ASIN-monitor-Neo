import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, HttpClient } from '../lib/http';
import { jsonResponse, sessionFixture } from '../lib/transport-fixtures';
import { batchDeleteVariantGroups } from './asin';
import {
  batchDeleteCounts,
  summarizeBatchDelete,
} from './catalog-batch-delete';
import { batchDeleteCompetitorGroups } from './competitor-asin';

const clients: HttpClient[] = [];
afterEach(() => {
  for (const http of clients.splice(0)) http.close();
});
const counts = {
  mode: 'sync',
  totalRequested: 2,
  deletedGroupCount: 1,
  deletedDirectAsinCount: 0,
  deletedNestedAsinCount: 3,
  skipped: { groupIds: ['missing'], asinIds: [] },
};
const services = [batchDeleteVariantGroups, batchDeleteCompetitorGroups];
function httpFixture(response: Response) {
  const fetcher = vi.fn<typeof fetch>(async () => response);
  const http = new HttpClient({
    pageOrigin: 'https://app.test/',
    baseURL: '/api/',
    session: sessionFixture().store,
    fetch: fetcher,
  });
  clients.push(http);
  return { http, fetcher };
}
describe('typed catalog batch-delete receipts and target safeguards', () => {
  it.each(services)(
    'preserves unpadded Unicode target IDs and accepts bounded sync counts',
    async (service) => {
      const f = httpFixture(jsonResponse({ success: true, data: counts }));
      expect(
        await service(f.http, {
          groupIds: ['组😀', 'missing'],
          useAsync: true,
        }),
      ).toEqual(counts);
      expect(
        JSON.parse(String(f.fetcher.mock.calls[0][1]?.body)).groupIds,
      ).toEqual(['组😀', 'missing']);
    },
  );
  it.each(services)(
    'rejects unsafe padded IDs and oversized batches before transport',
    async (service) => {
      const f = httpFixture(jsonResponse({ success: true, data: counts }));
      for (const groupIds of [
        [' Source '],
        ['😀'.repeat(51)],
        Array.from({ length: 1001 }, (_, index) => String(index)),
      ])
        await expect(service(f.http, { groupIds })).rejects.toMatchObject({
          kind: 'INVALID_INPUT',
        });
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it.each(services)(
    'retains the lookup ID from an uncertain 503 failure rather than treating it as success',
    async (service) => {
      const f = httpFixture(
        jsonResponse(
          {
            success: false,
            errorCode: 503,
            errorMessage: 'unknown',
            data: { taskId: 'task-1', status: 'unknown' },
          },
          503,
        ),
      );
      expect(await service(f.http, { groupIds: ['group-1'] })).toEqual({
        mode: 'async',
        taskId: 'task-1',
        status: 'unknown',
      });
    },
  );
  it.each(['../escape', 'task/1', '%2F', ' '])(
    'rejects unsafe task receipt %s',
    async (taskId) => {
      const f = httpFixture(
        jsonResponse({
          success: true,
          data: { mode: 'async', taskId, status: 'pending', totalRequested: 1 },
        }),
      );
      await expect(
        batchDeleteVariantGroups(f.http, { groupIds: ['group-1'] }),
      ).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    },
  );
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid count %s',
    (count) => {
      expect(
        batchDeleteCounts({ ...counts, deletedNestedAsinCount: count }),
      ).toBeNull();
    },
  );
  it('reports partial failure and malformed receipts without claiming all targets were deleted', () => {
    expect(summarizeBatchDelete({ ...counts, failedCount: 2 })).toContain(
      '失败分块 2',
    );
    expect(summarizeBatchDelete(null)).toContain('统计回执无效');
    expect(batchDeleteCounts({ ...counts, deletedGroupCount: 3 })).toBeNull();
  });
  it('does not turn a malformed failure payload into a task lookup', async () => {
    const request = vi.fn(async () => {
      throw new ApiError('HTTP', 'unknown', 500, undefined, {
        taskId: '../wrong',
        status: 'unknown',
      });
    });
    await expect(
      batchDeleteVariantGroups({ request }, { groupIds: ['group-1'] }),
    ).rejects.toMatchObject({ status: 500 });
  });
});
