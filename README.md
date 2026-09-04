# Amazon ASIN Monitor

面向 Amazon 商品运营的全栈 ASIN 监控平台。系统围绕变体关系检查、定时监控、竞品监控、异常通知和历史分析构建，并提供用户权限、任务队列、审计日志与运维观测能力。

> 2026-07-15 之前的 README 已原样存档为 [`README.archive-2026-07-15.md`](./README.archive-2026-07-15.md)。存档仅用于追溯，当前安装与部署请以本文和代码中的示例配置为准。

## 重构状态：双系统并行

项目正按“方案 B + PostgreSQL 16/TimescaleDB”的定稿路线原地重构，避免一次性切换造成业务中断：

- **Legacy（当前业务系统）**：根 `src/` 的 Umi 前端与 `server/` 的 Express/MySQL/Bull 后端，继续承担完整业务流量；重构期冻结新增功能，只接受必要 bugfix。
- **Neo（目标系统）**：`apps/web`、`apps/api`、`apps/worker` 与 `packages/*`。目前已建立可构建骨架和共享契约，但业务域尚未完成迁移，不能替代 Legacy 生产流量。
- 两套系统持续通过短生命周期 PR 合入 `main`。每个阶段完成契约/数据/任务/页面对拍并达到出口 gate 后，才切换对应流量和删除旧路径。

定稿方案与逐阶段任务已归档在 [`docs/refactor/`](./docs/refactor/README.md)。

## 功能概览

- **ASIN 与变体组管理**：创建、编辑、移动、批量删除以及 Excel 导入/导出。
- **多站点监控**：支持 US、UK、DE、FR、IT、ES，并按 US/EU 区域配置 SP-API。
- **监控任务**：手动检查、定时检查、批量检查、父 ASIN 查询和执行进度跟踪。
- **竞品监控**：独立维护竞品 ASIN、变体组和监控历史，可使用独立数据库。
- **历史与分析**：监控记录、异常时长、趋势与多维聚合分析，并支持报表导出。
- **告警通知**：按 US/EU 区域配置飞书 Webhook，在异常场景下发送通知。
- **任务中心**：基于 Redis 与 Bull 执行导入、导出、备份、批量删除和变体检查等后台任务。
- **账号与安全**：JWT 认证、角色权限、会话管理、密码策略和操作审计。
- **运维能力**：健康检查、Prometheus 指标、WebSocket 实时进度、日志脱敏和备份恢复。

## 当前生产技术栈（Legacy）

| 层级     | 主要技术                                               |
| -------- | ------------------------------------------------------ |
| 前端     | React 18、TypeScript、Umi Max 4、Ant Design 5、ECharts |
| 后端     | Node.js、Express、WebSocket (`ws`)、`node-cron`        |
| 数据     | MySQL 8.0+、Redis、Bull                                |
| 外部服务 | Amazon Selling Partner API、飞书 Webhook               |
| 运维     | Nginx、Prometheus 指标、API/Worker 分角色部署          |

目标 Neo 技术栈为 React 19 + Vite 6 + TanStack + Tailwind/shadcn、NestJS 11 + Fastify、BullMQ、Drizzle、PostgreSQL 16 + TimescaleDB；Redis 继续承担队列、限流、缓存与实时协调。

## 运行结构

```mermaid
flowchart LR
  LegacyWeb[Legacy Umi :8000] --> LegacyAPI[Express :3001]
  NeoWeb[Neo Vite :5173] -->|双跑期 /api 与 /ws| LegacyAPI
  Nginx[Nginx] -->|/api 与 /ws| LegacyAPI
  Nginx -->|/neo-api 验证入口| NeoAPI[Nest :3100]
  LegacyAPI --> MySQL[(MySQL)]
  LegacyAPI --> Redis[(Redis / Bull)]
  NeoAPI --> PG[(PostgreSQL / TimescaleDB)]
  NeoAPI --> RedisNeo[(Redis / BullMQ)]
  NeoWorker[Neo Worker] --> RedisNeo
  NeoWorker --> PG
```

