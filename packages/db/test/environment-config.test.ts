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

  it('Compose 只向回环地址发布端口且不遮蔽镜像初始化目录', () => {
    const compose = read('compose.neo.yml');

    expect(compose).toContain("- '127.0.0.1:${NEO_POSTGRES_PORT:-5432}:5432'");
    expect(compose).toContain(
      '- ./packages/db/docker/init/010-bootstrap-databases.sh:/docker-entrypoint-initdb.d/010-bootstrap-databases.sh:ro',
    );
    expect(compose).toContain(
      '- ./packages/db/docker/apply-baseline.sh:/docker-entrypoint-initdb.d/020-apply-baseline.sh:ro',
    );
    expect(compose).toContain(
      '- ./packages/db/migrations/0000_baseline.sql:/opt/asin-monitor/0000_baseline.sql:ro',
    );
    expect(compose).not.toContain(
      '- ./packages/db/docker/init:/docker-entrypoint-initdb.d:ro',
    );
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
    const dbPackage = JSON.parse(read('packages/db/package.json')) as {
      scripts: Record<string, string>;
    };
    const integrationTest = read(
      'packages/db/test/environment.integration.test.ts',
    );
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
    expect(rootPackage.scripts['db:baseline']).toContain(
      '020-apply-baseline.sh',
    );
    const baselineScript = read('packages/db/docker/apply-baseline.sh');
    expect(baselineScript).toContain('validate_identifier');
    expect(baselineScript).toContain(
      'primary and competitor databases must be different',
    );
    expect(rootPackage.scripts['db:down']).toContain('compose.neo.yml');
    expect(dbPackage.scripts['test:integration']).toContain(
      '@asin-monitor/config build',
    );
    expect(integrationTest).toContain('loadEnvironmentFiles();');
    expect(workflow).toContain(
      'pnpm --filter @asin-monitor/db test:integration',
    );
    expect(
      workflow.match(/sh \/tmp\/apply-baseline\.sh \/tmp\/0000_baseline\.sql/g),
    ).toHaveLength(2);
  });
});
