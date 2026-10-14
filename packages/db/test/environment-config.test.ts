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
    expect(compose).not.toContain('TIMESCALE_RETENTION_DAYS:');
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
    expect(compose).toContain(
      '- ./packages/db/docker/apply-timescale-aggregates.sh:/docker-entrypoint-initdb.d/030-apply-timescale-aggregates.sh:ro',
    );
    expect(compose).toContain(
      '- ./packages/db/migrations/0001_timescale_aggregates.sql:/opt/asin-monitor/0001_timescale_aggregates.sql:ro',
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
    expect(dbPackage.scripts['test:integration']).toContain(
      '@asin-monitor/contracts build',
    );
    expect(dbPackage.scripts['test:integration']).toContain(
      'data-migration.integration.test.ts',
    );
    expect(
      dbPackage.scripts['test:integration'].indexOf(
        'data-migration.integration.test.ts',
      ),
    ).toBeLessThan(
      dbPackage.scripts['test:integration'].indexOf(
        'storage-performance.integration.test.ts',
      ),
    );
    expect(rootPackage.scripts['db:migrate:data']).toContain(
      '@asin-monitor/db migrate:data',
    );
    expect(integrationTest).toContain('loadEnvironmentFiles();');
    expect(workflow).toContain(
      'pnpm --filter @asin-monitor/db test:integration',
    );
    expect(
      workflow.match(/sh \/tmp\/apply-baseline\.sh \/tmp\/0000_baseline\.sql/g),
    ).toHaveLength(2);
  });

  it('定时账本由显式命令升级且真实双库/MySQL测试不会在CI跳过', () => {
    const root = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };
    const compose = read('compose.neo.yml');
    const workflow = read('.github/workflows/integration.yml');
    for (const domain of ['primary', 'competitor']) {
      expect(root.scripts[`db:upgrade:scheduled-monitor:${domain}`]).toContain(
        `sh /opt/asin-monitor/apply-scheduled-monitor.sh ${domain}`,
      );
      expect(compose).toContain(
        `- ./packages/db/migrations/0016_scheduled_monitor_${domain}.sql:/opt/asin-monitor/0016_scheduled_monitor_${domain}.sql:ro`,
      );
      expect(compose).toContain(
        `- ./packages/db/migrations/0016_scheduled_monitor_${domain}.rollback.sql:/opt/asin-monitor/0016_scheduled_monitor_${domain}.rollback.sql:ro`,
      );
    }
    expect(compose).toContain(
      '- ./packages/db/docker/apply-scheduled-monitor.sh:/opt/asin-monitor/apply-scheduled-monitor.sh:ro',
    );
    expect(compose).not.toContain(
      '/docker-entrypoint-initdb.d/0016_scheduled_monitor',
    );
    expect(workflow).toContain("RUN_NEO_SCHEDULED_MONITOR_INTEGRATION: '1'");
    expect(workflow).toContain(
      'vitest run test/scheduled-monitor-schema.integration.test.ts test/scheduled-monitor-mysql.integration.test.ts test/scheduled-monitor-run.integration.test.ts --no-file-parallelism',
    );
  });
});
