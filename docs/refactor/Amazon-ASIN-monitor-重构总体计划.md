# Amazon ASIN Monitor 重构总体计划

> 依据：《Amazon-ASIN-monitor-重构方案.md》§12 定稿结论（方案 B + PostgreSQL 16 + TimescaleDB + 方向七·明快作业台）
> 已确认的前置结论：① 设计原型文件不可得，按方案 §11.9 文本重建 tokens；② 重构期内旧系统**功能冻结，仅 bugfix**。

---

## 1. 现状基线（经仓库实测核实）

### 后端（`server/`，Express 4 纯 JS，CommonJS）

- **入口**：`server/src/index.js`；角色由 `PROCESS_ROLE=api|worker|all` 控制（`config/processRole.js`），`SCHEDULER_ENABLED` 控制调度器；Worker 入口 `src/worker-index.js` → `workerProcessorRegistry.js`。
- **API**：18 个路由文件、约 **117 个端点**，统一挂 `/api/v1`（`src/index.js:167-188`）；另有根级 `/health`、`/api/v1/health`、`/metrics`。鉴权链路：`middleware/auth.js`（JWT + Session 行校验）→ `checkPermission('domain:action')`。
- **Service 层**：58 个文件。上帝文件清单（拆分对象）：
  - `services/variantCheckService.js` 45.4KB、`services/exportTaskProcessor.js` 40KB、`services/rateLimiter.js` 31.7KB（SP-API US/EU 配额，Redis 滑动窗口 + 内存令牌桶兜底）、`services/monitorTaskRunner.js` 29.9KB、`services/analyticsAggService.js` 27.9KB（942 行，水位增量刷新）
  - `controllers/exportController.js` 61.7KB（exceljs 内存 `writeBuffer()` + SSE 进度）、`controllers/monitorController.js` 24KB
  - `models/MonitorHistory.js` **193.8KB**（全后端最大文件，分析 SQL 全部在此）
- **队列**：Bull v4 共 **8 个队列**（monitor / competitor-monitor / export / import / batch-check / batch-delete / backup / variant-check），统一 `*TaskQueue.js` + `*TaskProcessor.js` 模式；`queueConnectionWatchdog.js`（15s ping、60s 不健康退出进程）；`taskRegistryService.js`（Redis `task:meta:*`，7d TTL，内存兜底）。
- **调度**：`schedulerService.js`（node-cron，Asia/Shanghai）——US 监控（默认 30min，DB 可配）/ EU 监控（默认 60min，五国 1s 错开 + 竞品跟随）/ 分析聚合（默认 `*/10 * * * *`）/ 备份（BackupConfig 表驱动）。
- **WebSocket**：`services/websocketService.js`，`/ws`，JWT+Session 握手校验（关闭码 4401/4403），9 种服务端消息：`connected / monitor_progress / monitor_complete / stats_update / task_progress / task_complete / task_error / task_cancelled / pong`。
- **横切**：`middleware/rateLimit.js`（Redis store，按角色分级）；`middleware/auditLog.js`（包 `res.json` 模式匹配记录）；`metricsService.js`（指标全部 `amazon_asin_monitor_*` 前缀）；`feishuService.js`（webhook，11232 限流码重试）。
- **数据层**：`mysql2/promise` 双连接池（`config/database.js` + `config/competitor-database.js`），裸 SQL 散落 17 个 models + 多个 services；**无迁移执行器**（33 个迁移文件手工执行，`MIGRATION.md` 记录，013/021/030 重号）。
- **死代码/默认关闭项**：`sessionCleanupService.js`、`auditLogArchiveService.js` 已定义但从未启动；3 个 `worker_threads`（export/import/backup）默认全部禁用。

### 前端（仓库根，Umi Max 4 + React 18 + AntD 5 + Pro Components + ECharts 5）

