import {
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
    '查找竞品变体组，管理单项资料与归属。批量操作、检查、导入与导出仍在迁移。',
  showSite: false,
  showSource: false,
  showManual: false,
  list: getCompetitorGroups,
  detail: getCompetitorGroup,
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
