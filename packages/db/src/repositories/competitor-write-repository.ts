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
import { duplicateCompetitorAsin } from './competitor-write-errors';
import { prepareCompetitorWrites } from './competitor-write-policy';
import { DrizzleCompetitorWriteUnit } from './competitor-write-unit';
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
            updateGroup: async (id, fields, expectedSource) =>
              (await business()).updateGroup(id, fields, expectedSource),
            createAsin: async (fields, expectedParent) =>
              (await business()).createAsin(fields, expectedParent),
            batchCreateAsins: async (items) =>
              (await business()).batchCreateAsins(items),
            updateAsin: async (id, fields, expectedSource) =>
              (await business()).updateAsin(id, fields, expectedSource),
            moveAsin: async (id, target, expectedSourceGroup) =>
              (await business()).moveAsin(id, target, expectedSourceGroup),
            deleteGroup: async (id, expectedChildIds, expectedSource) =>
              (await business()).deleteGroup(
                id,
                expectedChildIds,
                expectedSource,
              ),
            deleteAsin: async (id, expectedSource) =>
              (await business()).deleteAsin(id, expectedSource),
            updateGroupNotify: async (id, enabled) =>
              (await business()).updateGroupNotify(id, enabled),
            updateAsinNotify: async (id, enabled) =>
              (await business()).updateAsinNotify(id, enabled),
          });
        },
        signal,
      );
    } catch (error) {
      if (duplicateCompetitorAsin(error))
        throw new CompetitorWriteError('duplicate');
      throw error;
    }
  }
  close() {
    this.transactions.close();
  }
}
