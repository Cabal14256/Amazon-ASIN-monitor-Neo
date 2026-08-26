const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');
const read = (relativePath) =>
  fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
const normalizedHash = (relativePath) => {
  const normalized = read(relativePath)
    .replace(/\r\n/g, '\n')
    .replace(/\n$/, '');
  return crypto.createHash('sha256').update(normalized).digest('hex');
};
const checklistItems = (contents) => {
  const heading = '## 检查清单';
  const start = contents.indexOf(heading);
  assert.notEqual(start, -1, `缺少 ${heading}`);
  const section = contents.slice(start + heading.length);
  return [...section.matchAll(/^\s*-\s+\[[ xX]\]\s+(.+)$/gm)].map((match) =>
    match[1].trim(),
  );
};

const archivedDocuments = {
  'docs/refactor/Amazon-ASIN-monitor-重构方案.md':
    'cea2f0f0c90bb79781ce7600851e883120d6b7cd11fba318b5e895f8a2878502',
  'docs/refactor/Amazon-ASIN-monitor-重构总体计划.md':
    'd733f0ca9100385fb0cc4b43dd902f9f0ec3b5cf025dcf625f08edf21c15a1c8',
};

test('两份定稿重构文档按归档校验值原样保存', () => {
  for (const [relativePath, expectedHash] of Object.entries(
    archivedDocuments,
  )) {
    assert.equal(normalizedHash(relativePath), expectedHash, relativePath);
  }

  const archiveReadme = read('docs/refactor/README.md');
  for (const [relativePath, expectedHash] of Object.entries(
    archivedDocuments,
  )) {
    assert.match(archiveReadme, new RegExp(path.basename(relativePath)));
    assert.match(archiveReadme, new RegExp(expectedHash));
  }
  assert.match(archiveReadme, /不是可直接执行的仓库指令/);
});

test('AGENTS 固定双系统结构与 Monorepo 检查基线', () => {
  const agents = read('AGENTS.md');
  for (const workspacePath of [
    'src/',
    'server/',
    'apps/web',
    'apps/api',
    'apps/worker',
    'packages/contracts',
    'packages/db',
    'packages/config',
  ]) {
    assert.match(agents, new RegExp(workspacePath.replace('/', '\\/')));
  }

  for (const command of [
    'corepack pnpm test:contracts',
    'npm --prefix server run test:unit',
    'npm run build',
    'corepack pnpm --filter contracts test',
    'corepack pnpm --filter config test',
    'corepack pnpm --filter api test',
    'corepack pnpm --filter worker test',
    'corepack pnpm --filter web test',
    'corepack pnpm --filter web lint',
    'corepack pnpm --filter web build',
    'corepack pnpm build:api',
    'corepack pnpm build:worker',
    'corepack pnpm build:db',
    'corepack pnpm exec tsc --noEmit --pretty false',
    'npm run test:changed-format',
    'git diff --check',
  ]) {
    assert.ok(agents.includes(command), command);
  }
});

test('协作指南保留短分支、Draft、中文模板与双系统开发约定', () => {
  const contributing = read('CONTRIBUTING.md');
  assert.match(contributing, /短生命周期分支/);
  assert.match(contributing, /feat\|fix\|docs\|refactor\|test\|chore\|codex/);
  assert.match(contributing, /PR 默认先创建为 Draft/);
  assert.match(contributing, /中文章节/);
  assert.match(contributing, /旧系统冻结新增功能/);
  assert.match(contributing, /Neo Web.*3001/);
  assert.match(contributing, /dev:api.*3100/);
  assert.match(contributing, /dev:web.*5173/);
  assert.match(contributing, /npm --prefix server run test:unit/);
  assert.match(contributing, /npm run build/);
  assert.match(contributing, /corepack pnpm build:api/);
  assert.match(contributing, /corepack pnpm build:worker/);
  assert.match(contributing, /corepack pnpm build:db/);
  assert.match(contributing, /corepack pnpm --filter config test/);
  assert.match(contributing, /corepack pnpm --filter web test/);
  assert.match(contributing, /corepack pnpm --filter web lint/);
  assert.match(contributing, /npm run test:changed-format/);
});