- **路由**：15 个有效页面路由（`.umirc.ts`），另有 `src/pages/FeishuConfig` 孤儿页（未挂路由，功能在 Settings 内）。
- **重页面**：`Analytics` 2578 行（5+ 图表）、`ASIN` 1316 行 + `ExcelImportModal` 902 行、`MonitorHistory` 1062 行、`Settings` 1087 行（51 处 Pro 组件）、`CompetitorASIN` 939 行 + 其 `ExcelImportModal` 874 行（**与 ASIN 的近重复，~1.8K 行**）、`Home` 885 行、`Tasks` 588 行。ProTable/ProForm 全仓约 214 处引用、22 个文件。
- **服务层**：`src/services/` 16 个模块约 123 个 API 调用，umi-request；`src/utils/apiUrl.ts` 的 baseURL 归一化 + `/api/api` 去重逻辑（受 `tests/api-url.test.js` 契约保护，含 nginx.conf.example 断言）；`token.ts` cookie 会话模型；`websocket/index.ts` 221 行 WS 客户端（指数退避重连、30s ping）。
- **状态**：`@@initialState`（`app.tsx` `getInitialState` → `/auth/current-user`）+ `access.ts` 权限工厂；无 dva；`utils/export.ts` 847 行（异步任务导出 + WS 等待）。
- **可丢弃项**：`models/global.ts`、`components/Guide`、`utils/requestDedupe.ts`（从未使用）、`app.less` 的 ProLayout hack、登录页 303 行装饰 less、`mock/`（`mock: false` 已禁用）。

### 数据库 / CI / 运维

- MySQL 8 双库：`amazon_asin_monitor`（21 表）+ `amazon_competitor_monitor`（4 表）。PG 翻译热点：`TINYINT(1)`、`ENUM ×5`、`ON UPDATE CURRENT_TIMESTAMP`、`monitor_history` 三个 `GENERATED` 列（`DATE_FORMAT`/`TIMESTAMP()`）、`ON DUPLICATE KEY UPDATE ... VALUES()`、反引号/`ENGINE`/`USE`/`utf8mb4_0900_ai_ci`、双库隔离。
- CI（Node 20）：`.github/workflows/ci.yml`（npm ci → pr-policy → changed-format → test:contracts → server test:unit → tsc → build）；`pr-policy.yml`；`integration.yml`（redis:7 + mysql:8 services）。
- 基线检查（AGENTS.md）：`npm run test:contracts`、`npm --prefix server run test:unit`、`npx --no-install tsc --noEmit --pretty false`、`npm run build`、`git diff --check`。
- 可复用资产：`scripts/benchmark-analytics.js`（双 base 对拍 + 报告模板）可直接扩展为影子双跑 diff 工具；`scripts/test-env.js`、`check-redis.js`。
- 部署：单机（1Panel + `nginx.conf.example`），无 Docker；`/api`、`/ws`、`/health` 三个 location。

---

## 2. 目标架构

```
Amazon-ASIN-monitor/                 # 本仓库原地改造为 pnpm Monorepo
├── apps/
│   ├── web/                         # 新前端：Vite 6 + React 19 + TS strict + TanStack Router/Query + Tailwind 4 + shadcn/ui + ECharts 6 + Motion
│   ├── api/                         # 新后端：NestJS 11（Fastify adapter）HTTP + WS 网关 + 调度（SCHEDULER_ENABLED 语义平移）
│   └── worker/                      # BullMQ 消费进程（与 api 共享领域模块，对应现 PROCESS_ROLE=worker）
├── packages/
│   ├── contracts/                   # zod 契约：REST envelope/分页/全部端点 + WS 9 种消息 + 权限码常量；前后端唯一事实源
│   ├── db/                          # Drizzle ORM schema（PG）+ drizzle-kit 迁移（baseline 化现有 schema）
│   └── config/                      # 共享环境变量校验（zod）
├── src/  server/  mock/  tests/     # 旧系统原地保留至切换（功能冻结）
└── scripts/  .github/               # 随阶段演进更新
```

