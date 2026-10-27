import type { HomeWorkbenchData } from '../../src/domains/home-workbench-neo';

export const workbenchInstant = '2026-10-06T16:05:06.123Z';
export const workbenchDays = [
  '2026-10-01',
  '2026-10-02',
  '2026-10-03',
  '2026-10-04',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
];
export function homeWorkbenchFixture(
  trendsAuthorized = true,
): HomeWorkbenchData {
  return {
    generatedAt: workbenchInstant,
    days: [...workbenchDays],
    current: 1,
    pageSize: 10,
    total: 1,
    list: [
      {
        id: ' Raw Ś ',
        name: 'Fixture workbench',
        country: 'US',
        site: ' amazon.com ',
        brand: ' Raw Brand ',
        asinCount: 2,
        isBroken: true,
        lastCheckTime: '2026-10-06T15:59:59.999Z',
        trend: trendsAuthorized
          ? workbenchDays.map((day, index) => ({
              day,
              checks: index === 0 ? 3 : index === 6 ? 1 : 0,
              brokenChecks: index === 0 ? 1 : 0,
              unknownChecks: index === 0 ? 1 : index === 6 ? 1 : 0,
            }))
          : null,
      },
    ],
    facets: [
      {
        country: 'US',
        site: ' amazon.com ',
        brand: ' Raw Brand ',
        totalGroups: 1,
      },
    ],
    facetsTruncated: false,
    facetCurrent: 1,
    trendsAuthorized,
  };
}
