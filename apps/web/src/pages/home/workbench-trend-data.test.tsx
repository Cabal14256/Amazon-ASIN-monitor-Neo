// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { homeWorkbenchFixture } from '../../../../../packages/contracts/test/helpers/home-workbench';
import { WorkbenchSparkline } from './workbench-sparkline';
import { workbenchTrendPoints } from './workbench-trend-data';
afterEach(cleanup);
describe('real seven-day known-result denominator and explicit gaps', () => {
  it('excludes unknown observations from the denominator and keeps empty/unknown-only dates null', () => {
    const days = homeWorkbenchFixture().list[0].trend!;
    expect(workbenchTrendPoints(days).map((point) => point.ratio)).toEqual([
      50,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    render(<WorkbenchSparkline days={days} name="Group" />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain(
      '1次未知，异常率50.0%',
    );
    expect(screen.getByRole('img').querySelectorAll('circle')).toHaveLength(1);
    expect(screen.getByRole('img').querySelectorAll('path')).toHaveLength(1);
  });
  it('does not join two actual observations across a missing date', () => {
    const days = homeWorkbenchFixture().list[0].trend!;
    days[2] = { ...days[2], checks: 2, brokenChecks: 2 };
    render(<WorkbenchSparkline days={days} name="Group" />);
    expect(screen.getByRole('img').querySelectorAll('circle')).toHaveLength(2);
    expect(screen.getByRole('img').querySelectorAll('path')).toHaveLength(1);
  });
  it('shows unknown/empty feedback instead of a fabricated zero-percent line', () => {
    const days = homeWorkbenchFixture().list[0].trend!.map((day) => ({
      ...day,
      checks: 1,
      brokenChecks: 0,
      unknownChecks: 1,
    }));
    render(<WorkbenchSparkline days={days} name="Group" />);
    expect(screen.getByText('暂无有效检查').title).toContain('无有效趋势');
    expect(screen.queryByRole('img')).toBeNull();
  });
});
