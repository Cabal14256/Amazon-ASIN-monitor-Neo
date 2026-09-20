import type { AsinGroupQuery } from '../repositories/asin-query-repository';
import type { RoleWriteUnit } from '../repositories/role-repository';
import type {
  CompetitorAsin,
  CompetitorVariantGroup,
} from '../schema-competitor';

export type CompetitorGroupQuery = AsinGroupQuery;
export interface CompetitorGroupReadResult {
  groups: (CompetitorVariantGroup & { asinCount?: number })[];
  asins: CompetitorAsin[];
  total: number;
  totalASINs: number;
}
/** Authorization methods belong to the primary database; business reads belong
 * to the separate competitor database, under the same bounded operation. */
export interface CompetitorQueryUnit
  extends Pick<
    RoleWriteUnit,
    'lockOperator' | 'lockSession' | 'operatorPermissionCodes'
  > {
  list(query: CompetitorGroupQuery): Promise<CompetitorGroupReadResult>;
  detail(groupId: string): Promise<CompetitorGroupReadResult>;
}
export interface CompetitorQueryRepositoryPort {
  read<T>(
    operation: (unit: CompetitorQueryUnit) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  close?(): void;
}

export class CompetitorQueryError extends Error {
  constructor(
    readonly code:
      | 'input'
      | 'result'
      | 'capacity'
      | 'too-many-children'
      | 'dependency'
      | 'timeout'
      | 'cancelled'
      | 'closed',
  ) {
    super(`Competitor query ${code}`);
    this.name = 'CompetitorQueryError';
  }
}