Legacy 开发环境可以用一个 `all` 进程同时承载 API、调度器和队列消费者；生产环境建议拆分 API 与 Worker，并保证同一套环境只有一个调度器实例。Neo API 和 Worker 从设计起就是独立进程。

## 快速开始

### 1. 准备依赖

建议准备以下环境：

- Node.js 20.19+ 与 Corepack/pnpm（TanStack Router 的最低引擎要求）
- MySQL 8.0+（分析查询使用了 CTE 和窗口函数）
- Redis 5.0+ 或兼容服务
- 可用的 Amazon SP-API 凭据（实际执行监控时需要）

### 2. 安装依赖

在项目根目录执行：

```bash
corepack enable
corepack pnpm install --frozen-lockfile
```

根目录的单一 `pnpm-lock.yaml` 同时锁定旧前端、旧后端与新 Monorepo 包；本地和自动化环境都应从仓库根执行一次上述冻结安装，不再分别运行 `npm install` / `npm ci`。

### 3. 创建环境配置

macOS / Linux：

```bash
cp .env.example .env
cp server/.env.example server/.env
cp .env.neo.example .env.neo
cp .env.migration.example .env.migration
```

PowerShell：

```powershell
Copy-Item .env.example .env
Copy-Item server/.env.example server/.env
Copy-Item .env.neo.example .env.neo
Copy-Item .env.migration.example .env.migration
```

前端默认使用同源 `/api`，通常无需修改根目录 `.env`。后端启动前至少需要正确配置：

| 变量                      | 用途                                             |
| ------------------------- | ------------------------------------------------ |
| `DB_HOST` / `DB_PORT`     | 主数据库地址                                     |
| `DB_USER` / `DB_PASSWORD` | 主数据库账号                                     |
| `DB_NAME`                 | 主数据库名，默认示例为 `amazon_asin_monitor`     |
| `JWT_SECRET`              | 登录令牌签名密钥；生产环境必须替换示例值         |
| `REDIS_URL`               | Bull 队列、任务状态和分布式限流使用的 Redis 地址 |
| `CORS_ORIGIN`             | 非同源部署时允许访问 API 的前端地址              |

完整配置和默认值见 [`server/.env.example`](./server/.env.example)。SP-API 凭据既可以写入环境变量，也可以在管理员登录后通过“系统设置”维护；数据库中的配置优先。

新 Nest API 与 BullMQ Worker 读取根目录 `.env.neo`，不会继承旧 Express 的 `PORT=3001`；模板固定 Neo API 默认端口 3100，并包含目标 PostgreSQL 主库、竞品库、Redis 与 JWT 必需变量。Neo 鉴权继续使用 `JWT_SECRET`，并可通过 `JWT_EXPIRES_IN`、`JWT_REMEMBER_EXPIRES_IN`、`AUTH_COOKIE_NAME`、`AUTH_HINT_COOKIE_NAME` 和 `AUTH_PERMISSION_CACHE_TTL_SECONDS` 调整令牌、Cookie 与 RBAC 缓存；生产环境的 JWT 密钥至少需要 32 个字符且不得保留公开模板值。`AUTH_DATA_AUTHORITY` 必须明确选择全部鉴权数据的权威源：双跑期使用 `legacy-mysql` 并在 `.env.neo` 提供与 Legacy 相同的 `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`，使用户状态、Session、密码策略、权限和角色变更实时生效；只有完成最终同步并冻结 MySQL 写入后才改为 `postgresql`。旧系统继续读取 `server/.env`，因此两套 API 可以并行启动。

Neo HTTP API 默认通过共享 Redis 执行 15 分钟 fixed-window 限流：ADMIN 1000、EDITOR 500、READONLY/匿名或未知角色 100 次；后续敏感端点可显式使用 strict 20 次策略。请求层先按 DEFAULT 预占配额，因此无效凭据和未匹配的 `/api/v1/*` 同样受限；预占会保持到角色计数已落定，只有 Session Guard 成功后才转为已认证角色配额，撤销或过期会话不会获得高配额。认证 strict 请求会继续持有 DEFAULT 预占，并由同一条 Redis 原子脚本完成附加桶预占与成功后的条件释放；strict 拒绝时该预占保留，使重复流量随后在 Guard 前被阻断。若原子转移因 Redis 失联而改用已放行的 strict 内存预占，或 DEFAULT 写入已经执行但响应超时，恢复对账都会保留可重试的来源释放意图，等来源与目标快照全部落库后再释放 DEFAULT，避免槽位泄漏或释放后被迟到快照重新写回。

