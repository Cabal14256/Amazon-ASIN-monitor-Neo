export const MAX_ASIN_BATCH_ITEMS = 1000;

export interface AsinBatchInputIssue {
  value: string;
  position: number;
  line: number;
  column: number;
}

/** Token positions refer to the pasted input, before normalization/deduplication. */
export function parseAsinBatchInput(value: string) {
  const codes: string[] = [];
  const invalid: AsinBatchInputIssue[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;
  let position = 0;
  let cursor = 0;
  let line = 1;
  let column = 1;
  for (const match of value.matchAll(/[^\s,，;；]+/gu)) {
    while (cursor < match.index) {
      if (value[cursor] === '\r') {
        if (value[cursor + 1] === '\n') cursor++;
        line++;
        column = 1;
      } else if (value[cursor] === '\n') {
        line++;
        column = 1;
      } else column++;
      cursor++;
    }
    position++;
    const code = match[0].toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(code))
      invalid.push({ value: match[0], position, line, column });
    else if (seen.has(code)) duplicateCount++;
    else {
      seen.add(code);
      codes.push(code);
    }
    cursor += match[0].length;
    column += match[0].length;
  }
  return {
    codes,
    invalid,
    duplicateCount,
    overflow: codes.length > MAX_ASIN_BATCH_ITEMS,
    canSubmit:
      codes.length > 0 &&
      codes.length <= MAX_ASIN_BATCH_ITEMS &&
      invalid.length === 0,
  };
}
