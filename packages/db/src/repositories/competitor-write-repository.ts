import type { Pool } from 'pg';
import {
  CompetitorWriteError,
  type CompetitorWriteRepositoryPort,
  type CompetitorWriteUnit,
} from '../domain/competitor-write';
import {
  CompetitorTransactionError,
  PgCompetitorTransactions,
} from './competitor-transactions';
import { prepareCompetitorWrites } from './competitor-write-policy';
import { DrizzleCompetitorWriteUnit } from './competitor-write-unit';

function duplicate(error: unknown) {
  let current = error;
  for (
    let depth = 0;
    depth < 3 && current && typeof current === 'object';
    depth++
  ) {
    const value = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (
      value.code === '23505' &&
      typeof value.constraint === 'string' &&
      [
        'uk_competitor_asins_asin_country',
        'uq_competitor_asins_asin_country_ci',
        'idx_neo_competitor_write_asin_country',
      ].includes(value.constraint)
    )
      return true;
    current = value.cause;
  }
  return false;
}
export class PgCompetitorWriteRepository
  implements CompetitorWriteRepositoryPort
{
  private readonly transactions: PgCompetitorTransactions;
  constructor(primary: Pool, competitor: Pool) {
    this.transactions = new PgCompetitorTransactions(primary, competitor);
  }
  getDiagnostics() {
    return this.transactions.getDiagnostics();
  }
  async transaction<T>(
    operation: (unit: CompetitorWriteUnit) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await this.transactions.run(
        false,
        async ({ authorization, database, ensureOpen }) => {
          let mutated = false;
          const business = async () => {
            if (mutated) throw new CompetitorTransactionError('capacity');
            mutated = true;
            const db = await database();
            await prepareCompetitorWrites(db, ensureOpen);
            return new DrizzleCompetitorWriteUnit(db, ensureOpen);
          };
          return operation({
            ...authorization,
            createGroup: async (fields) =>
              (await business()).createGroup(fields),
            updateGroup: async (id, fields) =>
              (await business()).updateGroup(id, fields),
            createAsin: async (fields) => (await business()).createAsin(fields),
            updateAsin: async (id, fields) =>
              (await business()).updateAsin(id, fields),
            moveAsin: async (id, target) =>
              (await business()).moveAsin(id, target),
            deleteGroup: async (id) => (await business()).deleteGroup(id),
            deleteAsin: async (id) => (await business()).deleteAsin(id),
            updateGroupNotify: async (id, enabled) =>
              (await business()).updateGroupNotify(id, enabled),
            updateAsinNotify: async (id, enabled) =>
              (await business()).updateAsinNotify(id, enabled),
          });
        },
        signal,
      );
    } catch (error) {
      if (duplicate(error)) throw new CompetitorWriteError('duplicate');
      throw error;
    }
  }
  close() {
    this.transactions.close();
  }
}