- 进程拓扑不变：API 实例 + Worker 实例 + 单调度器（`SCHEDULER_ENABLED`）+ 单 Redis + 单 PG（TimescaleDB 扩展）。
- 中间件：Redis 7.x 保留（队列/限流/缓存/PubSub 四角色不变）；PostgreSQL 16 + TimescaleDB 接管全部持久化；`amazon_asin_monitor` 与 `amazon_competitor_monitor` 平移为 PG 两个独立 database（保持隔离语义，见决策 D6）。
- TimescaleDB 替代物：`monitor_history` 转 hypertable；`monitor_history_agg` / `monitor_history_agg_dim` / `monitor_history_agg_variant_group` 三张表 + `analyticsAggService.js`（942 行）+ `analytics_refresh_watermark` 水位机制 → **持续聚合（Continuous Aggregates）**；`monitor_history_status_interval` 保留（区间语义不是聚合）。

---

## 3. 全程迁移保障基线（任何阶段都适用）

1. **契约冻结**：阶段 0 产出 `packages/contracts` v1（覆盖 117 端点 + WS 协议），旧系统功能冻结保证基线不动；现有 `tests/api-url.test.js`、`tests/init-schema.test.js`、`tests/database-docs.test.js` 在过渡期继续守护旧系统。
2. **数据库零改动起步**：MySQL schema 不动；PG schema 以翻译基线方式建立；索引/分区/压缩策略作为独立变更评审。
3. **影子双跑**：只读接口新旧后端并行，基于 `scripts/benchmark-analytics.js` 双 base 机制扩展响应 diff；写接口特性开关灰度；nginx 按 location 切流。
4. **任务等价验证**：导入/导出/备份用同一批 fixture 在新旧 Worker 各跑一遍，记录级比对。
5. **可观测性对齐**：新后端指标沿用 `amazon_asin_monitor_*` 命名（`http_requests_total`、`http_request_duration_seconds`、`variant_group_checks_total`、`scheduler_runs_total`、`db_query_duration_seconds`、`cache_hits_total` 等）；日志规范沿用 AGENTS.md（`logger`、`LOG_LEVEL`、敏感字段脱敏，NestJS 侧落为全局 Logger 模块）。
6. **回滚预案**：每阶段定义回滚路径；数据层切换期 MySQL 保留只读副本一个版本周期；nginx 一键切回旧后端。

### 执行协议（对接 AGENTS.md 契约）

- 每个任务先开 GitHub Issue，分支 `refactor/<issue>-<slug>` 等对应前缀；PR 全部以 Draft 打开、目标 `main`、中文模板、Squash 合并。
- 不用长生命周期重构分支：新旧代码在 `main` 上并存，小步 PR 持续合入；旧系统 bugfix 照常走 `fix/<issue>-*`。
- PR 粒度：>15 文件或 >1000 行需在 PR 说明理由；上帝文件拆分允许超标但须附拆分说明。
- 检查基线随 Monorepo 化演进为：`pnpm test:contracts`（旧契约，过渡期保留）+ `pnpm --filter contracts test` + `pnpm --filter api test` + `pnpm --filter worker test` + `pnpm --filter web build` + `pnpm --filter api build` + `tsc --noEmit` + `git diff --check`；阶段 0 更新 AGENTS.md 与 CI。
- 排期基准：总工期 9–13 周（方案 §12.2），前端线 / 后端线 / 数据线三线并行；若单人执行，按关键路径顺延（数据→后端→前端）。

---

## 4. 阶段 0：契约冻结与脚手架（第 1–2 周）

### P0-T1 契约盘点与冻结

- 盘点 18 个路由文件 → 端点清单表（方法 / 路径 / 权限码 / 请求体 / 响应体 / 特殊行为：SSE、文件下载、multer 上传）。
- `packages/contracts` 落地：
  - 统一信封 `{ success, errorMessage, errorCode, data }` 与分页 `PageInfo`（对齐 `src/types/api-compat.d.ts`）。
  - 逐域 zod schema：auth(7) / users(8) / roles(4) / asin(16) / variant-check(4) / monitor(17) / competitor(14+3+3+3) / export(9) / tasks(5) / backup(7) / feishu(6) / sp-api-config(5) / audit(4) / ops(3) / dashboard(1) / system(1) / health。
  - WS 协议 zod 化（9 种消息 + 4401/4403 关闭语义）；权限码常量表（对齐 `access.ts` 与 `checkPermission` 调用点）。
