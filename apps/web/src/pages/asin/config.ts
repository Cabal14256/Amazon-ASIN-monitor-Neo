import {
  checkAsin,
  checkVariantGroup,
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
import { batchCreateAsins } from '../../services/asin-batch-create';
import type { CatalogConfig } from '../catalog/catalog-types';

export const ASIN_CATALOG: CatalogConfig = {
  id: 'asin',
  title: 'ASIN 管理',
  label: 'ASIN',
  heading: '变体组与 ASIN',
  description:
    '查找变体组和组内 ASIN，管理资料与归属，支持组内批量添加和 CSV/XLSX 异步导入。其它批量操作与导出仍在迁移。',
  showSite: true,
  showSource: true,
  showManual: true,
  list: getVariantGroups,
  detail: getVariantGroup,
  checks: { group: checkVariantGroup, asin: checkAsin },
  writes: {
    batchCreateAsins,
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
