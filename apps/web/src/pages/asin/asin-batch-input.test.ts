import { describe, expect, it } from 'vitest';
import { parseAsinBatchInput } from './asin-batch-input';

const code = (index: number) => `B${String(index).padStart(9, '0')}`;

describe('primary batch ASIN input', () => {
  it.each(['B00000000ſ', 'B0000000ß'])(
    'rejects original Unicode token %s before ASCII uppercase mapping',
    (input) => {
      expect(parseAsinBatchInput(input)).toMatchObject({
        codes: [],
        invalid: [{ value: input }],
        canSubmit: false,
      });
    },
  );
  it.each(['\n', '\r\n', '\r', ' ', '\t', ',', '，', ';', '；'])(
    'accepts delimiter %j and normalizes lowercase',
    (separator) => {
      expect(parseAsinBatchInput(`b000000001${separator}b000000002`)).toEqual({
        codes: ['B000000001', 'B000000002'],
        invalid: [],
        duplicateCount: 0,
        overflow: false,
        canSubmit: true,
      });
    },
  );

  it('deduplicates normalized codes in first-appearance order', () => {
    const parsed = parseAsinBatchInput(
      'b000000002, B000000001；B000000002 b000000001',
    );
    expect(parsed.codes).toEqual(['B000000002', 'B000000001']);
    expect(parsed.duplicateCount).toBe(2);
    expect(parsed.canSubmit).toBe(true);
  });

  it.each(['', ' \r\n，;；\t'])('rejects an empty input %j', (input) => {
    expect(parseAsinBatchInput(input)).toMatchObject({
      codes: [],
      canSubmit: false,
    });
  });

  it('reports original token positions, lines and columns without submitting valid fragments', () => {
    const parsed = parseAsinBatchInput(
      'b000000001, BAD\r\n  B000000002；B0000-0003\n短编码',
    );
    expect(parsed.codes).toEqual(['B000000001', 'B000000002']);
    expect(parsed.invalid).toEqual([
      { value: 'BAD', position: 2, line: 1, column: 13 },
      { value: 'B0000-0003', position: 4, line: 2, column: 14 },
      { value: '短编码', position: 5, line: 3, column: 1 },
    ]);
    expect(parsed.canSubmit).toBe(false);
  });

  it.each([1000, 1001])('enforces the unique-code limit at %i', (count) => {
    const parsed = parseAsinBatchInput(
      Array.from({ length: count }, (_, i) => code(i)).join('\n'),
    );
    expect(parsed.codes).toHaveLength(count);
    expect(parsed.overflow).toBe(count > 1000);
    expect(parsed.canSubmit).toBe(count === 1000);
  });

  it('applies the limit after deduplication', () => {
    const parsed = parseAsinBatchInput(
      Array.from({ length: 1001 }, () => code(1)).join(' '),
    );
    expect(parsed.codes).toEqual([code(1)]);
    expect(parsed.duplicateCount).toBe(1000);
    expect(parsed.canSubmit).toBe(true);
  });
});