`API_RATE_LIMIT_ENABLED=false` 可在受控排障窗口关闭，`RATE_LIMIT_WHITELIST_IPS` 接受逗号分隔的精确 IP，`RATE_LIMITER_KEY_PREFIX` 用于隔离共享 Redis 的不同部署。Redis 不可用时会有界降级到进程内窗口；满载后新客户端进入每策略 overflow 桶，不淘汰活跃计数。共享窗口以 Redis `TIME` 为权威时钟，避免不同 API 实例的系统时钟偏差重置 generation；所有读时钟后写数据的 Lua 都先显式启用 effects replication，以兼容 Redis 5/6 的复制配置与 Redis 7 的唯一复制模式。每次请求以随机 ID 幂等计数。overflow 按 request ID 记录客户端归属，并在 Redis 成员表内维护每个客户端的活动预占数；释放最后一条预占就原子移除该成员。恢复后仍处于 overflow 的客户端同时执行故障前独立 Redis 计数与共享桶总数，既不会取得一份新配额，也不会让未进入 overflow 的客户端承受聚合总数；不确定的 Redis 响应若实际已写入 overflow，对账也会在候选 overflow 桶内按 owner 与 request ID 去重，不再重复写入独立窗口。

恢复实例会冻结当前内存快照并将其对账到 Redis，快照生成后的新请求直接使用 Redis，因此持续流量不要求静默期；属于冻结独立窗口或 overflow 成员的请求只等待自身窗口落库，其他新流量不受后续批次阻塞，角色转移则等待整轮恢复完成。能力探针取得的 Redis generation 会成为整轮对账锚点：实例本地时钟落后时，仍会将锚定窗口内的幂等 request ID 保守合并到 Redis 当前代并允许后续释放/转移；内存降级同时保留当前代与紧邻上一代的 request ID，防止主机在 Redis 活动窗口中途跨过本地边界时提前丢弃仍有效的预占，更早的代际会被有界淘汰。若多批对账期间 Redis 已跨入下一代，剩余旧快照不会被带入新窗口。对账期间 readiness 保持 degraded，完整成功后才恢复共享后端；对账中断会暂时 fail-closed，并把竞态中虽成功返回的 Redis 消费转换为不确定内存决策，避免部分写入或 Redis 响应不确定时误放行，下一次完整对账成功后自动解除。半开探测只允许一个请求访问 Redis；由业务流量触发时，触发请求立即沿用已有内存决策，整批对账在后台完成，不会因最多 10000 个窗口而阻塞请求。

readiness 在启动及恢复时验证 fixed-window、对账与释放所需的全部 Redis 命令，成功后才报告共享后端可用。健康请求同样只触发或复用后台恢复并立即按当前状态返回。`/health.rateLimiter`、顶层 readiness 状态与 Prometheus 指标会标记实际后端。反向代理部署只有在代理链可信且正确限制来源时才配置 `TRUST_PROXY`；单层 Nginx 使用 `TRUST_PROXY=1`（一个 hop），不要使用 trust-all 的 `true`，否则客户端伪造的转发地址可能绕过限流或命中白名单。

### 4. 初始化数据库

全新安装执行以下脚本：

```bash
mysql -u root -p < server/database/init.sql
mysql -u root -p < server/database/competitor-init.sql
```

`init.sql` 已包含自动备份使用的 `backup_config` 表及默认关闭的配置，新装无需额外执行 `019`。第二条命令创建固定的独立竞品数据库；只有明确关闭竞品监控时才可跳过。旧库升级到自动备份功能时，仍应按实际 schema 判断是否执行 `server/database/migrations/019_add_backup_config_table.sql`。

