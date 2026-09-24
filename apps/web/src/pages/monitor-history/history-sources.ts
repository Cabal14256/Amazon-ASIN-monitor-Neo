import type { MonitorHistoryRecord } from '@asin-monitor/contracts';
import {
  getCompetitorHistory,
  getCompetitorHistoryDetail,
} from '../../services/competitor-history';
import {
  getMonitorHistory,
  getMonitorHistoryDetail,
} from '../../services/monitor-history';

const PRIMARY_TEXT_FILTERS = [
  { key: 'variantGroupId', label: '变体组 ID', max: 50 },
  { key: 'variantGroupName', label: '变体组名称', max: 255 },
  { key: 'asinId', label: 'ASIN ID', max: 50 },
  { key: 'asinName', label: 'ASIN 名称', max: 500 },
  { key: 'asinType', label: 'ASIN 类型', max: 50 },
  { key: 'country', label: '国家代码', max: 10 },
  { key: 'checkType', label: '检查类型', max: 50 },
] as const;
const COMPETITOR_TEXT_FILTERS = [
  { key: 'variantGroupId', label: '变体组 ID', max: 50 },
  { key: 'asinId', label: 'ASIN ID', max: 50 },
  { key: 'country', label: '国家代码', max: 10 },
  { key: 'checkType', label: '检查类型', max: 20 },
] as const;
export type TextKey = (typeof PRIMARY_TEXT_FILTERS)[number]['key'];
export type HistorySource = {
  key: 'monitor-history' | 'competitor-monitor-history';
  path: string;
  title: string;
  module: 'monitor' | 'competitor';
  eyebrow: string;
  description: string;
  listDescription: string;
  filtersDescription: string;
  textFilters: readonly { key: TextKey; label: string; max: number }[];
  competitor: boolean;
  getList: typeof getMonitorHistory;
  getDetail: (
    http: Parameters<typeof getMonitorHistoryDetail>[0],
    id: number,
    signal?: AbortSignal,
  ) => Promise<MonitorHistoryRecord>;
};
export const HISTORY_SOURCES: Record<'primary' | 'competitor', HistorySource> =
  {
    primary: {
      key: 'monitor-history',
      path: '/api/v1/monitor-history',
      title: '监控历史',
      module: 'monitor',
      eyebrow: 'MONITOR / 主营历史',
      description:
        '按 ASIN、快照名称、状态与上海时间查找主营检查记录。详情按当前权限实时读取。',
      listDescription: '只读取当前权限可见的主营历史',
      filtersDescription:
        '筛选由服务器执行；多个 ASIN 可用逗号、空格或换行分隔。',
      textFilters: PRIMARY_TEXT_FILTERS,
      competitor: false,
      getList: getMonitorHistory,
      getDetail: getMonitorHistoryDetail,
    },
    competitor: {
      key: 'competitor-monitor-history',
      path: '/api/v1/competitor/monitor-history',
      title: '竞品监控历史',
      module: 'competitor',
      eyebrow: 'COMPETITOR / 竞品历史',
      description:
        '按 ASIN、检查类型、状态与上海时间查找竞品检查记录，并查看父 ASIN 快照。',
      listDescription: '只读取当前权限可见的竞品历史',
      filtersDescription: '筛选由服务器执行；ASIN 支持单个 SQL LIKE 匹配模式。',
      textFilters: COMPETITOR_TEXT_FILTERS,
      competitor: true,
      getList: getCompetitorHistory,
      getDetail: getCompetitorHistoryDetail,
    },
  };
