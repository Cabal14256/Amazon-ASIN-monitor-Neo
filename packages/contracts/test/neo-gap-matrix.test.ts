import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENDPOINTS } from '../src/endpoints';

const matrix = readFileSync(
  new URL('../../../docs/plans/issue-48-neo-gap-matrix.md', import.meta.url),
  'utf8',
);

function matrixRows() {
  return matrix
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| ---'))
    .slice(1)
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

describe('Issue #48 Neo gap matrix', () => {
  it('tracks every unique contract endpoint exactly once', () => {
    const rows = matrixRows();
    const endpointKeys = ENDPOINTS.map((endpoint) =>
      `${endpoint.method} ${endpoint.path}`,
    );
    const matrixKeys = rows.map(([key]) => key);

    expect(rows).toHaveLength(ENDPOINTS.length);
    expect(new Set(matrixKeys).size).toBe(ENDPOINTS.length);
    expect(matrixKeys).toEqual(endpointKeys);
  });

  it('keeps the nine deprecated SSE exports explicitly Legacy-owned', () => {
    const rows = matrixRows();
    const deprecatedKeys = new Set(
      ENDPOINTS.filter((endpoint) => endpoint.deprecatedInNeo).map(
        (endpoint) => `${endpoint.method} ${endpoint.path}`,
      ),
    );
    const deprecatedRows = rows.filter(([key]) => deprecatedKeys.has(key));

    expect(deprecatedRows).toHaveLength(9);
    for (const row of deprecatedRows)
      expect(row[3]).toContain('Legacy-owned / Neo-deprecated');
  });
});
