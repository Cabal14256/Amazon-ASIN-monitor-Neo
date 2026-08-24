import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

/**
 * 按连接串创建 PG 连接池 + Drizzle 实例。
 * 主库与竞品库（决策 D6 双 database）各用一个池，调用方负责池生命周期。
 */
export function createPgPool(connectionString: string, config: PoolConfig = {}): Pool {
  return new Pool({
    connectionString,
    max: 10,
    ...config,
  });
}

export function createDb(pool: Pool): NodePgDatabase {
  return drizzle(pool);
}

export type Db = NodePgDatabase;