test('AGENTS 与 GitHub PR 模板保持同一套九项 Ready 清单', () => {
  const agentsItems = checklistItems(read('AGENTS.md'));
  const templateItems = checklistItems(
    read('.github/pull_request_template.md'),
  );
  assert.equal(agentsItems.length, 9);
  assert.deepEqual(agentsItems, templateItems);
});

test('README 明确当前能力、双跑端口、开发命令与归档入口', () => {
  const readme = read('README.md');
  assert.match(readme, /Legacy（当前业务系统）/);
  assert.match(readme, /Neo（目标系统）/);
  assert.match(readme, /业务域尚未完成迁移，不能替代 Legacy 生产流量/);
  assert.match(readme, /localhost:3001/);
  assert.match(readme, /localhost:3100/);
  assert.match(readme, /localhost:5173/);
  assert.match(readme, /corepack pnpm dev:api/);
  assert.match(readme, /corepack pnpm dev:worker/);
  assert.match(readme, /corepack pnpm dev:web/);
  assert.match(readme, /docs\/refactor\/README\.md/);
  assert.match(readme, /nginx\.refactor\.conf\.example/);
});

test('仅放行受版本控制的重构归档并固定双跑代理路径', () => {
  const gitignore = read('.gitignore');
  assert.match(gitignore, /^\/docs\/\*$/m);
  assert.match(gitignore, /^!\/docs\/refactor\/$/m);
  assert.match(gitignore, /^!\/docs\/refactor\/\*\*$/m);

  const nginx = read('nginx.refactor.conf.example');
  const apiLocation = nginx.match(/location \/api \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(apiLocation, '缺少 Legacy /api location');
  assert.match(apiLocation, /proxy_pass http:\/\/127\.0\.0\.1:3001;/);
  assert.match(apiLocation, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(apiLocation, /proxy_cache_bypass \$http_upgrade;/);
  assert.match(apiLocation, /proxy_connect_timeout 1200s;/);
  assert.match(apiLocation, /proxy_send_timeout 1200s;/);
  assert.match(apiLocation, /proxy_read_timeout 1200s;/);

  const wsLocation = nginx.match(/location \/ws \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(wsLocation, '缺少 Legacy /ws location');
  assert.match(wsLocation, /proxy_set_header X-Real-IP \$remote_addr;/);
  assert.match(wsLocation, /proxy_set_header X-Forwarded-Proto \$scheme;/);
  assert.match(wsLocation, /proxy_cache_bypass \$http_upgrade;/);
  assert.match(wsLocation, /proxy_connect_timeout 7d;/);
  assert.match(wsLocation, /proxy_send_timeout 7d;/);
  assert.match(wsLocation, /proxy_read_timeout 7d;/);

  const neoLocation = nginx.match(/location \/neo-api\/ \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(neoLocation, '缺少 Neo /neo-api/ location');
  assert.match(neoLocation, /rewrite \^\/neo-api\/\(\.\*\)\$ \/\$1 break;/);
  assert.match(neoLocation, /proxy_pass http:\/\/127\.0\.0\.1:3100;/);
  assert.doesNotMatch(nginx, /proxy_pass\s+http:\/\/127\.0\.0\.1:3001\/api/);
  assert.doesNotMatch(
    nginx,
    /proxy_pass\s+http:\/\/127\.0\.0\.1:3100\/(?:neo-api|api)/,
  );
});

test('根脚本包含治理文档回归与数据库构建入口', () => {
  const rootPackage = JSON.parse(read('package.json'));
  assert.match(rootPackage.scripts['test:contracts'], /test:refactor-docs/);
  assert.equal(
    rootPackage.scripts['test:refactor-docs'],
    'node --test tests/refactor-docs.test.js',
  );
  assert.equal(
    rootPackage.scripts['build:db'],
    'corepack pnpm --filter @asin-monitor/db build',
  );
});
