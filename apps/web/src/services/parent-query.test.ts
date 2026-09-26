import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../lib/http';
import { jsonResponse, sessionFixture } from '../lib/transport-fixtures';
import {
  parentQueryCsv,
  parseParentAsins,
  parseParentQueryItems,
  queryParentAsins,
  validParentAsins,
} from './parent-query';

describe('parent query transport', () => {
  it('normalizes, deduplicates, and validates ASIN input', () => {
    expect(parseParentAsins(' b012345678, B012345678\nB087654321 ')).toEqual([
      'B012345678',
      'B087654321',
    ]);
    expect(validParentAsins('B012345678\nnot-an-asin')).toEqual(['B012345678']);
  });

  it('validates synchronous results and normalizes the API URL', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        success: true,
        errorCode: 0,
        data: [
          {
            asin: 'B012345678',
            hasParentAsin: true,
            parentAsin: 'B087654321',
            parentTitle: 'Parent',
            title: 'Child',
            brand: 'Brand',
            hasVariants: true,
            variantCount: 2,
            error: null,
          },
        ],
      }),
    );
    const http = new HttpClient({
      baseURL: 'https://app.test/api/',
      pageOrigin: 'https://app.test',
      session: sessionFixture().store,
      fetch: fetcher,
    });
    const result = await queryParentAsins(http, {
      asins: ['b012345678'],
      country: 'US',
    });
    expect(Array.isArray(result)).toBe(true);
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe(
      '/api/v1/variant-check/batch-query-parent-asin',
    );
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({
      asins: ['B012345678'],
      country: 'US',
      useAsync: true,
    });
    expect(String(fetcher.mock.calls[0][0])).not.toContain('/api/api/');
    http.close();
  });

  it('rejects malformed task results before rendering', () => {
    expect(() => parseParentQueryItems([{ asin: 'B012345678' }])).toThrow(
      '父体查询结果格式无效',
    );
  });

  it('resumes a task returned in a failed submission envelope', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        {
          success: false,
          errorCode: 500,
          errorMessage: '任务已受理，但响应失败',
          data: { taskId: 'task-parent-1', status: 'pending' },
        },
        500,
      ),
    );
    const http = new HttpClient({
      baseURL: 'https://app.test/api',
      pageOrigin: 'https://app.test',
      session: sessionFixture().store,
      fetch: fetcher,
    });
    await expect(
      queryParentAsins(http, { asins: ['B012345678'], country: 'US' }),
    ).resolves.toEqual({ taskId: 'task-parent-1', status: 'pending' });
    http.close();
  });

  it('quotes CSV cells and neutralizes spreadsheet formulas from external titles', () => {
    const csv = parentQueryCsv([
      {
        asin: 'B012345678',
        hasParentAsin: false,
        parentAsin: null,
        parentTitle: '',
        title: '=HYPERLINK("https://invalid")',
        brand: 'Brand, Inc.',
        hasVariants: false,
        variantCount: 0,
        error: null,
      },
    ]);
    expect(csv).toContain('\'=HYPERLINK(""https://invalid"")');
    expect(csv).toContain('"Brand, Inc."');
  });
});
