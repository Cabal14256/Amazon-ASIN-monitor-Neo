import { getVariantGroup, getVariantGroups } from '../../services/asin';
import type { CatalogConfig } from '../catalog/catalog-types';

export const ASIN_CATALOG: CatalogConfig = {
  id: 'asin',
  title: 'ASIN 管理',
  label: 'ASIN',
  heading: '变体组与 ASIN',
  description:
    '查找变体组，查看组内 ASIN 的有效状态和最近检查。写入、导入与导出功能仍在迁移。',
  showSite: true,
  showSource: true,
  showManual: true,
  list: getVariantGroups,
  detail: getVariantGroup,
};