已有数据库升级前必须先备份，再根据 [`server/database/MIGRATION.md`](./server/database/MIGRATION.md) 选择并执行迁移；不要用全新初始化流程替代升级流程。

### 5. 创建管理员

管理员用户名固定为 `admin`。初始化密码必须满足密码策略，且首次登录后会被要求修改。

macOS / Linux：

```bash
cd server
INIT_ADMIN_PASSWORD='ChangeMe_2026_Strong!' node init-admin-user.js
cd ..
```

PowerShell：

```powershell
Set-Location server
$env:INIT_ADMIN_PASSWORD = 'ChangeMe_2026_Strong!'
node init-admin-user.js
Remove-Item Env:INIT_ADMIN_PASSWORD
Set-Location ..
```

不要将初始化密码写入 `.env`、脚本、日志或版本库。

### 6. 启动开发环境

#### Legacy 完整业务系统

打开两个终端，在项目根目录分别运行：

```bash
# 终端 1：后端，默认 http://localhost:3001
npm --prefix server run dev
```

```bash
# 终端 2：前端，默认 http://localhost:8000
npm run dev
```

Umi 开发服务器会把 `/api` 代理到 `http://localhost:3001`，WebSocket 在开发环境也会直连该端口。

#### Neo 并行骨架

先按 `.env.neo.example` 创建 `.env.neo`。仓库用固定的 `timescale/timescaledb:2.29.2-pg16` 镜像初始化主营/竞品两个 database，在两库启用 TimescaleDB，并为空数据卷依次执行 PG 21 + 4 表 baseline、持续聚合升级、索引/columnstore 策略升级；raw retention 默认关闭。数据库端口默认只绑定 `127.0.0.1`，Redis 仍需单独准备。

```bash
corepack pnpm db:up
corepack pnpm db:status
```

已有数据卷不会重复运行镜像初始化目录；已有的空 Neo 双库可显式、幂等地应用当前 baseline。数据库健康后执行真实结构 smoke test：

```bash
corepack pnpm db:baseline
corepack pnpm db:upgrade:timescale
corepack pnpm db:upgrade:timescale-storage
corepack pnpm --filter db test:integration
```

`corepack pnpm db:down` 会停止容器但保留命名卷。只有在确认可以丢弃本地 Neo 数据时，才运行 `docker compose --env-file .env.neo -f compose.neo.yml down --volumes`；该操作不可从数据库恢复。没有 Docker 时，可将 `.env.neo` 的两条 PG URL 指向外部 PostgreSQL 16 + TimescaleDB 实例。执行、类型翻译、排序规则和回滚约定见 [`packages/db/MIGRATION.md`](./packages/db/MIGRATION.md)。

MySQL 8 → PG16 的双库数据演练使用 `.env.migration`，会重置两个 PG 目标库，且只有 `MIGRATION_ALLOW_TARGET_RESET=true` 时才执行。运行前必须备份并确认目标可被清空：

```bash
corepack pnpm db:migrate:data
```

迁移采用主键 keyset 批次，自动对拍 25 张表的行数、确定性字段样本和 7 组关键业务查询，报告默认写入被 Git 忽略的 `artifacts/data-migration/report.json`。完整的写冻结、预演、失败恢复和回切步骤见 [`packages/db/DATA_MIGRATION.md`](./packages/db/DATA_MIGRATION.md)。

Timescale 索引与存储 Gate 会在显式声明的 `_ci` 一次性数据库中写入 72 万次确定性高频监控 fixture，并生成脱敏的 `artifacts/timescale-performance/integration-report.json`：验证 7 个原始历史索引的真实执行计划、先转入 columnstore 的 9 个 CAGG 在 asin/dim/variant_group 三个家族、不重叠且可审计的冷热窗口/筛选/hour-day-month 共 36 组查询下与 raw 结果一致且 P95 至少快 3 倍，以及 columnstore 晚到写入和 10 批共 2500 行持续写入期间的分析读取 P95 低于 2 秒。索引取舍见 [`packages/db/INDEX_REVIEW.md`](./packages/db/INDEX_REVIEW.md)，上线与回滚见 [`docs/runbooks/phase-1-timescale-storage.md`](./docs/runbooks/phase-1-timescale-storage.md)。

