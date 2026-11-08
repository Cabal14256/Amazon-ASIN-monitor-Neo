import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

/** Execute the actual Legacy controller. Only persistence/queue/upstream ports
 * are synthetic; this proves HTTP/default/order semantics, not Legacy SQL. */
export async function legacyCompetitorBatch(
  body: Record<string, unknown>,
  check: (id: string, forceRefresh: boolean) => Promise<unknown>,
  query: Record<string, unknown> = {},
) {
  let statusCode = 200;
  let response: unknown;
  const submitted: unknown[] = [];
  const enqueued: unknown[] = [];
  const exports: Record<string, (req: unknown, res: unknown) => Promise<void>> =
    {};
  const require = (name: string): unknown => {
    if (name === '../services/competitorVariantCheckService')
      return { checkCompetitorVariantGroup: check };
    if (name === '../utils/logger')
      return { info() {}, warn() {}, error() {}, debug() {} };
    if (name === 'uuid')
      return { v4: () => '10000000-0000-4000-8000-000000000251' };
    if (name === '../services/batchCheckTaskQueue')
      return {
        enqueue: async (value: unknown) => {
          enqueued.push(value);
        },
      };
    if (name === '../services/taskRegistryService')
      return {
        createTask: async (value: unknown) => {
          submitted.push(value);
        },
      };
    throw new Error('Unexpected Legacy competitor batch fixture dependency');
  };
  runInNewContext(
    readFileSync(
      resolve(
        __dirname,
        '../../../../server/src/controllers/competitorVariantCheckController.js',
      ),
      'utf8',
    ),
    { exports, require, process: { env: {} } },
    { timeout: 1000 },
  );
  const reply = {
    status(code: number) {
      statusCode = code;
      return reply;
    },
    json(value: unknown) {
      response = value;
      return reply;
    },
  };
  await exports.batchCheckCompetitorVariantGroups(
    { body, query, user: { userId: 'legacy-competitor-owner' } },
    reply,
  );
  return {
    statusCode,
    response: JSON.parse(JSON.stringify(response)) as { data: unknown },
    submitted,
    enqueued,
  };
}