- 契约测试基线：对旧后端录制关键只读端点响应 fixture（登录后跑 `dashboard`、`monitor-history`、`analytics`、`tasks`、`ops/overview` 等），作为新旧 diff 的 golden set。
- **产出**：`packages/contracts` v1 + 端点清单文档；**验证**：`pnpm --filter contracts test` 绿，fixture 录制脚本可重复执行。

### P0-T2 Monorepo 脚手架

- 根改造：`pnpm-workspace.yaml`（含 `.`、`server`、`apps/*`、`packages/*`）；`pnpm import` 从两个 package-lock 迁移依赖版本，统一 `pnpm-lock.yaml`；CI 切 `corepack pnpm`（Node 20）。
- `apps/api`：NestJS 11 + Fastify adapter 骨架——全局 zod ValidationPipe、`/health`、`/metrics`（prom-client 同名指标占位）、ConfigModule（zod env 校验，对齐 `server/src/config/envValidator.js` 的必需变量组）、logger 模块（脱敏规则对齐 `server/src/utils/logger.js`）。
- `apps/worker`：独立入口，复用 api 的领域模块注册 BullMQ Processor。
- `apps/web`：Vite 6 + React 19 + TS strict + TanStack Router/Query + Tailwind 4 + shadcn/ui 初始化 + Vitest + ESLint flat config；`/api` dev proxy 指向 3001。
- `packages/db`：Drizzle + drizzle-kit 骨架（PG 连接，双 database 配置位）。
- **产出**：可构建、可启动、CI 绿的空骨架；**验证**：`pnpm install --frozen-lockfile`、全部 build/test job 绿、旧系统 checks 不受影响。

### P0-T3 治理文件更新

- 更新 `AGENTS.md`（检查命令、Monorepo 结构说明）、`CONTRIBUTING.md`、`README.md`（重构期双系统说明与开发命令）。
- **验证**：`npm run test:contracts` 中的 docs 类测试同步修订后仍绿。

**阶段 0 出口 gate**：契约库 v1 合入 main；空骨架可通过 nginx 双 location 并行部署（旧 3001 / 新 3100）；CI 全绿。

---

## 5. 阶段 1：数据层迁移（第 2–5 周，与后端/前端并行）

### P1-T1 PG 16 + TimescaleDB 环境

- 自托管搭建（决策 D7：默认自托管，沿用单机 1Panel 拓扑）；dev 环境与 `integration.yml` 增加 `timescale/timescaledb:2.x-pg16` service。

### P1-T2 Schema 翻译基线

- `server/database/init.sql` + `competitor-init.sql` + 33 个迁移 → 单一 PG 基线（`packages/db/migrations/0000_baseline.sql`），迁移历史归档为只读参考（`MIGRATION.md` 注明"历史冻结"）。
- 翻译清单（逐项核对）：`TINYINT(1)`→`BOOLEAN`；5 处 `ENUM`→`CHECK`（或 PG ENUM，逐列定）；`AUTO_INCREMENT`→`GENERATED ALWAYS AS IDENTITY`；`ON UPDATE CURRENT_TIMESTAMP`→统一触发器函数；`ON DUPLICATE KEY UPDATE ... VALUES()`→`ON CONFLICT ... DO UPDATE SET ... EXCLUDED.*`；去反引号/`ENGINE`/`USE`；`utf8mb4_0900_ai_ci` 排序规则平移评估。
- **时间列决策 D8**：全部时间列用 `timestamp`（无时区，平移 MySQL `DATETIME` 语义 + 应用层 Asia/Shanghai 转换），`hour_ts/day_ts/month_ts` 生成列用 `date_trunc` 直接平移（避免 `timestamptz` 下 `date_trunc` 非 immutable 不能用于生成列的坑）。
- 种子数据（roles/permissions/role_permissions/backup_config）转 `ON CONFLICT` 幂等脚本。
- `drizzle-kit pull` 反向生成 Drizzle schema，人工校对后作为 `packages/db` 事实源。

### P1-T3 数据迁移与对拍

