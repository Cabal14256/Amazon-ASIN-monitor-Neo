import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const workspaceRoot = resolve(__dirname, '../../..');
const read = (relativePath: string) =>
  readFileSync(resolve(workspaceRoot, relativePath), 'utf8');
const timescaleImage = 'timescale/timescaledb:2.29.2-pg16';

describe('TimescaleDB 环境配置', () => {
  it('Compose 与 Integration 固定同一个 PG16 镜像', () => {
    const compose = read('compose.neo.yml');
    const workflow = read('.github/workflows/integration.yml');

    expect(compose).toContain(
      `image: \${TIMESCALEDB_IMAGE:-${timescaleImage}}`,
    );
    expect(workflow).toContain(`image: ${timescaleImage}`);
    expect(compose).not.toContain('latest-pg16');
    expect(workflow).not.toContain('latest-pg16');
  });

  it('bootstrap 幂等创建竞品库并在双库安装 TimescaleDB', () => {
    const script = read('packages/db/docker/init/010-bootstrap-databases.sh');

    expect(script).toContain('COMPETITOR_DATABASE');
    expect(script).toContain("format('CREATE DATABASE %I'");
    expect(script).toContain('WHERE NOT EXISTS');
    expect(script).toContain(
      'for database in "$primary_database" "$competitor_database"',
    );
    expect(script).toContain('CREATE EXTENSION IF NOT EXISTS timescaledb;');
  });

  it('示例环境、根命令与 CI smoke test 使用同一双库约定', () => {
    const env = read('.env.neo.example');
    const rootPackage = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };
    const workflow = read('.github/workflows/integration.yml');

    expect(env).toContain('NEO_POSTGRES_DATABASE=amazon_asin_monitor');
    expect(env).toContain('NEO_COMPETITOR_DATABASE=amazon_competitor_monitor');
    expect(env).toContain(
      'DATABASE_URL=postgresql://postgres:neo_dev_only@127.0.0.1:5432/amazon_asin_monitor',
    );
    expect(env).toContain(
      'COMPETITOR_DATABASE_URL=postgresql://postgres:neo_dev_only@127.0.0.1:5432/amazon_competitor_monitor',
    );
    expect(rootPackage.scripts['db:up']).toContain('compose.neo.yml');
    expect(rootPackage.scripts['db:down']).toContain('compose.neo.yml');
    expect(workflow).toContain(
      'pnpm --filter @asin-monitor/db test:integration',
    );
  });
});
