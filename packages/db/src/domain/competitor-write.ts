import type {
  BatchCreateAsinsData,
  CompetitorAsinSource,
  CompetitorGroupSource,
} from '@asin-monitor/contracts';
import type { CompetitorAsin } from '../schema-competitor';
import type {
  CompetitorGroupReadResult,
  CompetitorQueryUnit,
} from './competitor-query';

export interface CompetitorGroupWriteFields {
  name: string;
  country: string;
  brand: string;
}
export interface CompetitorAsinWriteFields {
  asin: string;
  name: string | null;
  asinType: '1' | '2' | null;
  country: string;
  brand: string;
}
export interface CompetitorWriteUnit
  extends Pick<
    CompetitorQueryUnit,
    'lockOperator' | 'lockSession' | 'operatorPermissionCodes'
  > {
  createGroup(
    fields: CompetitorGroupWriteFields,
  ): Promise<CompetitorGroupReadResult>;
  updateGroup(
    id: string,
    fields: CompetitorGroupWriteFields,
    expectedSource?: CompetitorGroupSource,
  ): Promise<CompetitorGroupReadResult>;
  createAsin(
    fields: CompetitorAsinWriteFields & { parentId: string },
  ): Promise<CompetitorAsin>;
  updateAsin(
    id: string,
    fields: CompetitorAsinWriteFields,
    expectedSource?: CompetitorAsinSource,
  ): Promise<CompetitorAsin>;
  moveAsin(id: string, targetGroupId: string): Promise<CompetitorAsin>;
  batchCreateAsins(items: unknown[]): Promise<BatchCreateAsinsData>;
  deleteGroup(id: string, expectedChildIds: string[]): Promise<void>;
  deleteAsin(id: string, expectedSource?: CompetitorAsinSource): Promise<void>;
  updateGroupNotify(
    id: string,
    enabled: boolean,
  ): Promise<CompetitorGroupReadResult>;
  updateAsinNotify(id: string, enabled: boolean): Promise<CompetitorAsin>;
}
export interface CompetitorWriteRepositoryPort {
  transaction<T>(
    operation: (unit: CompetitorWriteUnit) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  close?(): void;
}
export class CompetitorWriteError extends Error {
  constructor(
    readonly code:
      | 'input'
      | 'group-not-found'
      | 'asin-not-found'
      | 'validation'
      | 'parent-changed'
      | 'source-changed'
      | 'members-changed'
      | 'duplicate'
      | 'timestamp-policy',
    readonly publicMessage?: string,
  ) {
    super(`Competitor write ${code}`);
    this.name = 'CompetitorWriteError';
  }
}