- **决策 D2**：默认"周期性全量预演（pgloader 评估 + 自定义 ETL 兜底）+ 切换窗口最终同步"；若业务要求零停机再升级为应用层双写（阶段启动时评审，当前部署规模下不推荐 Debezium）。
- 校验：行数比对 + 抽样字段比对 + 关键业务查询结果对拍（脚本化，纳入 contracts 测试资产）。

### P1-T4 TimescaleDB 改造与聚合对拍

- `monitor_history` → hypertable（`check_time` 分区）；三张 agg 表 → 持续聚合视图（hour/day/month × asin/dim/variant_group 维度对齐现表结构）。
- 对拍：同一时间段旧 agg 表 vs 新持续聚合结果抽样比对，产出比对报告；`scripts/benchmark-analytics.js` 跑出 PG 侧基线数字（验收目标：分析聚合 P95 ≥ 3× 现状）。
- 索引策略重设计：时间序列表评估 BRIN；保留高频过滤组合索引；压缩与保留策略定稿（独立 PR 评审）。

**阶段 1 出口 gate**：PG 双库就绪且数据对拍通过；持续聚合对拍报告合入；回滚预案（MySQL 只读兜底）成文。

---

## 6. 阶段 2：后端重构（第 3–8 周）

> 原则：先横切、后业务域；每个域 = NestJS module（controller + service + repository（Drizzle）+ 单测）；`models/*.js` 裸 SQL 全部收敛进 `packages/db` repository 层，消灭散落 SQL。

### P2-T1 横切基础设施（先行）

- config（zod env）、logger（脱敏）、metrics（同名指标）、health（双 DB 池 + 限流 + 缓存 + 错误统计，对齐现 `/health` 字段）。
- auth：JWT + Session 行校验平移（`middleware/auth.js`、`utils/authCookie.js`）；RBAC：`checkPermission` → Nest Guard + 权限缓存（`permissionCacheService` 语义）。
- rate-limit：Redis store 按角色分级平移（`middleware/rateLimit.js` 数值：apiLimiter 100/15min、strict 20/15min、ADMIN 1000 / EDITOR 500 / READONLY 100）。
- audit：拦截器平移 `middleware/auditLog.js` 的路径/方法→动作映射表。
- WS 网关：`/ws` 协议逐消息平移（9 种消息、4401/4403、`broadcastToUser`）；多实例 Redis Pub/Sub 广播预留。

### P2-T2 Bull v4 → BullMQ 平移（8 队列）

- 队列清单逐一平移（名称 / attempts / backoff / limiter / concurrency 环境变量对齐现状）；`workerProcessorRegistry` → 类型化 Processor 注册表；`queueConnectionWatchdog` → BullMQ 健康检查（15s ping、60s 退出语义保留）；`WORKER_ENABLED_QUEUES` 选择语义保留。
- `taskRegistryService`（Redis `task:meta:*` + 用户索引 + 7d TTL）平移或重构为 BullMQ job 状态 + 兼容索引（任务中心 API 契约不变）。
- node-cron → BullMQ Repeatable Jobs：US/EU 监控（DB 可配分钟数、EU 五国 1s 错开、竞品跟随）、分析聚合 `*/10`、备份（BackupConfig 驱动 + 热重载）；`SCHEDULER_ENABLED` 单调度器语义用 Redis 锁保证。
- **切换纪律**：上线窗口 drain 旧队列（Bull 与 BullMQ 数据结构不兼容，不做在线迁移）。

### P2-T3 业务域模块（按依赖序）

