import type { CatalogVariantResult } from '@asin-monitor/sp-api';
import type { RoleWriteUnit } from '../repositories/role-repository';
import type {
  CompetitorAsin,
  CompetitorVariantGroup,
} from '../schema-competitor';
import type { CompetitorMonitorControlUnit } from './competitor-monitor';
import type {
  ScheduledMonitorCheck,
  ScheduledMonitorGroupOperation,
} from './scheduled-monitor-run';
import type { VariantCheckOperation } from './variant-check-receipt';

export interface CompetitorGroupCheckSnapshot {
  group: CompetitorVariantGroup;
  asins: CompetitorAsin[];
}
export interface CompetitorSingleCheckSnapshot {
  group: CompetitorVariantGroup;
  asin: CompetitorAsin;
}
export type CompetitorCheckObservation =
  | {
      asinId: string;
      kind: 'checked';
      result: CatalogVariantResult;
    }
  | {
      asinId: string;
      kind: 'failed';
      error: string;
    };
export interface CommittedCompetitorGroupCheck
  extends CompetitorGroupCheckSnapshot {
  observations: CompetitorCheckObservation[];
}
export interface CommittedCompetitorSingleCheck
  extends CompetitorSingleCheckSnapshot {
  result: CatalogVariantResult;
}
export type CompetitorCheckAuthorization = Pick<
  RoleWriteUnit,
  'lockOperator' | 'lockSession' | 'operatorPermissionCodes'
>;
export interface CompetitorCheckUnit extends CompetitorCheckAuthorization {
  competitorMonitorConfiguration?: CompetitorMonitorControlUnit['competitorMonitorConfiguration'];
  readReceipt(
    operation: VariantCheckOperation,
    lock?: boolean,
  ): Promise<unknown | undefined>;
  saveReceipt(operation: VariantCheckOperation, result: unknown): Promise<void>;
  purgeExpiredReceipts(): Promise<number>;
  loadGroup(groupId: string): Promise<CompetitorGroupCheckSnapshot>;
  loadSingle(asinId: string): Promise<CompetitorSingleCheckSnapshot>;
  commitGroup(
    expected: CompetitorGroupCheckSnapshot,
    observations: CompetitorCheckObservation[],
    guard: () => Promise<void>,
    monitor?: { operation: VariantCheckOperation; snapshotDigest: string },
    scheduled?: ScheduledMonitorCheck,
  ): Promise<CommittedCompetitorGroupCheck>;
  assertScheduledMonitorGroup?(check: ScheduledMonitorCheck): Promise<void>;
  recordScheduledMonitorGroupReceipt?(
    operation: ScheduledMonitorGroupOperation,
    result: unknown,
  ): Promise<void>;
  commitSingle(
    expected: CompetitorSingleCheckSnapshot,
    result: CatalogVariantResult,
    guard: () => Promise<void>,
  ): Promise<CommittedCompetitorSingleCheck>;
}
export interface CompetitorCheckRepositoryPort {
  transaction<T>(
    action: (unit: CompetitorCheckUnit) => Promise<T>,
    signal?: AbortSignal,
    onActualWork?: (work: Promise<unknown>) => void,
  ): Promise<T>;
}
