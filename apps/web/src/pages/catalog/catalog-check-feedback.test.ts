import { describe, expect, it } from 'vitest';
import { summarizeCheckResult } from './catalog-check-feedback';

describe('immediate check feedback', () => {
  it('summarizes broken and healthy ASIN results', () => {
    expect(summarizeCheckResult({ isBroken: true })).toContain('发现异常');
    expect(summarizeCheckResult({ isBroken: false })).toContain('未发现异常');
  });

  it('reports the bounded group result count without dumping payloads', () => {
    expect(
      summarizeCheckResult({
        details: { results: [{ variantView: {} }, { variantView: {} }] },
        authorization: 'must-not-render',
      }),
    ).toBe('检查完成：已返回 2 项结果，目录已更新。');
  });

  it('falls back safely for task references and malformed values', () => {
    expect(summarizeCheckResult({ kind: 'variant-check-receipt' })).toBe(
      '检查完成，目录已更新。',
    );
    expect(summarizeCheckResult(null, '。')).toBe('检查完成。');
  });
});