1. **auth/users/roles/audit**：对应 `authRoutes`/`userRoutes`/`roleRoutes`/`auditLogRoutes` + `User/Role/Permission/Session/LoginAttempt/PasswordHistory/UserStatusHistory` models + `loginAttemptService`/`passwordHistoryService`/`userStatusService`；**决策 D4**：`sessionCleanupService`、`auditLogArchiveService` 迁入并真正挂调度启用（原死代码）。
2. **SP-API 设施**：`config/sp-api.js`（34KB，LWA + 可选 SigV4、US/EU）、`rateLimiter.js`（31.7KB，Redis 滑动窗口 + 内存兜底、优先级、0.75 安全系数、45/min 区域帽）——**行为测试先行**：移植现有 `server/test/quota-tools.test.js`、`sp-api-error.test.js` 后再重写；`spApiScheduler`、`legacySPAPIClient`、`htmlScraperService`、`riskControlService`、`errorStatsService`、`spApiConfigRoutes`。
3. **asin 域**：`asinRoutes`(16) + `variantCheckRoutes`(4) + `ASIN`/`VariantGroup` models + `asinBatchCreateService`/`batchDeleteService`（分块 + FK 清理）+ `importParserService`/`importService` + `variantParser`/`variantStatus` utils。
4. **变体检查管道**：`variantCheckService.js`（45.4KB）按 **抓取 → 比对 → 持久化 → 通知** 拆管道，单测先行；含 `batchVariantCheckService`、`batchCheckTaskProcessor`、`variantCheckResultMapper`、`competitorVariantCheckService`。
5. **monitor 域**：`monitorRoutes`(17) + `MonitorHistory.js`（193.8KB 拆解：查询按场景分 repository，聚合快路改为持续聚合查询）+ `monitorTaskRunner`/`competitorMonitorTaskRunner`（信号量并发、deferred 重试、飞书通知、WS 进度）+ `monitorQueuePolicy`（定时任务去重 + 过期批跳过）+ `dashboard`/`system/alert`。
6. **analytics 域**：`analyticsAggService` 删除（Timescale 持续聚合替代）+ `analyticsCacheService`（Redis 二级缓存 + 失效队列保留）+ `analyticsViewService` + `opsRoutes`(3)。
7. **export/import 域**：`exportController.js`（61.7KB）拆解；exceljs **流式写盘 + 分页查库**（消灭 `writeBuffer()` 大内存）；**决策 D5**：新系统统一"异步任务 + WS 进度"，SSE 同步导出端点双跑期由旧后端继续服务、新契约标记 deprecated；**决策 D3**：3 个默认关闭的 `worker_threads` 不迁移（BullMQ 并发 + 流式替代）。
8. **competitor 域**：`competitorAsinRoutes`(14) + `competitorMonitorRoutes`(3) + `competitorVariantCheckRoutes`(3) + 竞品 services + 第二 database repository。
9. **backup 域**：`backupService`/`backupRoutes`/`BackupConfig` 平移；**备份产物格式切换为 pg_dump 自定义格式**（契约变化点，PR 与文档明确说明；旧 MySQL 备份仅历史保留，不在新系统恢复）。
10. **notify 域**：`feishuService`/`competitorFeishuService`/`feishuRoutes`（11232 限流码退避、500ms 间隔、3 次重试语义保留）。

### P2-T4 影子双跑与任务等价

- 只读端点：nginx 镜像或双 base diff（扩展现有 benchmark 脚本），响应 diff 报告归零。
- 写端点：特性开关按域灰度；`test:integration` 移植为 PG 版集成测试。
- 任务等价：导入/导出/备份 fixture 新旧 Worker 产物记录级一致（导出文件按行内容比对，允许元数据差异）。

**阶段 2 出口 gate**：117 端点契约测试在新后端全绿；任务等价报告通过；`/metrics` 命名与看板无缝；`server/test` 三个单测套件已移植到 `apps/api`/`apps/worker` 并扩展覆盖拆分后的管道。

---

## 7. 阶段 3：前端重写（第 3–9 周，按页面批次）

### P3-T1 设计系统（方向七·明快作业台，无原型文件，按 §11.9 重建）

