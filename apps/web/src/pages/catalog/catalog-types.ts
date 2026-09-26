import type {
  CreateAsinRequest,
  MoveAsinRequest,
  UpdateAsinRequest,
  VariantGroupUpsertRequest,
} from '@asin-monitor/contracts';
import type { HttpClient } from '../../lib/http';

type Flag = 0 | 1 | boolean | null;

export interface CatalogChild {
  id: string;
  asin: string;
  name?: string | null;
  asinType?: string | number | null;
  country: string;
  site?: string | null;
  brand?: string | null;
  parentId?: string | null;
  isBroken?: Flag;
  autoIsBroken?: Flag;
  statusSource?: string;
  lastCheckTime?: string | null;
  feishuNotifyEnabled?: Flag;
  manualBrokenReason?: string | null;
  manualBroken?: Flag;
  manualBrokenScope?: string;
  selfManualBroken?: Flag;
  inheritedManualBroken?: Flag;
  manualExcludedFromGroup?: Flag;
  manualExcludedReason?: string | null;
}

export interface CatalogGroup {
  id: string;
  name: string;
  country: string;
  brand: string;
  site?: string;
  isBroken?: Flag;
  is_broken?: Flag;
  statusSource?: string;
  lastCheckTime?: string | null;
  last_check_time?: string | null;
  feishuNotifyEnabled?: Flag;
  manualBrokenReason?: string | null;
  manualBroken?: Flag;
  asin_count?: number;
  children?: CatalogChild[];
}

export interface CatalogQuery {
  keyword?: string;
  country?: string;
  variantStatus?: 'BROKEN' | 'NORMAL';
  current?: number;
  pageSize?: number;
}

export interface CatalogListData {
  list: CatalogGroup[];
  total: number;
  totalASINs?: number;
  current: number;
  pageSize: number;
}

export type CatalogAction =
  | { type: 'create-group' }
  | {
      type:
        | 'edit-group'
        | 'delete-group'
        | 'create-asin'
        | 'group-notify'
        | 'group-manual';
      group: CatalogGroup;
    }
  | {
      type: 'edit-asin' | 'delete-asin' | 'move-asin' | 'asin-notify';
      group: CatalogGroup;
      child: CatalogChild;
    }
  | {
      type: 'asin-manual';
      action:
        | 'MARK_BROKEN'
        | 'CLEAR_SELF_MANUAL'
        | 'EXCLUDE_GROUP_MANUAL'
        | 'CLEAR_GROUP_EXCLUSION';
      group: CatalogGroup;
      child: CatalogChild;
    };

export interface CatalogConfig {
  id: 'asin' | 'competitor';
  title: string;
  label: string;
  heading: string;
  description: string;
  showSite: boolean;
  showSource: boolean;
  showManual: boolean;
  list: (
    http: Pick<HttpClient, 'request'>,
    query: CatalogQuery,
    signal?: AbortSignal,
  ) => Promise<CatalogListData>;
  detail: (
    http: Pick<HttpClient, 'request'>,
    id: string,
    signal?: AbortSignal,
  ) => Promise<CatalogGroup>;
  writes?: CatalogWrites;
}

export interface CatalogWrites {
  createGroup: (
    http: Pick<HttpClient, 'request'>,
    input: VariantGroupUpsertRequest,
  ) => Promise<unknown>;
  updateGroup: (
    http: Pick<HttpClient, 'request'>,
    id: string,
    input: VariantGroupUpsertRequest,
  ) => Promise<unknown>;
  deleteGroup: (
    http: Pick<HttpClient, 'request'>,
    id: string,
  ) => Promise<unknown>;
  createAsin: (
    http: Pick<HttpClient, 'request'>,
    input: CreateAsinRequest,
  ) => Promise<unknown>;
  updateAsin: (
    http: Pick<HttpClient, 'request'>,
    id: string,
    input: UpdateAsinRequest,
  ) => Promise<unknown>;
  moveAsin: (
    http: Pick<HttpClient, 'request'>,
    id: string,
    input: MoveAsinRequest,
  ) => Promise<unknown>;
  deleteAsin: (
    http: Pick<HttpClient, 'request'>,
    id: string,
  ) => Promise<unknown>;
  updateGroupNotify: (
    http: Pick<HttpClient, 'request'>,
    id: string,
    enabled: boolean,
  ) => Promise<unknown>;
  updateGroupManual: (
    http: Pick<HttpClient, 'request'>,
    id: string,
    input: {
      markedBroken: boolean;
      reason?: string;
      expectedManualState?: {
        manualBroken: boolean;
        manualBrokenReason: string | null;
      };
    },
  ) => Promise<unknown>;
  updateAsinNotify: (
    http: Pick<HttpClient, 'request'>,
    id: string,
    enabled: boolean,
  ) => Promise<unknown>;
  updateAsinManual: (
    http: Pick<HttpClient, 'request'>,
    id: string,
    input: {
      action:
        | 'MARK_BROKEN'
        | 'CLEAR_SELF_MANUAL'
        | 'EXCLUDE_GROUP_MANUAL'
        | 'CLEAR_GROUP_EXCLUSION';
      reason?: string;
      expectedManualState?: {
        manualBroken: boolean;
        manualBrokenReason: string | null;
        manualExcludedFromGroup: boolean;
        manualExcludedReason: string | null;
        parentManualBroken: boolean;
      };
    },
  ) => Promise<unknown>;
}
