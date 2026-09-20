import type { Pool } from 'pg';
import {
  CompetitorQueryError,
  type CompetitorQueryRepositoryPort,
  type CompetitorQueryUnit,
} from '../domain/competitor-query';
import { DrizzleCompetitorReadUnit } from './competitor-read-unit';
import {
  CompetitorTransactionError,
  PgCompetitorTransactions,
} from './competitor-transactions';

function queryError(error: unknown): never {
  if (error instanceof CompetitorTransactionError)
    throw new CompetitorQueryError(
      error.code === 'commit-uncertain' ? 'dependency' : error.code,
    );
  throw error;
}
export class PgCompetitorQueryRepository
  implements CompetitorQueryRepositoryPort
{
  private readonly transactions: PgCompetitorTransactions;
  constructor(primary: Pool, competitor: Pool) {
    try {
      this.transactions = new PgCompetitorTransactions(primary, competitor);
    } catch (error) {
      queryError(error);
    }
  }
  getDiagnostics() {
    const value = this.transactions.getDiagnostics();
    return { pendingReads: value.pendingOperations, closed: value.closed };
  }
  async read<T>(
    operation: (unit: CompetitorQueryUnit) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await this.transactions.run(
        true,
        async ({ authorization, database, ensureOpen }) => {
          let queried = false;
          const business = async () => {
            if (queried) throw new CompetitorQueryError('capacity');
            queried = true;
            return new DrizzleCompetitorReadUnit(await database(), ensureOpen);
          };
          return operation({
            ...authorization,
            list: async (value) => (await business()).list(value),
            detail: async (id) => (await business()).detail(id),
          });
        },
        signal,
      );
    } catch (error) {
      return queryError(error);
    }
  }
  close() {
    this.transactions.close();
  }
}