再打开三个终端，从仓库根分别运行：

```bash
corepack pnpm dev:api
```

```bash
corepack pnpm dev:worker
```

```bash
corepack pnpm dev:web
```

Neo API 默认监听 `http://localhost:3100`，Neo Web 默认监听 `http://localhost:5173`。双跑期 Neo Web 仍将 `/api` 与 `/ws` 代理到 Legacy 3001；可直接访问 `http://localhost:3100/health` 验证 Neo API 骨架。生产式并行验证可参考 [`nginx.refactor.conf.example`](./nginx.refactor.conf.example)，其中 `/neo-api/` 独立指向 3100，不会提前接管旧 `/api/v1`。

### 7. 基础检查

```bash
# 数据库连接
npm --prefix server run test-db

# Redis 与 Bull 队列
npm run check-redis

# 后端健康状态
curl http://localhost:3001/health
```

最后访问 `http://localhost:8000`，使用 `admin` 和初始化密码登录。

## 核心配置

### SP-API

系统把站点映射到两个凭据区域：

| 区域 | 站点               | 环境变量前缀  |
| ---- | ------------------ | ------------- |
| US   | US                 | `SP_API_US_*` |
| EU   | UK、DE、FR、IT、ES | `SP_API_EU_*` |

区域配置缺失时会回退到全局 `SP_API_*`。如启用 `SP_API_USE_AWS_SIGNATURE=true`，还必须配置 Access Key、Secret Access Key 和 Role ARN。HTML 抓取及旧客户端兜底默认关闭，启用前应评估稳定性与合规风险。

SP-API usage plan 按 operation 和账号等因素确定，本地 `SP_API_RATE_LIMIT_*` 只是区域保护上限。负载分析只估算定时任务，实时状态依赖 API/Worker 共用 Redis；不要把本地上限设置得高于账号的实际配额。相关工具见：

```bash
npm --prefix server run analyze-quota
npm --prefix server run monitor-quota
```

### 进程角色与队列

| `PROCESS_ROLE` | HTTP API | Scheduler | 队列消费者 | 适用场景 |
| --- | --- | --- | --- | --- |
| `all` | 是 | 由 `SCHEDULER_ENABLED` 控制 | 是 | 本地开发、单进程部署 |
| `api` | 是 | 由 `SCHEDULER_ENABLED` 控制 | 否 | 生产 API 实例 |
| `worker` | 否 | 否 | 是 | 生产队列消费者 |

`WORKER_ENABLED_QUEUES` 可限制 Worker 注册的队列，留空或设为 `all` 时注册全部队列。可选队列及并发参数以 [`server/.env.example`](./server/.env.example) 为准。

生产环境需要注意：

- 所有 API 与 Worker 必须连接同一套 MySQL 和 Redis。
- 同一环境只保留一个 `SCHEDULER_ENABLED=true` 的 API 实例，避免重复生成定时任务。
- 多套环境共用 Redis 时，为 `BULL_PREFIX` 和 `RATE_LIMITER_KEY_PREFIX` 设置不同前缀。
- API 与 Worker 分布在不同主机时，共享或持久化 `server/tasks` 与 `server/backups`，否则任务下载和备份恢复可能找不到文件。
- 优先增加 Worker 实例数，再小幅提高单实例并发，并持续观察 SP-API 429、数据库连接池与 Redis 负载。

### API 地址规则

业务接口统一使用 `/api/v1` 前缀。前端请求层和导出层都会规范化 `API_BASE_URL`，但部署配置仍应遵循以下规则：

