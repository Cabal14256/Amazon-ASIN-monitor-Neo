import type {
  AbnormalDurationRead,
  AbnormalDurationScope,
} from '../../services/monitor-abnormal';

export const ABNORMAL_HEADERS = [
  'ASIN',
  '国家',
  '查询时间段',
  '异常次数',
  '平均异常时长',
  '最短异常时长',
  '最长异常时长',
  '最长异常时间',
] as const;
const COUNTRY_NAMES: Record<string, string> = {
  US: '美国',
  UK: '英国',
  DE: '德国',
  FR: '法国',
  IT: '意大利',
  ES: '西班牙',
};
type AppliedFilters = {
  variantGroupId: string;
  variantGroupName: string;
  asinId: string;
  asin: string;
  asinName: string;
  asinType: string;
  country: string;
};

/** Capture raw identifiers/names before the record list's normalizing filters. */
export function historyAbnormalScope(
  filters: AppliedFilters,
  startTime?: string,
  endTime?: string,
): AbnormalDurationScope | null {
  if (!startTime || !endTime || startTime > endTime) return null;
  const codes = filters.asin
    .trim()
    .split(/[,\s]+/)
    .filter(Boolean);
  if (
    !filters.variantGroupId.trim() &&
    !filters.variantGroupName.trim() &&
    !filters.asinId.trim() &&
    !codes.length
  )
    return null;
  return {
    includeSeries: '0',
    startTime,
    endTime,
    ...(filters.variantGroupId.trim()
      ? { variantGroupId: filters.variantGroupId }
      : {}),
    ...(filters.variantGroupName.trim()
      ? { variantGroupName: filters.variantGroupName }
      : {}),
    ...(filters.asinId.trim() ? { asinIds: [filters.asinId] } : {}),
    ...(codes.length
      ? { asinCodes: codes.length === 1 ? [filters.asin] : codes }
      : {}),
    ...(filters.asinName.trim() ? { asinName: filters.asinName } : {}),
    ...(filters.asinType.trim() ? { asinType: filters.asinType.trim() } : {}),
    ...(filters.country.trim()
      ? { country: filters.country.trim().toUpperCase() }
      : {}),
  };
}

export function abnormalSummaryCells(
  row: AbnormalDurationRead['summary'][number],
) {
  return [
    row.asin || '-',
    COUNTRY_NAMES[row.country] || row.country || '-',
    row.queryTimeRange || '-',
    String(row.abnormalCount),
    `${row.averageAbnormalDuration.toFixed(2)} 小时`,
    `${row.minAbnormalDuration.toFixed(2)} 小时`,
    `${row.maxAbnormalDuration.toFixed(2)} 小时`,
    row.maxAbnormalTime || '-',
  ];
}

function csvCell(value: string) {
  const first = [...value].find(
    (char) => !/\s/u.test(char) && char.charCodeAt(0) > 31,
  );
  const safe = first && '=+@-'.includes(first) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function downloadAbnormalCsv(
  summary: AbnormalDurationRead['summary'],
  scope: AbnormalDurationScope,
) {
  if (!summary.length) return;
  const csv = [
    ABNORMAL_HEADERS.map(csvCell).join(','),
    ...summary.map((row) => abnormalSummaryCells(row).map(csvCell).join(',')),
  ].join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
  const range = `${scope.startTime}_${scope.endTime}`.replace(
    /[\\/:*?"<>|\s]+/g,
    '-',
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  try {
    link.href = url;
    link.download = `异常时长统计_${range}.csv`;
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}
