# Neo ASIN 异步导出首批链路

## 启用条件与部署

- API 和 Worker 使用同一 PostgreSQL、Redis/BullMQ 命名空间及 `EXPORT_STORAGE_DIRECTORY`。该目录必须是两进程都可读写的私有共享卷，配置为绝对路径，不经 Web 静态目录暴露。仅部署一个进程实例时默认目录是仓库根目录 `var/neo/exports`；多主机部署必须显式指定共享卷。卷应只允许服务账号访问。
- `AUTH_DATA_AUTHORITY=postgresql`，且 Worker 的 `WORKER_ENABLED_QUEUES` 包含 `export`。API 默认端口 3100。Worker 导出队列或消费者启动超过 5 秒未就绪时会清理连接并退出，由进程管理器重启。仍由现有 Legacy 服务处理其它导出类型和 SSE；本阶段不切流、不退役 Legacy。
- `TASK_META_TTL_SECONDS` 至少为 6 天，覆盖全局 100 个排队任务在单消费者、每任务最多重试 2 次、每次 30 分钟的约 100 小时最长运行时间，并预留运维余量。低于此值时 API 拒绝创建 ASIN 导出，Worker 拒绝启动导出消费者。默认 7 天满足要求。
- `POST /api/v1/tasks/export` 仅支持 `{ "exportType": "asin", "params": { "keyword": "...", "country": "US", "variantStatus": "BROKEN" } }`。`params` 可省略。其它已知类型返回 501；无效筛选返回 400。
- 入队前实时检查 PostgreSQL `asin:read`。单个 API 实例同时处理最多 4 个创建请求；Redis 原子创建脚本跨 API 实例将每个用户的活动 ASIN 导出限制为 2 个、全局非终态 ASIN 导出限制为 100 个。明确入队失败会将任务标为失败并释放名额；提交结果未确认时保留任务和名额供对账。Worker 同时处理最多 2 个导出。单任务最多 10,000 个组、100,000 行或 256 MiB，最长 30 分钟；超限标为失败，应缩小筛选范围。

## 任务与文件生命周期

一次导出的全部组页、子 ASIN 页及状态投影现在共用一个 PostgreSQL `REPEATABLE READ READ ONLY` 快照。并发移组、插删或状态修改不会使同一份文件的分组归属重复或缺失。单 SQL 仍限 60 秒，**整个快照读取与行写入阶段合计最多 65 秒**，不会为 30 分钟任务时限延长数据库事务。快照超时会销毁连接、停止后续读取并清理临时文件；请缩小筛选范围后重试。只有成功退出快照事务后，Worker 才完成 XLSX 压缩并发布文件；超时后迟到的回调不能发布产物。

快照只固定业务数据。Worker 的 Redis 任务身份、取消状态、关闭状态与 BullMQ lease 检查保持实时；取消/关闭会立即销毁正在使用的快照连接。权限沿用原契约：提交前与下载时检查当前 `asin:read`，不是每一页重新查询权限。授权撤销后的下载仍由实时权限检查拒绝。

导出业务快照不持有全局角色/权限管理锁，长时间读取期间管理员仍可更新授权。私有临时文件在每次底层 `write`/`writev` 前检查剩余容量；达到 256 MiB 后拒绝超限写入，停止快照并清理临时文件，完整校验和发布阶段继续复核大小与摘要。共享存储仍须按并发数和保留期配置总容量。

1. 用任务中心 `GET /api/v1/tasks/:taskId` 查看进度，或通过 `/ws` 任务通知订阅。`POST /api/v1/tasks/:taskId/cancel` 可请求取消。Redis EVAL 尚未发出时的连接失败返回错误，不生成任务 ID；明确的入队前拒绝将任务写为失败。EVAL 或入队提交结果未确认时，创建接口仍返回成功信封，`data.status=unknown` 且保留 `data.taskId`；Legacy 页面在首次状态查询暂不可用时最多重试 30 秒，若仍未确认则显示此 ID 并提示避免重复提交。若入队未成功，任务详情在 30 秒后确认 BullMQ 没有作业时将其写为失败。最终失败写入与取消请求并发时以取消为准。Legacy 页面等待自动下载超过 30 分钟时会提示任务继续在后台运行；用户可在任务中心继续查看并手动下载，任务不会被标为失败。
2. Worker 每页读取最多 50 个组，再按每页最多 5,000 个子 ASIN 逐组分页，按数据库原始微秒精度的创建时间和 ID 游标继续读取，避免并发插删使偏移页重复或遗漏。仅首批计算组数；实际写入行数受 100,000 行限制。导出保留 Legacy 的 15 列及组/ASIN 状态来源、人工异常原因；组状态来源由全组数据库状态计算，不随子 ASIN 分页变化。导出查询使用独立的 PostgreSQL 只读事务，单条 SQL 最长 60 秒、事务最长 65 秒；仍受单任务 30 分钟截止约束。写入期间文件名为 `export-<taskId>.<随机 UUID>.part`；完整校验后用硬链接原子发布为 `export-<taskId>.xlsx`。失败或取消删除本次临时文件，取消后若已发布最终文件也会立即删除；故障残留的失败/取消最终文件由周期清理回收。重复尝试复用已发布且校验通过的产物，不重复写入。下载文件名使用任务完成时的上海日期。
3. 任务完成后使用 `GET /api/v1/tasks/:taskId/download`。API 每次验证当前登录、任务所有者、`asin:read`、完成状态、任务绑定的文件标识/大小/SHA-256，之后通过流式响应发送文件；ASIN 文件的校验和传输共用 30 分钟时限，接口不接受客户端文件路径。
4. Worker 每分钟清理超过 `max(1 天, TASK_META_TTL_SECONDS)` 的临时文件，以及任务元数据和队列作业都已不存在的最终文件；超过一分钟且已确认失败/取消的最终文件也会清理。每轮两类清理各自批量上限为 100。共享卷应为 256 MiB 单文件限制和实际并发/保留量留足容量。监控导出失败、共享卷空间和清理警告。

## 验证与回滚

- 运行 `corepack pnpm --filter contracts test`、`corepack pnpm --filter export test`、`corepack pnpm --filter api test`、`corepack pnpm --filter worker test`、`corepack pnpm build:api`、`corepack pnpm build:worker`。隔离 PostgreSQL/Redis 集成测试需设置 `RUN_INTEGRATION_TESTS=true` 和仓库测试环境变量；API 集成测试使用编译后的 Worker 文件、独立 PostgreSQL schema、唯一 Redis 前缀及临时导出目录。
- 回滚时停止 API 创建此类型的 Neo 任务并停止 Neo `export` Worker，保留共享卷直到已创建任务的下载/保留期结束，再按任务元数据和队列状态清理。Legacy SSE 导出始终可用；没有数据库结构变化或数据回滚步骤。