- **Tokens**：CSS 变量 + Tailwind 4 `@theme`——底色 `#f5f5f0`/`#f8f8f8`、卡片 `#fff`、深色区块 `#0a0a0a`（页头/登录/大屏）；信号色荧光青柠 `#c8ff00`/`#d4fd8e`（仅主操作/激活态/关键数字，配黑字）；模块色彩编码（ASIN=青柠、监控=`#304ffe`、分析=琥珀、任务=珊瑚橙、竞品=品红）；状态色（正常绿/异常红/预警黄）与模块色正交；圆角阶梯 999/20/16/12/8；数字/ASIN/时间戳等宽 + `tabular-nums`。
- **组件**：shadcn/ui 主题定制；数据表格（TanStack Table + 比例列宽 + 行级批量操作浮条）；筛选 Chip（脉冲点）、状态胶囊、14px 柔和进度条（`#adefed`）、骨架屏、虚线空态；ECharts 封装（按需引入 + `React.lazy`，等价现 `LazyECharts`，token 配色同源，`animationDurationUpdate` 补间）。
- **动效六层**（Motion 承担弹簧/布局动画，CSS transition 承担 80%）：页面/面板弹簧过渡（0.25–0.4s）、大数字 count-up、列表错峰入场（30–50ms 递增，仅首屏）、WS 行数据脉冲闪烁、成功对勾描边 + toast 弹簧滑入、登录后一次性加载叙事；全局遵守 `prefers-reduced-motion`，交互过渡 ≤0.4s。
- **AppShell**：奶油白可折叠侧栏（模块色标记、收起态任务呼吸点）、筛选树浮层；**并入方向五的 ⌘K 命令面板**（跳页/搜 ASIN/触发立即检查）。

### P3-T2 应用骨架

- TanStack Router 路由表平移 15 路由 + 权限 guard（`access.ts` 的 `isLogin/canReadASIN/...` 语义逐一对应）；`@@initialState` → auth context（`getInitialState` → `/auth/current-user`、401/403 → `/login?redirect=` 语义平移）。
- fetch 客户端 + TanStack Query：`apiUrl.ts` 归一化规则**原样移植**（strip trailing、`/api/api` 去重、拒绝跨域绝对地址），`tests/api-url.test.js` 在新包内等价重建；信封解包对齐现响应拦截器；`token.ts` cookie 会话模型平移。
- WS 客户端平移（221 行：指数退避 ≤5 次、4401/4403 停连、30s ping）；`utils/export.ts`（847 行）与 `utils/task.ts` 的异步任务模式重构为 hooks。
- `beijingTime.ts`/`peakHours.ts`/`amazon.ts`（~20 站点域映射）原样移植。

### P3-T3 页面四批迁移（每批 = 路由级灰度 + 功能对照验收）

| 批次 | 页面 | 重点 |
| --- | --- | --- |
| 1 | Login(178+303less→重建)、Home(885)、403、Profile(357) | Home：状态带大数字 + 三栏（筛选树 / 变体组表 + 7 天 sparkline / 实时告警流），WS 实时进度 |
| 2 | ASIN(1316+902)、CompetitorASIN(939+874)、ASINParentQuery(338) | **合并两套近重复组件**（ExcelImportModal 等 ~1.8K 行归一为共享组件）；导入导出走任务中心异步化 |
| 3 | Tasks(588)、MonitorHistory(1062)、CompetitorMonitorHistory(285)、AuditLog(254) | 监控历史：状态区间甘特式区间条（`status_interval` 直渲）；任务中心 WS 进度 + 可取消 |
| 4 | Analytics(2578)、Settings(1087)、UserManagement(389+4)、Ops(235) | Analytics：持续聚合接口驱动首屏直出；Settings 51 处 Pro 表单逐一重建（含飞书配置，吸收孤儿页功能） |

- 顺手删除：`FeishuConfig` 孤儿页、`models/global.ts`、`Guide`、`requestDedupe`、`app.less` ProLayout hack、`mock/`。
- 每批验收：功能对照表逐项人工验收 + 路由级灰度（新前端按路径分流或构建产物双部署），旧 Umi 构建保留可回退至批次稳定。

**阶段 3 出口 gate**：15 路由全部切换新前端；旧 Umi 前端下线（`src/`、`.umirc.ts`、`mock/`、根级前端依赖移除，单独 PR）。

---

## 8. 阶段 4：收尾与切换（第 9–13 周）

