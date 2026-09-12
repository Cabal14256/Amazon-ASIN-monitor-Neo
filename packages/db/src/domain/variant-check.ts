import type {
  CatalogVariantResult,
  GroupCatalogResult,
} from '@asin-monitor/sp-api';
import type { AsinQueryUnit } from '../repositories/asin-query-repository';
import type { Asin, VariantGroup } from '../schema';

export interface GroupCheckSnapshot {
  group: VariantGroup;
  asins: Asin[];
}
export interface SingleCheckSnapshot {
  group: VariantGroup;
  asin: Asin;
}
export type AsinCheckObservation = { asinId: string } & (
  | { kind: 'checked'; result: GroupCatalogResult }
  | { kind: 'deferred'; error: string }
  | { kind: 'failed'; error: string }
);
export interface CommittedGroupCheck extends GroupCheckSnapshot {
  observations: AsinCheckObservation[];
}
export interface CommittedSingleCheck extends SingleCheckSnapshot {
  result: CatalogVariantResult;
}
export type CheckCommitGuard = () => Promise<void>;
export interface VariantCheckUnit extends AsinQueryUnit {
  loadGroup(groupId: string): Promise<GroupCheckSnapshot>;
  loadSingle(asinId: string): Promise<SingleCheckSnapshot>;
  commitGroup(
    expected: GroupCheckSnapshot,
    observations: AsinCheckObservation[],
    guard: CheckCommitGuard,
  ): Promise<CommittedGroupCheck>;
  commitSingle(
    expected: SingleCheckSnapshot,
    result: CatalogVariantResult,
    guard: CheckCommitGuard,
  ): Promise<CommittedSingleCheck>;
}
export interface VariantCheckRepositoryPort {
  transaction<T>(action: (unit: VariantCheckUnit) => Promise<T>): Promise<T>;
}
export class VariantCheckError extends Error {
  constructor(
    readonly code:
      | 'capacity'
      | 'invalid-input'
      | 'invalid-result'
      | 'group-not-found'
      | 'asin-not-found'
      | 'snapshot-changed',
  ) {
    super(
      {
        capacity: '变体检查容量已满，请稍后重试',
        'invalid-input': '变体检查参数无效',
        'invalid-result': '变体检查结果无效',
        'group-not-found': '变体组不存在',
        'asin-not-found': 'ASIN记录不存在',
        'snapshot-changed': '检查期间商品或检查状态已变化，请重新检查',
      }[code],
    );
    this.name = 'VariantCheckError';
  }
}
