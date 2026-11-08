# Neo 竞品目录异步 XLSX 导出

关联 Issue #230。复用主营导出的 API、BullMQ `export` 队列和私有共享卷，新增两种任务子类型；不增加端点或 SSE，不切换生产流量。

## 请求与授权

- `POST /api/v1/tasks/export` 接受 `exportType: competitor-asin` 或 `competitor-variant-group`，`params` 支持 `keyword`、`country`、`variantStatus`（`NORMAL` / `BROKEN`），可省略。不接受主营专用 `layout`。
- API 受理时实时检查主库当前用户、会话及 `asin:read`；Worker 在读取/分页/发布前重查主库用户与权限，下载再次使用当前请求身份授权。竞品业务快照仅访问 `COMPETITOR_DATABASE_URL`。
- 四种目录导出共享用户最多 2 个、全局最多 100 个活动任务的 Redis 原子限额；同一个 Worker 消费者最多并发 2 个，不新增独立竞品执行池。API/Worker 必须共用 Redis 前缀及 `EXPORT_STORAGE_DIRECTORY`。

## 行数据与资源边界

- 全部组、成员页在同一 `REPEATABLE READ READ ONLY` 快照内读取。组按创建时间倒序、原始 ID 倒序；成员按创建时间正序、原始 ID 正序。时间 keyset 保留数据库微秒，空时间排序明确。每页最多 50 组 / 5000 成员，压缩写入逐段等待背压。
- 两类工作簿分别为竞品 ASIN 11 列和竞品变体组 10 列；没有主营站点、人工状态和来源字段。空组保留，组导出状态按成员自动异常重新计算，筛选仍保持 Legacy 的存储组状态或成员异常语义。成员关联保持原始 ID，不用大小写/重音归一化后的 ID 重新拼组。
- 沿用最多 10000 组、100000 数据行、32767 UTF-16 单元/单元格、256 MiB 文件及 30 分钟任务预算。超限失败，不截断内容。Date 单元格与上海日期文件名保持 Legacy 导出行为。
- 私有文件发布、摘要、取消/重试、完成 ACK 不确定对账和清理规则见 [主营导出基础](phase-2-asin-export.md)。撤权后旧产物也不能通过下载授权；产物损坏拒绝下载。

## Web 与故障恢复

- `/competitor-asin` 的两个导出按钮只提交已应用筛选，显示原任务 ID；下载和取消在任务中心完成。文件保存沿用 [流式下载](phase-2-asin-export-file-save.md)。
- 提交前在当前用户/会话的 sessionStorage 保存保护记录。网络断开、ACK 未确认或离页后保留原记录，刷新只读取原任务，不自动重复 POST。终态确认后可恢复导出；没有任务 ID 时必须先人工核对任务中心再解除保护。存储不可用则不提交。
- 当前身份/会话变化或撤权会隔离旧请求结果并中止本地等待；本地中止不是服务端取消，原任务仍需查询或在任务中心取消。

## 验证入口与剩余门禁

- `corepack pnpm --filter worker exec vitest run test/competitor-export-legacy.test.ts test/competitor-export-recovery.test.ts`：执行未改动的两套 Legacy 导出函数，逐行比较工作簿内容、类型、Date 和列宽，并验证 ACK 重试、取消清理、撤权。
- `corepack pnpm --filter api exec tsc -p tsconfig.export.test.json --pretty false`：严格检查新增真实集成夹具。
- 隔离 CI 在编译 Worker 后，以显式一次性双 PostgreSQL / Redis 环境运行 `corepack pnpm --filter api exec vitest run test/competitor-export.integration.test.ts --no-file-parallelism`。夹具只允许精确 loopback CI 数据库、随机 schema/Redis 前缀和临时私有目录；验证 HTTP→Worker→XLSX→ 受权下载、混合限额、排队取消、撤权、损坏、超过 50 组/5000 成员的分页及并发删除下的快照。未开启 opt-in 的 skip 不算真实集成通过。
- Web mounted/HttpClient 测试和静态扫描不替代真实浏览器。完整浏览器文件保存、大文件最大并发 RSS 与生产前迁移验收继续由独立门禁记录；不以本切片替代整体验收。

## 回滚

回滚此 Issue 的提交即可撤下竞品导出入口与类型接线；不涉及数据库迁移。已有任务/私有产物按原保留策略处理，不删除生产数据，不退役 Legacy。
