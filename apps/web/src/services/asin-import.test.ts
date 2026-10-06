import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, HttpClient } from '../lib/http';
import { jsonResponse, sessionFixture } from '../lib/transport-fixtures';
import {
  submitAsinImport,
  uncertainAsinImportTaskId,
  validateAsinImportFile,
} from './asin-import';

const taskId = 'b2b5894c-5802-4c9f-a1bd-9a20263d270a';
const clients: HttpClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

function client(baseURL: string, fetcher: typeof fetch) {
  const result = new HttpClient({
    baseURL,
    pageOrigin: 'https://app.test',
    session: sessionFixture().store,
    fetch: fetcher,
  });
  clients.push(result);
  return result;
}

describe('ASIN import transport', () => {
  it.each(['/api', 'https://app.test/api/'])(
    'normalizes %s and submits one multipart file asynchronously',
    async (baseURL) => {
      const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
        expect(options?.method).toBe('POST');
        expect(options?.body).toBeInstanceOf(FormData);
        const form = options!.body as FormData;
        expect(form.getAll('file')).toHaveLength(1);
        expect((form.get('file') as File).name).toBe('items.csv');
        expect((form.get('file') as File).type).toBe('text/csv');
        expect(form.get('useAsync')).toBe('true');
        expect(new Headers(options?.headers).has('content-type')).toBe(false);
        return jsonResponse({
          success: true,
          errorCode: 0,
          data: { taskId, status: 'pending' },
        });
      });
      const result = await submitAsinImport(
        client(baseURL, fetcher),
        new File(['asin,country\nB00FIXTURE,US'], 'items.csv'),
      );
      expect(result).toEqual({ taskId, status: 'pending' });
      expect(fetcher.mock.calls[0][0]).toBe(
        'https://app.test/api/v1/variant-groups/import-excel',
      );
      expect(String(fetcher.mock.calls[0][0])).not.toContain('/api/api/');
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it('rejects unsupported, empty and oversized files before sending', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const http = client('/api', fetcher);
    for (const file of [
      new File(['x'], 'items.txt'),
      new File([], 'items.csv'),
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'items.xlsx'),
    ]) {
      expect(() => validateAsinImportFile(file)).toThrow(ApiError);
      await expect(submitAsinImport(http, file)).rejects.toMatchObject({
        kind: 'INVALID_INPUT',
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps an unconfirmed server task ID for read-only reconciliation', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        {
          success: false,
          errorCode: 500,
          errorMessage: '任务提交结果未确认',
          data: { taskId, status: 'unknown' },
        },
        500,
      ),
    );
    const http = client('/api', fetcher);
    const error = await submitAsinImport(
      http,
      new File(['data'], 'items.xlsx'),
    ).catch((cause: unknown) => cause);
    expect(uncertainAsinImportTaskId(error)).toBe(taskId);
    expect(
      uncertainAsinImportTaskId(
        new ApiError('HTTP', 'Failure', 500, 500, {
          taskId: '../unsafe',
          status: 'unknown',
        }),
      ),
    ).toBeNull();
  });

  it('does not treat a synchronous or malformed reply as async acceptance', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        success: true,
        errorCode: 0,
        data: {
          total: 1,
          processedCount: 1,
          successCount: 1,
          failedCount: 0,
          missingCount: 0,
          verificationPassed: true,
        },
      }),
    );
    await expect(
      submitAsinImport(
        client('/api', fetcher),
        new File(['data'], 'items.csv'),
      ),
    ).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });

  it('sends the API-supported XLSX MIME even when the browser reports none', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
      const form = options!.body as FormData;
      expect((form.get('file') as File).type).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      return jsonResponse({
        success: true,
        errorCode: 0,
        data: { taskId, status: 'pending' },
      });
    });
    await submitAsinImport(
      client('/api', fetcher),
      new File(['xlsx fixture'], 'items.xlsx'),
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
