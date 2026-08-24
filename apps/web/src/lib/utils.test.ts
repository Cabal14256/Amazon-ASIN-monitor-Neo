import { describe, expect, it } from 'vitest';

import { cn } from '@/lib/utils';

describe('cn()', () => {
  it('合并类名并去重 tailwind 冲突', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn('text-sm', 'font-bold')).toBe('text-sm font-bold');
    expect(cn('text-sm', undefined, null, 'font-bold')).toBe('text-sm font-bold');
  });
});
