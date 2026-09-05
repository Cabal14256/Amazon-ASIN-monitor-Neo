import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, TypeOverrides, type PoolClient, type PoolConfig } from 'pg';
import { parseShanghaiTimestamp } from './timestamps';

export { parseShanghaiTimestamp } from './timestamps';

const TIMESTAMP_WITHOUT_TIME_ZONE_OID = 1114;

export function createShanghaiTimestampTypeOverrides(
  inherited?: PoolConfig['types'],
): TypeOverrides {
  const typeOverrides = new TypeOverrides(inherited);
  typeOverrides.setTypeParser(
    TIMESTAMP_WITHOUT_TIME_ZONE_OID,
    'text',
    parseShanghaiTimestamp,
  );
  return typeOverrides;
}

/**
 * 按连接串创建 PG 连接池 + Drizzle 实例。
 * 主库与竞品库（决策 D6 双 database）各用一个池，调用方负责池生命周期。
 */
export function createPgPool(
  connectionString: string,
  config: PoolConfig = {},
): Pool {
  return new Pool({
    connectionString,
    max: 10,
    ...config,
  });
}

export function createDb(pool: Pool | PoolClient): NodePgDatabase {
  return drizzle(pool);
}

export type Db = NodePgDatabase;
