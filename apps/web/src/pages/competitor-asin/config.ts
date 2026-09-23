import {
  getCompetitorGroup,
  getCompetitorGroups,
} from '../../services/competitor-asin';
import type { CatalogConfig } from '../catalog/catalog-types';

export const COMPETITOR_CATALOG: CatalogConfig = {
  id: 'competitor',
  title: '竞品 ASIN 管理',
  label: '竞品 ASIN',
  heading: '竞品变体组与 ASIN',
  description:
    '查找竞品变体组，查看子 ASIN 的展示状态和最近检查。筛选与展示状态沿用各自的业务口径；写入、检查、导入与导出仍在迁移。',
  showSite: false,
  showSource: false,
  showManual: false,
  list: getCompetitorGroups,
  detail: getCompetitorGroup,
};
