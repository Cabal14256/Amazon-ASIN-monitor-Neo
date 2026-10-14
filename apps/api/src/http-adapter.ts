import type { Env } from '@asin-monitor/config';
import { FastifyAdapter } from '@nestjs/platform-fastify';

/** Bounded before controllers; accommodates 1000 maximum-width Unicode rows. */
export const JSON_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

export function createHttpAdapter(env: Pick<Env, 'TRUST_PROXY'>) {
  return new FastifyAdapter({
    logger: false,
    bodyLimit: JSON_BODY_LIMIT_BYTES,
    ...(env.TRUST_PROXY === undefined ? {} : { trustProxy: env.TRUST_PROXY }),
  });
}