- 推荐同源配置：`API_BASE_URL=/api`。
- 跨域配置可填写站点源地址或带 `/api` 的地址，例如 `https://api.example.com` 或 `https://api.example.com/api`。
- 跨 origin 部署还必须正确设置后端 `CORS_ORIGIN`。当前会话 Cookie 使用 `SameSite=Lax`，适合 HTTPS 下的同站点子域；跨站点部署需要另行设计 `SameSite=None; Secure` 与 CSRF 防护，不能只修改 URL。
- 基础地址末尾不要保留 `/`。
- 请求路径已经包含 `/api/v1`，不要再次手工拼接 `/api`。
- Nginx 应保留原始请求路径，`proxy_pass` 不要再附加 `/api` 或 `/api/v1`。

正确结果应始终类似：

```text
/api/v1/health
/api/v1/export/asin
```

不应出现：

```text
/api/api/v1/health
/api/v1/v1/export/asin
```

仓库中的 [`nginx.conf.example`](./nginx.conf.example) 已按此规则配置。

### 日志

后端统一通过 `server/src/utils/logger.js` 记录日志：

- `DEBUG`：SQL、缓存命中和流程追踪等诊断信息。
- `INFO`：启动、调度、任务完成等正常业务事件。
- `WARN`：限流、重试、降级和可恢复问题。
- `ERROR`：异常、外部接口失败等需要处理的问题。

生产环境建议 `LOG_LEVEL=INFO`，并保持 `LOG_SANITIZE=true`。不要记录密码、Token、Authorization 头、Webhook 或完整外部响应载荷。

## 生产部署

### 构建前端

```bash
npm run build
```

构建产物位于 `dist/`。Nginx 需要同时完成：

- 托管 `dist/` 并为 SPA 配置 `try_files ... /index.html`。
- 将 `/api` 原样转发到后端端口。
- 将 `/ws` 以 WebSocket 升级连接转发到后端。
- 将上传大小和长请求超时设置为与后端任务相匹配的值。
- 单层 Nginx 反代时设置 `TRUST_PROXY=1`，确保限流与审计使用正确的客户端地址。

可直接以 [`nginx.conf.example`](./nginx.conf.example) 为起点，并按实际域名、证书、静态目录和端口调整。

### 启动后端

单进程模式：

```bash
cd server
npm start
```

Linux / macOS 上的拆分模式：

```bash
cd server
npm run start:api
```

```bash
cd server
npm run start:worker
```

Windows 部署请在进程管理器中设置 `PROCESS_ROLE` 后直接运行对应入口；`start:api` 和 `start:worker` 脚本使用 POSIX 环境变量语法。

生产环境应使用 PM2、systemd、容器编排或面板进程守护，并通过 HTTPS 对外提供服务。建议先启动 Worker，再启动 API。

## 运维端点

| 地址                 | 说明                              |
| -------------------- | --------------------------------- |
| `GET /health`        | 综合健康检查；降级时返回 HTTP 503 |
| `GET /api/v1/health` | 带 API 前缀的同一健康检查         |
| `GET /metrics`       | Prometheus 文本指标               |
| `/ws`                | 任务和监控进度的 WebSocket 通道   |

`/metrics` 默认由应用直接暴露。公网部署时应通过防火墙、Nginx allowlist 或独立内网入口限制访问。

数据分析聚合表可手动回填：

```bash
npm --prefix server run rebuild:agg
```

执行前先确认数据库负载和 `ANALYTICS_AGG_*` 回填窗口配置。

## 常用命令

### 项目根目录

| 命令                                 | 说明                         |
| ------------------------------------ | ---------------------------- |
| `npm run dev`                        | 启动前端开发服务器           |
| `npm run build`                      | 构建前端到 `dist/`           |
| `npm run format`                     | 使用 Prettier 格式化项目文件 |
| `npm run check-redis`                | 检查 Redis 与 Bull 队列连接  |
| `npm run bench:analytics -- --help`  | 查看数据分析基准脚本参数     |
| `node scripts/test-env.js`           | 检查后端环境变量             |
| `node scripts/test-build.js --build` | 执行并检查完整前端构建       |

### Neo Monorepo（从项目根执行）

