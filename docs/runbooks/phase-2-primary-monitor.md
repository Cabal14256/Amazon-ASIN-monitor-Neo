# Neo 主营手动监控（Issue #168）

`POST /api/v1/monitor/trigger` 只在 `AUTH_DATA_AUTHORITY=postgresql` 且当前用户拥有 `monitor:write` 时受理。body 可省略 `countries`（默认 US/UK/DE/FR/IT/ES），或提供六国中的任意非空组合；大小写和空白规范化，重复国家去重。成功返回真实 BullMQ `jobId`，本人可用任务中心查询和取消。未发现近 10 秒持续心跳的 monitor 消费者时返回 503，不创建任务。每个 API 实例同时最多处理 4 次提交；多个 API 实例在同一 Redis 准入租约内核对容量并入队，监控队列积压达到 50 个待处理、延迟或运行中的任务时返回 429。租约等待最多 1.5 秒，持锁期间续租并在入队前后验证所有权。提交元数据已写而入队结果不确定时返回 500 与 `data.taskId`，先查询该 ID，勿直接重复提交。

若入队前的第二次消费者或队列容量检查明确拒绝，服务会把已创建的任务元数据标为失败，再返回 503/429；如果状态写入未确认，则仍返回任务 ID 供对账。

## 升级与运行

先完成主库 `0004_asin_timestamp_policy.sql`、`0006_variant_check_receipts.sql`、飞书配置升级及 Neo 权威源阶段门禁。再执行 `npm run db:upgrade:primary-monitor`，只升级主营 PostgreSQL，创建 `primary_monitor_runs` 固定组快照、`primary_monitor_notifications` 投递声明，以及 `monitor_history.monitor_task_id`。Worker 在发布消费者心跳前检查这些对象，缺失则启动失败。生产仍遵守 #48 暂缓决定：本 Issue 不改代理流量、旧 Bull4 监控入口或调度；必须另行验收后才允许生产切换。

在隔离环境为 Worker 设置 `WORKER_ENABLED_QUEUES=monitor`、`AUTH_DATA_AUTHORITY=postgresql`。确认日志显示一个真实业务 Processor 且 Redis `${BULL_PREFIX}:neo:monitor:consumer:ready` 持续更新。Neo 使用独立 `${BULL_PREFIX}:neo`，不读取旧 Bull4 job。监控队列按既有策略最多三次、5 秒指数退避；每个任务最多固定 1000 个主营组，超过上限会失败且不会静默截断。组内共享 Catalog 检查仍由 SP-API 配额、fallback、容量和超时控制。国家依请求顺序串行处理，失败 ASIN 在同组落库前等待 2 秒后复核一次；状态、GROUP/ASIN 历史与回执同事务写入。任务进度通过已有 Redis 任务通知通道在提交后送往各 API WebSocket 实例。

多个 monitor Worker 各持独立 10 秒心跳租约，以 Redis 时钟续租；共享 ready 标记随最后一个有效租约到期。正常退出先停止续租并原子释放本实例租约，其他有效消费者继续可用，最后一个退出则立即撤销 ready。刷新中的请求先确认结束再释放，避免迟到心跳重新发布已停止的消费者；Redis 不可用时记录固定 warn 原因并等待原租约到期。

组列表第一次执行时写入 PostgreSQL 快照；重试沿原顺序恢复，已提交的组从回执读取，不重抓、不重写历史。ASIN 历史保留 Legacy 分类：自动检查正常而自身或继承组手动异常时记为 `MANUAL_MARKED`；存在自动错误时保留自动错误，排除继承标记的正常 ASIN 不记手动异常。每国检查结束后发送飞书通知，11232 由共享通知模块退避最多三次，国家间隔 500 毫秒。所有国家在声明投递前同时验证原始摘要与渲染后的卡片；包含国家名称、ASIN Markdown 链接的最终 JSON 不得超过 1 MiB，超限会明确失败且不声明任何国家，不静默截断。发送前先在主库声明 `(task_id,country)`；已声明的国家不会重发。若进程在发送和结果落库之间停止，该国家显示 `unconfirmed`，需要人工对账；系统不会把无法判定的投递当作可安全重试。通知成功后同事务标记该任务、该国异常历史的 `notification_sent`。

声明国家投递前，先取得当前通知实例共享的发送容量（所有发送方式合计最多 4 个）；监控并发超过该值时，未取得容量的尝试不会写入声明或发出请求，沿 BullMQ 退避重试。取得容量后声明与发送使用同一个槽，保持未知投递不重发的规则，不提高飞书发送上限。

运行中取消会在下一个租约/任务身份检查点停止；已经提交的组和历史保留。最终完成与取消使用 Redis CAS：已接受的取消不会被随后完成写入覆盖。全部组和国家通知处理完毕后，如最后一次 Redis 完成写入暂时失败，Worker 将结果交给 BullMQ，任务中心从已完成队列任务对账，不把已完成业务误记为失败。任务中心只向本人展示任务，队列结果在元数据写回失败时参与对账。角色/会话在提交时从 PostgreSQL 复核；任务受理后沿现有异步检查策略继续执行，但每个检查点核对不可变所有者、任务 incarnation、有效期、BullMQ 锁与取消标志。服务端只记录固定原因和数量，不输出商品请求、凭据或飞书 URL。

监控成功和失败队列凭据都至少保留 7 天；当 `TASK_META_TTL_SECONDS` 更长时按该值保留（环境配置上限 365 天），不设置数量清理上限，避免最后一次 Redis 元数据写入失败后终态凭据先于任务过期。BullMQ 在后续任务完成或失败时按年龄清理对应终态，不无限保留。API 与 Worker 共用该策略；部署前已入队或已结束的任务保留其原有入队策略，应先查询对账并排空，再升级。旧数据允许变体组名称为空字符串，监控仍检查并发送通知；任务中心在 API 返回 `canCancel=true` 时允许取消等待或运行中的监控任务，已完成或已取消的任务不显示取消入口。

## 验证与回滚

- 本地：契约、API `monitor-trigger.test.ts`、Worker `primary-monitor-processor.test.ts`、DB/variant-check 单测，以及构建、格式和 `npm run test:api-url`。
- 隔离 Linux CI（`RUN_INTEGRATION_TESTS=true`，提供专用 PostgreSQL/Redis）：`packages/variant-check/test/repository.integration.test.ts` 验证组快照、事务历史和重试去重；`apps/worker/test/primary-monitor-entry.integration.test.ts` 启动编译后的 Worker，真实 BullMQ 消费六国请求并检查 PostgreSQL 记录；`apps/api/test/task-query.integration.test.ts` 用两个独立 API runtime 争最后一个监控队列名额。Windows 或缺少两项服务时测试明确跳过，不能视为集成已通过。
- 回滚先停止 Neo API 新入口和 monitor Worker，记录仍在途的 taskId、通知 `claimed` 状态并处理，避免删除回执后重放旧任务。确认不再需要 Neo 监控任务及其通知对账记录后，在主营库应用 `0012_primary_monitor.rollback.sql`；该脚本删除 Neo 运行快照/通知声明与 `monitor_task_id` 列，不删除既有监控历史、ASIN 或 Legacy 队列。不要在仍有 Neo job 可重试时执行回滚。

本 Issue 跨 contracts、API、Worker、DB、共享检查管线和运行手册，因为真实入队、原子持久化及消费去重必须同时交付；因此超过单 PR 的文件数/模块警戒线。它不包含定时调度、竞品监控、生产 drain 或生产切流。
