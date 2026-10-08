import {
  batchDeleteCompetitorGroups,
  createCompetitorAsin,
  createCompetitorGroup,
  deleteCompetitorAsin,
  deleteCompetitorGroup,
  getCompetitorGroup,
  getCompetitorGroups,
  moveCompetitorAsin,
  updateCompetitorAsin,
  updateCompetitorGroup,
} from '../../services/competitor-asin';
import type { CatalogConfig } from '../catalog/catalog-types';

export const COMPETITOR_CATALOG: CatalogConfig = {
  id: 'competitor',
  title: '竞品 ASIN 管理',
  label: '竞品 ASIN',
  heading: '竞品变体组与 ASIN',
  description:
    '查找竞品变体组，管理资料与归属，支持多选批量删除、CSV / XLSX 导入，并在任务中心核对结果。检查与导出仍在迁移。',
  showSite: false,
  showSource: false,
  showManual: false,
  list: getCompetitorGroups,
  detail: getCompetitorGroup,
  batchDelete: batchDeleteCompetitorGroups,
  writes: {
    createGroup: createCompetitorGroup,
    updateGroup: updateCompetitorGroup,
    deleteGroup: deleteCompetitorGroup,
    createAsin: createCompetitorAsin,
    updateAsin: updateCompetitorAsin,
    moveAsin: moveCompetitorAsin,
    deleteAsin: deleteCompetitorAsin,
  },
};
