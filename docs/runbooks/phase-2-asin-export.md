# Neo ASIN 异步导出首批链路

## 启用条件与部署

- API 和 Worker 使用同一 PostgreSQL、Redis/BullMQ 命名空间及 `EXPORT_STORAGE_DIRECTORY`。该目录必须是两进程都可读写的私有共享卷，配置为绝对路径，不经 Web 静态目录暴露。仅部署一个进程实例时默认目录是仓库根目录 `var/neo/exports`；多主机部署必须显式指定共享卷。卷应只允许服务账号访问。
- `AUTH_DATA_AUTHORITY=postgresql`，且 Worker 的 `WORKER_ENABLED_QUEUES` 包含 `export`。API 默认端口 3100。仍由现有 Legacy 服务处理其它导出类型和 SSE；本阶段不切流、不退役 Legacy。
- `TASK_META_TTL_SECONDS` 至少为 72 小时，覆盖全局 100 个排队任务在单消费者、每任务 30 分钟上限下的最长正常等待及处理时间。低于此值时 API 拒绝创建 ASIN 导出，Worker 拒绝启动导出消费者。默认 7 天满足要求。
- `POST /api/v1/tasks/export` 仅支持 `{ "exportType": "asin", "params": { "keyword": "...", "country": "US", "variantStatus": "BROKEN" } }`。`params` 可省略。其它已知类型返回 501；无效筛选返回 400。
- 入队前实时检查 PostgreSQL `asin:read`。单个 API 实例同时处理最多 4 个创建请求；Redis 原子创建脚本跨 API 实例将每个用户的活动 ASIN 导出限制为 2 个、全局非终态 ASIN 导出限制为 100 个。明确入队失败会将任务标为失败并释放名额；提交结果未确认时保留任务和名额供对账。Worker 同时处理最多 2 个导出。单任务最多 10,000 个组、100,000 行或 256 MiB，最长 30 分钟；超限标为失败，应缩小筛选范围。

## 任务与文件生命周期

1. 用任务中心 `GET /api/v1/tasks/:taskId` 查看进度，或通过 `/ws` 任务通知订阅。`POST /api/v1/tasks/:taskId/cancel` 可请求取消。明确的入队前拒绝将任务写为失败；提交结果未确认时，创建接口仍返回成功信封，`data.status=unknown` 且保留 `data.taskId`，客户端继续查询该 ID，避免重复提交。若入队未成功，任务详情在 30 秒后确认 BullMQ 没有作业时将其写为失败。
2. Worker 每页读取最多 50 个组，再按每页最多 5,000 个子 ASIN 逐组分页，按创建时间和 ID 游标继续读取，避免并发插删使偏移页重复或遗漏。仅首批计算组数；实际写入行数受 100,000 行限制。导出查询使用独立的 PostgreSQL 只读事务，单条 SQL 最长 60 秒、事务最长 65 秒；仍受单任务 30 分钟截止约束。写入期间文件名为 `export-<taskId>.<随机 UUID>.part`；完整校验后用硬链接原子发布为 `export-<taskId>.xlsx`。失败或取消删除本次临时文件。重复尝试复用已发布且校验通过的产物，不重复写入。
3. 任务完成后使用 `GET /api/v1/tasks/:taskId/download`。API 每次验证当前登录、任务所有者、`asin:read`、完成状态、任务绑定的文件标识/大小/SHA-256，之后通过流式响应发送文件；ASIN 文件的校验和传输共用 30 分钟时限，接口不接受客户端文件路径。
4. Worker 每分钟清理超过 `max(1 天, TASK_META_TTL_SECONDS)` 的临时文件，以及任务元数据和队列作业都已不存在的最终文件。清理批量上限为 100。共享卷应为 256 MiB 单文件限制和实际并发/保留量留足容量。监控导出失败、共享卷空间和清理警告。

## 验证与回滚

- 运行 `corepack pnpm --filter contracts test`、`corepack pnpm --filter export test`、`corepack pnpm --filter api test`、`corepack pnpm --filter worker test`、`corepack pnpm build:api`、`corepack pnpm build:worker`。隔离 PostgreSQL/Redis 集成测试需设置 `RUN_INTEGRATION_TESTS=true` 和仓库测试环境变量；API 集成测试使用编译后的 Worker 文件、独立 PostgreSQL schema、唯一 Redis 前缀及临时导出目录。
- 回滚时停止 API 创建此类型的 Neo 任务并停止 Neo `export` Worker，保留共享卷直到已创建任务的下载/保留期结束，再按任务元数据和队列状态清理。Legacy SSE 导出始终可用；没有数据库结构变化或数据回滚步骤。
