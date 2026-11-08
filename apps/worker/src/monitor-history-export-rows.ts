import {
  formatShanghaiTimestamp,
  type MonitorHistoryExportRecord,
} from '@asin-monitor/db';

export const MONITOR_HISTORY_EXPORT_HEADER = [
  '检查时间',
  '检查类型',
  '变体组名称',
  'ASIN',
  'ASIN名称',
  'ASIN类型',
  '国家',
  '检查结果',
  '状态来源',
  '人工操作',
  '人工原因',
  '操作人',
  '检查详情',
] as const;
export const MONITOR_HISTORY_EXPORT_WIDTHS = [
  20, 10, 30, 15, 50, 10, 10, 10, 14, 16, 30, 16, 100,
];
export const monitorHistoryExportFilename = (at: Date) =>
  `监控历史_${formatShanghaiTimestamp(at).slice(0, 10)}.xlsx`;
function safeLegacyCell(value: unknown): string | number | boolean {
  if (!value) return '';
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // A historical JSON object must never become an Excel formula/hyperlink.
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string')
    throw new Error('EXPORT_HISTORY_CELL_INVALID');
  return serialized;
}
export function monitorHistoryExportRow(
  history: MonitorHistoryExportRecord,
): (string | number | boolean)[] {
  const raw = history.checkResult;
  // mysql2 decodes JSON columns before the unchanged Legacy exporter sees
  // them. PostgreSQL returns JSONB::text here; reproduce that one driver decode.
  let value: unknown = raw;
  if (raw) {
    try {
      value = JSON.parse(raw);
    } catch {
      /* Historical text remains literal. */
    }
  }
  let payload: Record<string, unknown> | null = null,
    details = '';
  if (value) {
    try {
      const parsed: unknown =
        typeof value === 'string' ? JSON.parse(value) : value;
      details = JSON.stringify(parsed, null, 2);
      if (parsed && typeof parsed === 'object')
        payload = parsed as Record<string, unknown>;
    } catch {
      details = safeLegacyCell(value) as string;
    }
  }
  const asinType =
    history.asinType === '1' || history.asinType === 'MAIN_LINK'
      ? '主链'
      : history.asinType === '2' || history.asinType === 'SUB_REVIEW'
      ? '副评'
      : history.asinType || '';
  return [
    history.checkTime,
    history.checkType === 'GROUP' ? '变体组' : history.checkType || '',
    history.variantGroupName || '',
    history.asin || '',
    history.asinName || '',
    asinType,
    history.country || '',
    history.isBroken === 1 ? '异常' : '正常',
    safeLegacyCell(payload?.statusSource),
    payload?.source === 'MANUAL_ACTION'
      ? payload.action === 'MARK_BROKEN'
        ? '人工标记异常'
        : '取消人工标记'
      : '',
    safeLegacyCell(payload?.reason || payload?.manualBrokenReason),
    safeLegacyCell(payload?.operator || payload?.manualBrokenUpdatedBy),
    details,
  ];
}
