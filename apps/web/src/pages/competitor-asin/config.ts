import {
  checkCompetitorAsin,
  checkCompetitorGroup,
} from '../../services/catalog-check';
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
    '查找竞品变体组，管理单项资料与归属；单组与单 ASIN 检查已接入异步任务。竞品批量检查接口仍在迁移。',
  showSite: false,
  showSource: false,
  showManual: false,
  list: getCompetitorGroups,
  detail: getCompetitorGroup,
  checks: { group: checkCompetitorGroup, asin: checkCompetitorAsin },
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
