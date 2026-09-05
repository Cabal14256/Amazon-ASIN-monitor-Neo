import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, TypeOverrides, type PoolClient, type PoolConfig } from 'pg';

const TIMESTAMP_WITHOUT_TIME_ZONE_OID = 1114;
const shanghaiTimestampPattern =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

/** D8：把 PostgreSQL 无时区时间按 Asia/Shanghai（UTC+8，无 DST）解释。 */
export function parseShanghaiTimestamp(value: string): Date {
  const match = shanghaiTimestampPattern.exec(value);
  if (!match) return new Date(value);
  return new Date(`${match[1]}T${match[2]}+08:00`);
}

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
