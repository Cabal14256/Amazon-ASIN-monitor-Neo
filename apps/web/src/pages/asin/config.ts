import {
  createAsin,
  createVariantGroup,
  deleteAsin,
  deleteVariantGroup,
  getVariantGroup,
  getVariantGroups,
  moveAsin,
  updateAsin,
  updateAsinManual,
  updateAsinNotify,
  updateVariantGroup,
  updateVariantGroupManual,
  updateVariantGroupNotify,
} from '../../services/asin';
import type { CatalogConfig } from '../catalog/catalog-types';

export const ASIN_CATALOG: CatalogConfig = {
  id: 'asin',
  title: 'ASIN 管理',
  label: 'ASIN',
  heading: '变体组与 ASIN',
  description:
    '查找变体组和组内 ASIN，管理单项资料与归属。批量操作、导入与导出功能仍在迁移。',
  showSite: true,
  showSource: true,
  showManual: true,
  list: getVariantGroups,
  detail: getVariantGroup,
  writes: {
    createGroup: createVariantGroup,
    updateGroup: updateVariantGroup,
    deleteGroup: deleteVariantGroup,
    createAsin,
    updateAsin,
    moveAsin,
    deleteAsin,
    updateGroupNotify: updateVariantGroupNotify,
    updateGroupManual: updateVariantGroupManual,
    updateAsinNotify,
    updateAsinManual,
  },
};