| 命令 | 说明 |
| --- | --- |
| `corepack pnpm dev:api` | 启动 Nest/Fastify API（3100） |
| `corepack pnpm dev:worker` | 启动 BullMQ Worker |
| `corepack pnpm dev:web` | 启动 Vite Web（5173） |
| `corepack pnpm db:up` | 启动本地 PG16/TimescaleDB |
| `corepack pnpm db:baseline` | 为已有空双库幂等应用 PG baseline |
| `corepack pnpm db:upgrade:timescale` | 创建/复核 hypertable、9 个 CAGG 与刷新策略 |
| `corepack pnpm db:upgrade:timescale-storage` | 收敛索引并配置 columnstore；retention 默认关闭 |
| `corepack pnpm db:migrate:data` | 重置 PG 目标后迁移 MySQL 双库并生成对拍报告 |
| `corepack pnpm db:status` | 查看本地数据库健康状态 |
| `corepack pnpm db:logs` | 跟踪本地数据库日志 |
| `corepack pnpm db:down` | 停止数据库并保留命名卷 |
| `corepack pnpm --filter db test` | 运行数据库环境静态测试 |
| `corepack pnpm --filter db test:integration` | 连接双库执行真实 smoke test |
| `corepack pnpm --filter contracts test` | 运行共享 REST/WS 契约测试 |
| `corepack pnpm --filter config test` | 验证 Neo 环境模板与配置解析 |
| `corepack pnpm --filter api test` | 运行 Neo API 测试 |
| `corepack pnpm --filter worker test` | 运行 Neo Worker 测试 |
| `corepack pnpm --filter web test` | 运行 Neo Web 测试 |
| `corepack pnpm --filter web lint` | 检查 Neo Web ESLint |
| `corepack pnpm --filter web build` | 构建 Neo Web |
| `corepack pnpm build:api` | 先构建依赖包，再构建 Neo API |
| `corepack pnpm build:worker` | 先构建依赖包，再构建 Neo Worker |
| `corepack pnpm build:db` | 构建 Drizzle 数据库包 |
| `corepack pnpm test:contracts` | 运行过渡期 Legacy/docs 契约基线 |
| `npm run test:changed-format` | 验证差异格式检查器 |

### `server/` 目录

| 命令                           | 说明                                   |
| ------------------------------ | -------------------------------------- |
| `npm run dev`                  | 使用 nodemon 启动后端                  |
| `npm start`                    | 启动后端入口，角色取自 `.env`          |
| `npm run start:api`            | 仅启动 API 角色（POSIX）               |
| `npm run start:worker`         | 仅启动 Worker 角色（POSIX）            |
| `npm run test-db`              | 测试主数据库连接                       |
| `npm run test:all`             | 运行后端集成检查；需要已配置的依赖服务 |
| `npm run test:task-regression` | 运行后台任务回归检查                   |

## 项目结构

```text
Amazon-ASIN-monitor-Neo/
├─ apps/
│  ├─ api/                      # Neo NestJS/Fastify API（3100）
│  ├─ worker/                   # Neo BullMQ Worker
│  └─ web/                      # Neo React/Vite 前端（5173）
├─ packages/
│  ├─ config/                   # 共享环境变量校验
│  ├─ contracts/                # REST/WS Zod 契约与权限常量
│  └─ db/                       # Drizzle + PostgreSQL/TimescaleDB
├─ docs/refactor/               # 重构方案与总体计划归档
├─ compose.neo.yml              # Neo PG16/TimescaleDB 本地编排
├─ src/                         # Legacy React/Umi 前端
│  ├─ pages/                    # 页面
│  ├─ components/               # 公共组件
│  ├─ services/                 # API 与 WebSocket 客户端
│  └─ utils/                    # 导出、任务、鉴权等工具
├─ server/                      # Legacy Express/MySQL/Bull 后端
│  ├─ src/
│  │  ├─ controllers/           # HTTP 控制器
│  │  ├─ routes/                # /api/v1 路由
│  │  ├─ models/                # 数据访问
│  │  ├─ services/              # 监控、调度、队列与外部服务
│  │  ├─ workers/               # CPU/IO Worker 线程任务
│  │  └─ utils/                 # 日志、时间与安全工具
│  ├─ database/                 # 初始化 SQL 与迁移
│  ├─ scripts/                  # 运维、配额和回归脚本
│  └─ .env.example              # 后端完整环境模板
├─ scripts/                     # 前端检查与分析基准脚本
├─ .env.example                 # 前端 API 地址模板
├─ .env.neo.example             # 新 Nest API / BullMQ Worker 环境模板
├─ pnpm-workspace.yaml          # Legacy + Neo 单一 workspace
├─ .umirc.ts                    # Umi 路由与开发代理
├─ nginx.conf.example           # Legacy 生产反向代理示例
└─ nginx.refactor.conf.example  # Phase 0 双系统验证片段
```

