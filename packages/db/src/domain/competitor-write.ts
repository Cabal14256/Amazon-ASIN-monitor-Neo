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
  ): Promise<CompetitorGroupReadResult>;
  createAsin(
    fields: CompetitorAsinWriteFields & { parentId: string },
  ): Promise<CompetitorAsin>;
  updateAsin(
    id: string,
    fields: CompetitorAsinWriteFields,
  ): Promise<CompetitorAsin>;
  moveAsin(id: string, targetGroupId: string): Promise<CompetitorAsin>;
  deleteGroup(id: string): Promise<void>;
  deleteAsin(id: string): Promise<void>;
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
      | 'duplicate'
      | 'timestamp-policy',
    readonly publicMessage?: string,
  ) {
    super(`Competitor write ${code}`);
    this.name = 'CompetitorWriteError';
  }
}
