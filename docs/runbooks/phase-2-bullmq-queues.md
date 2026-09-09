# P2-T2a：Neo 队列策略与接入边界

八类 Queue 策略已完成；PostgreSQL 权威源下，入口现已注册认证维护及[主营批量删除](./phase-2-asin-batch-delete.md)的真实 Processor。其余七类业务队列仍只创建 Queue 资源，不消费任务，不能将看门狗健康等同于业务迁移完成。已注册业务入口显示 `mode=business-worker` 和实际处理器数；纯骨架选择仍显示 queue-scaffold。后续域需验证 payload 后接入实际 Processor，不允许用空回调完成任务。

## 八类队列基线

以下值来自 `server/src/services/*TaskQueue.js`，测试在无网络 VM 中执行旧队列注册并与 Neo 对照。保留时间单位为秒；所有重试退避均为 exponential 5000ms，batch-delete 仅一次尝试、无退避。

| 选择器 | 物理名称 | 尝试次数 | 成功/失败保留 | 限速 | 并发变量（默认 1） |
| --- | --- | --: | --- | --- | --- |
| monitor | monitor-task-queue | 3 | 3600 / 86400 | 1 / 200ms | MONITOR_QUEUE_WORKER_CONCURRENCY |
| competitor-monitor | competitor-monitor-task-queue | 3 | 3600 / 86400 | 1 / 200ms | COMPETITOR_QUEUE_WORKER_CONCURRENCY |
| export | export-task-queue | 2 | 86400 / 604800 | 1 / 500ms | EXPORT_QUEUE_WORKER_CONCURRENCY |
| import | import-task-queue | 2 | 3600 / 86400 | 1 / 1000ms | 固定 1，Legacy 无覆盖变量 |
| batch-check | batch-check-task-queue | 2 | 3600 / 86400 | 1 / 1000ms | BATCH_CHECK_QUEUE_WORKER_CONCURRENCY |
| batch-delete | batch-delete-task-queue | 1 | 3600 / 86400 | 1 / 1000ms | BATCH_DELETE_QUEUE_WORKER_CONCURRENCY |
| backup | backup-task-queue | 2 | 3600 / 86400 | 1 / 2000ms | BACKUP_QUEUE_WORKER_CONCURRENCY |
| variant-check | variant-check-task-queue | 2 | 3600 / 86400 | 1 / 500ms | VARIANT_CHECK_QUEUE_WORKER_CONCURRENCY |

监控两队列可用 `MONITOR_QUEUE_LIMITER_MAX` / `MONITOR_QUEUE_LIMITER_DURATION_MS` 和对应 `COMPETITOR_` 变量覆盖。并发沿用 Legacy 的有限正数向下取整、最小 1、无效/非正数回退 1；限速缺失、0 或非数值回退默认，负值或非整数明确拒绝启动。

BullMQ 的 `limiter` 配置属于 Worker，跨同队列多个 Worker 共用；`defaultJobOptions` 的 attempts/backoff/retention 配置属于 Queue。年龄清理是后续任务完成/失败时触发的惰性清理，并非独立 TTL 定时器。[限速文档](https://docs.bullmq.io/guide/rate-limiting)、[保留策略文档](https://docs.bullmq.io/guide/queues/auto-removal-of-jobs)。

## 新旧隔离与回滚

- Legacy 保持 `BULL_PREFIX`，Neo 固定使用 `${BULL_PREFIX}:neo`，例如 `bull:neo:export-task-queue:*`。API Producer 与 Worker 必须通过相同配置函数构造 key，不得各自拼接。
- 切换前暂停旧调度和生产者，等待旧队列活跃/等待/延迟任务处理完毕，记录失败任务处置；不得复制 Redis 旧 Bull job/hash/list 到 BullMQ。
- 再验收迁移后的 Processor、task meta/用户索引/7d TTL、取消、调度单实例、幂等和新旧 fixture 产物等价；验收完成后才能按域启动 Neo 生产者/消费者。
- 仅已验收的域可启用实际消费，剩余业务能力继续迁移。`WORKER_ENABLED_QUEUES` 的 none/off 不创建资源，空串/只有逗号视为 all；旧选择器别名继续可用。
- 回滚先停 Neo 生产者/调度，处理或明确记录 Neo 在途任务，然后切回 Legacy。不能把 Neo 等待任务当作旧 Bull 队列继续消费；不要删除任何生产 Redis key。

## 验证

Worker 的 `test` 命令会先构建工作区依赖，确保使用当前分支的 config/contracts 导出，避免切换分支后读取旧 dist 导致并发和限速配置缺失；无需先手工执行其他包的测试。

`corepack pnpm --filter worker test` 对照 8 类旧队列策略、选择器与预检。显式 `RUN_INTEGRATION_TESTS=true` 时运行 `corepack pnpm --filter worker exec vitest run test/queue-policy.integration.test.ts`，在随机 fixture 前缀内启动两名真实 BullMQ Worker，验证跨 Worker 限速、5 秒退避重试、结果保留和 Legacy key 不变；清理仅限该随机前缀，绝不 FLUSHDB。