## 常见问题

### 前端请求出现 `/api/api/...` 或 `/api/v1/v1/...`

前端请求、同步导出、异步导出和任务下载已共用同一套 URL 规范化逻辑，并兼容站点源地址、`/api` 与 `/api/v1` 三类 `API_BASE_URL`。部署时仍需检查根目录 `.env` 和 Nginx `proxy_pass`：Nginx 必须原样转发 `/api/v1/...`，不能在上游地址再次追加 `/api` 或 `/api/v1`。修改后运行 `npm run test:contracts`，同时验证普通请求和导出请求。

### 后台任务一直等待

确认 Redis 可连接、至少有一个 `worker` 或 `all` 进程正在运行，并检查目标队列是否包含在 `WORKER_ENABLED_QUEUES` 中。

### 定时任务重复执行

检查所有 API 实例的 `SCHEDULER_ENABLED`。横向扩容时只能有一个实例设为 `true`。

### 监控频繁遇到 429

降低监控并发、增加 `MONITOR_BATCH_COUNT` 或延长调度间隔，并运行配额分析工具确认计划调用量。批次数增加会同步延长完整覆盖周期；实际 Amazon 限额仍需结合响应头和 429 判断。

### 健康检查返回 503

查看响应中的数据库、内存、限流器和缓存状态，再结合服务端日志定位。健康阈值可通过 `HEALTH_*` 变量调整。

### 生产环境刷新页面返回 404

确认 Nginx 的站点根目录指向 `dist/`，并为前端路由配置 SPA 回退：`try_files $uri $uri/ /index.html;`。

## 相关文档

- [`server/database/README.md`](./server/database/README.md)：数据库文件与初始化说明
- [`server/database/MIGRATION.md`](./server/database/MIGRATION.md)：已有数据库升级指南
- [`server/scripts/QUOTA-GUIDE.md`](./server/scripts/QUOTA-GUIDE.md)：SP-API 配额分析说明
- [`nginx.conf.example`](./nginx.conf.example)：Nginx/1Panel 配置起点
- [`nginx.refactor.conf.example`](./nginx.refactor.conf.example)：重构期 3001/3100 双跑验证片段
- [`docs/refactor/README.md`](./docs/refactor/README.md)：定稿重构方案、总体计划与归档校验值
- [`AGENTS.md`](./AGENTS.md)：仓库开发约定与 PR 描述格式
- [`README.archive-2026-07-15.md`](./README.archive-2026-07-15.md)：旧版 README 存档

## 安全提示

- 不要提交 `.env`、数据库备份、访问令牌、Webhook 或任何真实凭据。
- 生产环境必须替换 `JWT_SECRET`、使用强密码并启用 HTTPS。
- 当前部分业务路由尚未统一强制后端鉴权；不要把后端 `3001` 端口直接暴露到公网，只能通过受控网络和反向代理开放必要路径。
- 仅向可信网络开放 MySQL、Redis、`/health`、`/metrics` 和内部 Worker。
- 定期验证备份可恢复性；执行迁移、恢复或大规模回填前先创建独立备份。
- 数据库恢复会覆盖当前数据且不可逆，执行前同时核对目标数据库和备份文件。
- SP-API 与飞书配置属于敏感数据，排障时只记录最小上下文，不要输出完整请求或响应。
