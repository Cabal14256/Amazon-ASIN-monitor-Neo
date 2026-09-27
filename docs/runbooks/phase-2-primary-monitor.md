# Neo 主营手动监控（Issue #168）

`POST /api/v1/monitor/trigger` 只在 `AUTH_DATA_AUTHORITY=postgresql` 且当前用户拥有 `monitor:write` 时受理。body 可省略 `countries`（默认 US/UK/DE/FR/IT/ES），或提供六国中的任意非空组合；大小写和空白规范化，重复国家去重。成功返回真实 BullMQ `jobId`，本人可用任务中心查询和取消。未发现近 10 秒持续心跳的 monitor 消费者时返回 503，不创建任务。每个 API 实例同时最多处理 4 次提交；监控队列积压达到 50 个待处理、延迟或运行中的任务时返回 429。提交元数据已写而入队结果不确定时返回 500 与 `data.taskId`，先查询该 ID，勿直接重复提交。

## 升级与运行

先完成主库 `0004_asin_timestamp_policy.sql`、`0006_variant_check_receipts.sql`、飞书配置升级及 Neo 权威源阶段门禁。再执行 `npm run db:upgrade:primary-monitor`，只升级主营 PostgreSQL，创建 `primary_monitor_runs` 固定组快照、`primary_monitor_notifications` 投递声明，以及 `monitor_history.monitor_task_id`。Worker 在发布消费者心跳前检查这些对象，缺失则启动失败。生产仍遵守 #48 暂缓决定：本 Issue 不改代理流量、旧 Bull4 监控入口或调度；必须另行验收后才允许生产切换。

在隔离环境为 Worker 设置 `WORKER_ENABLED_QUEUES=monitor`、`AUTH_DATA_AUTHORITY=postgresql`。确认日志显示一个真实业务 Processor 且 Redis `${BULL_PREFIX}:neo:monitor:consumer:ready` 持续更新。Neo 使用独立 `${BULL_PREFIX}:neo`，不读取旧 Bull4 job。监控队列按既有策略最多三次、5 秒指数退避；每个任务最多固定 1000 个主营组，超过上限会失败且不会静默截断。组内共享 Catalog 检查仍由 SP-API 配额、fallback、容量和超时控制。国家依请求顺序串行处理，失败 ASIN 在同组落库前等待 2 秒后复核一次；状态、GROUP/ASIN 历史与回执同事务写入。任务进度通过已有 Redis 任务通知通道在提交后送往各 API WebSocket 实例。

组列表第一次执行时写入 PostgreSQL 快照；重试沿原顺序恢复，已提交的组从回执读取，不重抓、不重写历史。每国检查结束后发送飞书通知，11232 由共享通知模块退避最多三次，国家间隔 500 毫秒。发送前先在主库声明 `(task_id,country)`；已声明的国家不会重发。若进程在发送和结果落库之间停止，该国家显示 `unconfirmed`，需要人工对账；系统不会把无法判定的投递当作可安全重试。通知成功后同事务标记该任务、该国异常历史的 `notification_sent`。

运行中取消会在下一个租约/任务身份检查点停止；已经提交的组和历史保留。任务中心只向本人展示任务，队列结果在元数据写回失败时参与对账。角色/会话在提交时从 PostgreSQL 复核；任务受理后沿现有异步检查策略继续执行，但每个检查点核对不可变所有者、任务 incarnation、有效期、BullMQ 锁与取消标志。服务端只记录固定原因和数量，不输出商品请求、凭据或飞书 URL。

## 验证与回滚

- 本地：契约、API `monitor-trigger.test.ts`、Worker `primary-monitor-processor.test.ts`、DB/variant-check 单测，以及构建、格式和 `npm run test:api-url`。
- 隔离 Linux CI（`RUN_INTEGRATION_TESTS=true`，提供专用 PostgreSQL/Redis）：`packages/variant-check/test/repository.integration.test.ts` 验证组快照、事务历史和重试去重；`apps/worker/test/primary-monitor-entry.integration.test.ts` 启动编译后的 Worker，真实 BullMQ 消费六国请求并检查 PostgreSQL 记录。Windows 或缺少两项服务时测试明确跳过，不能视为集成已通过。
- 回滚先停止 Neo API 新入口和 monitor Worker，记录仍在途的 taskId、通知 `claimed` 状态并处理，避免删除回执后重放旧任务。确认不再需要 Neo 监控任务及其通知对账记录后，在主营库应用 `0012_primary_monitor.rollback.sql`；该脚本删除 Neo 运行快照/通知声明与 `monitor_task_id` 列，不删除既有监控历史、ASIN 或 Legacy 队列。不要在仍有 Neo job 可重试时执行回滚。

本 Issue 跨 contracts、API、Worker、DB、共享检查管线和运行手册，因为真实入队、原子持久化及消费去重必须同时交付；因此超过单 PR 的文件数/模块警戒线。它不包含定时调度、竞品监控、生产 drain 或生产切流。