- **全链路压测**：高频检查写入不阻塞读；分析聚合 P95 ≥ 3×（复核 `benchmark-analytics.js` 双 base 报告）；导出大文件流式内存验证（对比旧 `writeBuffer` 峰值）。
- **索引/分区/压缩/保留策略终审**（Timescale 侧）；MySQL 归档下线（保留只读一个版本周期后执行）。
- **旧后端下线**：旧 `server/`、`tests/` 旧契约套件、旧 CI job 移除（单独 PR，旧进程保留一个版本周期后停）；`nginx.conf.example` 更新（web dist 路径、`/api`、`/ws` 指向新服务）。
- **文档**：架构图、运维手册（PG/Timescale、BullMQ、备份恢复新格式）、契约维护规范（`packages/contracts` 变更流程）；`AGENTS.md`/`README.md`/`CONTRIBUTING.md` 终态更新（检查命令、结构、数据库章节）。
- **CI 终态**：单 lockfile、并行 job（web / api+worker / contracts / integration(PG+Redis)）。

**最终验收（对齐方案 §12.3）**：
1. 功能零缺失：契约测试全绿 + 15 页功能对照表逐项人工验收。
2. 任务等价：导入/导出/备份 fixture 新旧产物记录级一致。
3. 性能：监控总览首屏 ≤1.5s；高频检查写入不阻塞读；分析聚合 P95 ≥ 3×。
4. 可回滚：任一阶段有完整回滚路径；数据层切换期 MySQL 只读兜底已演练。

---

## 9. 风险登记册

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| `MonitorHistory.js`(193.8KB) + 聚合逻辑改写错误 | 高 | 持续聚合对拍 + golden fixture + benchmark 双 base 数字门槛 |
| SP-API 限流语义回归（US/EU 配额、429） | 高 | 行为测试先行（移植 quota-tools/sp-api-error 单测）；`rateLimiter.js` 数值参数逐项对照表 |
| Bull→BullMQ 切换丢任务/重复 | 中 | 切换窗口 drain；同名队列 prefix 评估；任务等价 fixture 验证 |
| 备份产物格式变化（SQL dump→pg_dump）影响恢复习惯 | 中 | 契约与运维文档显式说明；旧备份保留期延长 |
| 契约漂移（前后端字段） | 中 | `packages/contracts` 单一事实源 + CI 契约测试 |
| PG 生成列/时间类型陷阱 | 中 | 决策 D8（`timestamp` + `date_trunc`）；baseline 迁移在 CI 起 PG service 验证 |
| 前端体量最大页（Analytics 2578 行）迁移低估 | 中 | 放最后批次；先落地表格/图表/筛选三个底座组件再开页面 |
| 单仓库新旧并存期 CI 时长膨胀 | 低 | job 并行化 + 路径过滤；阶段 4 移除旧 job |
| 排期依赖三线并行的人力假设 | 中 | 单人执行时按关键路径顺延并在每周 checkpoint 重排 |

---

## 10. 开放决策点（到阶段启动时确认，默认值已给）

- **D2** 数据同步策略：默认"周期全量预演 + 切换窗口最终同步"；备选应用层双写（零停机需求时）。
- **D3** `worker_threads` 三个默认关闭 worker：不迁移（BullMQ 并发 + 流式替代）。
- **D4** 死代码 `sessionCleanupService`/`auditLogArchiveService`：迁入新系统并真正启用归档调度。
- **D5** SSE 同步导出：新系统统一异步任务 + WS；SSE 端点双跑期由旧后端服务、新契约标记 deprecated。
- **D6** 双库拓扑：PG 两个独立 database（平移隔离语义）。
- **D7** TimescaleDB：默认自托管（现有单机拓扑）；托管为备选。
- **D8** 时间列：统一 `timestamp`（无时区）+ 应用层 Asia/Shanghai，生成列 `date_trunc` 平移。

---

## 11. 批准后第一步

1. 为阶段 0 任务开 GitHub Issues（P0-T1/T2/T3），从 `main` 切 `refactor/<issue>-contracts-scaffold` 等短分支。
2. 按执行协议以 Draft PR 推进 P0-T1（契约盘点 → `packages/contracts` v1）。
