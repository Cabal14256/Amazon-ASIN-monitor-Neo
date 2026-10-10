# Neo 监控组检查准入（Refs #188）

本片段接通 `MONITOR_MAX_CONCURRENT_GROUP_CHECKS` 与现有 SP-API 风控策略，让同一个 Neo Worker runtime 的主营和竞品监控消费者共享组检查准入。它是 #188 的一个独立片段，PR 使用 `Refs #188`，不能使用 `Closes #188`。定时任务系统身份、首次固定集合、组收据恢复、25 分钟过期判断、US 原始 child 投递和故障重启链路仍需后续片段完成；#189 才处理业务调度器。本片段不注册 scheduled processor 或 repeat job，不启用生产 scheduler，不改变 #48 的生产暂停决定。

## 运行范围

`startVariantCheckRuntime` 在选择 `monitor` 或 `competitor-monitor` 时创建一个 `MonitorGroupAdmission`，先初始化再注册消费者，两个现有手动监控 processor 注入同一实例。各 pipeline 在读取业务组或调用检查器之前申请许可；等待期间与取得许可之后复核原任务身份、取消状态和现有检查点。普通 `variant-check` / `batch-check` 和同步 API 调用不使用此监控组门禁。

这是进程内的组并发限制。同一 Worker runtime 的两个监控队列共享上限；不同 Worker 进程和副本各自持有门禁，不能把这个数字当作集群总上限。BullMQ 的队列 job concurrency、Redis SP-API 配额、单 pipeline 的 8 个活动调用上限和此门禁各自继续生效。两个监控 processor 的既有每任务串行组循环保留；要在隔离 fixture 验证跨域并发，必须让多个队列任务实际同时运行。

许可由 pipeline 的真实 work 生命周期持有，直到检查、事务或其他底层 I/O 实际 settle 才释放。调用者已观察到取消、超时或关停也不会提前释放仍在运行的物理操作。release 幂等；关停阻止新申请、拒绝等待者，并保留已运行工作的计数到实际结束。

## 配置与恢复

| 配置 | 来源 / 默认值 | 行为 |
| --- | --- | --- |
| `MONITOR_MAX_CONCURRENT_GROUP_CHECKS` | 主库 `sp_api_config` 同名键；缺失时使用环境默认 3 | 每 5 秒成功刷新一次，作为启动或配置变化后的准入基准；有效值再受部署上限和 pipeline 上限 8 约束 |
| `MAX_ALLOWED_CONCURRENT_GROUP_CHECKS` | 现有部署环境值，默认 10 | 只作为部署上限；缩小上限不抢占已经运行的组 |
| `AUTO_ADJUST_CONCURRENCY` | 环境布尔值，默认 true | 在申请准入时调用既有风控计算；相同 DB 配置重读不会重置已经调整的上限 |

环境组并发值保留数字 fallback / 向下取整行为，并限制到 1–8。DB 值要求正整数字符串；重复同名键、非法配置、读取失败或超过 2 秒的读取使用保守上限 1，停止风控调整，记录固定 warn 原因。失败刷新按 5 / 10 / 20 / 30 秒有界退避；成功后恢复正常刷新。超时只释放调用方的等待，不释放尚未 settle 的物理配置读取槽；迟到结果不能恢复上限或并发启动另一次配置读取。

自动调整启用时，现有风控可在基准之上增减实际准入数量，最终仍受部署上限和 8 组上限约束；DB 数字不是自动调整后的额外硬上限。相同有效配置的下一次读取保留风险调整结果，显式配置变化或从失败状态恢复才重设基准。本原生 fixture 关闭自动调整，以单独证明 DB 1→2 的热更新边界；风险算法与上限的单元结果不能用于宣称原生动态风控吞吐已验收。

配置缩小时保留已运行组，等活动数量低于新上限后才发出新的许可；配置增大时按 FIFO 唤醒已通过检查点的等待者。最多 100 个等待者、16 个同时进行的等待检查点，每个等待最多 30 秒；取消、检查点拒绝、等待超时和关停均移除等待身份，不启动其组检查。每秒再次核对等待者的检查点，不改变已经受理任务的目标、创建时间或不可变身份。

## 原生 fixture 与 CI

现有 `apps/worker/test/competitor-monitor-entry.integration.test.ts` 新增双消费者场景：主库配置先为 1，编译后 Worker 同时启用 `monitor,competitor-monitor`，两个 queue job concurrency 均为 2，环境值故意为 7。先让竞品组占用，再受理两个主营任务，验证主库值 1 使主营等待；将 DB 值更新为 2 后验证两个域的合计活动组最多为 2、全部真实任务完成，核对双库历史、组收据、Redis 元数据与正常退出后的心跳删除。

该 fixture 使用真实 Linux 编译入口、BullMQ / Redis 与两个独立 PostgreSQL database 的私有 schema。Catalog 固定响应预热到真实 Redis cache，延迟只注入在 `CatalogVariantChecker.check` 返回缓存结果之后；真实 pipeline 入口、授权、SQL / COMMIT 和收据路径继续执行。它证明进程内准入和记录边界，不是外部真实 SP-API 吞吐或性能验收。只允许 loopback 通知 HTTP，其他 transport 目的地明确拒绝，不联系 Amazon 或真实飞书。`SCHEDULER_ENABLED=false` 明确传给测试子进程。

`.github/workflows/integration.yml` 已有 Linux step 执行该完整文件：

```sh
pnpm --filter @asin-monitor/worker exec vitest run test/competitor-monitor-entry.integration.test.ts --maxWorkers=1
```

Integration job 提供 `RUN_INTEGRATION_TESTS=true`、Redis 7、PostgreSQL 16 / Timescale 和独立竞品 database，并在之前构建 Worker。当前 Windows fixture 明确 skip；本地单元或 mock 通过不能替代该最新提交的 Linux CI 原生结果。原生场景必须在 CI 真正执行且通过后再记录其结果。

## 本轮验证记录

以下结果来自原实现 runner 的 2026-10-10 工具终端交接，没有持久化日志。本轮最终审查只读核对实现和 CI 接线，没有重跑这些命令，不构造不存在的日志路径。

| 命令 | 已确认结果 / 限制 |
| --- | --- |
| `corepack pnpm --filter config exec vitest run --maxWorkers=1` | 42 passed |
| `corepack pnpm --filter variant-check exec vitest run --maxWorkers=1` | 120 passed / 21 native integration skipped |
| `corepack pnpm --filter worker exec vitest run test/monitor-group-admission.test.ts test/primary-monitor-processor.test.ts test/competitor-monitor-processor.test.ts test/competitor-monitor-entry.integration.test.ts --maxWorkers=1` | 49 passed / 16 native integration skipped；后续三个单元文件再跑 49/49 |
| `corepack pnpm --filter @asin-monitor/worker... build`、`corepack pnpm --filter worker build`、`corepack pnpm --filter worker typecheck` | 均通过；产品代码未在此后改变 |
| `corepack pnpm --filter variant-check exec tsc -p tsconfig.test.json --pretty false` | 通过 |
| 下列显式 strict 命令 | 早期 fixture 版本两次通过；最终 checker 外 delay 与 US / DE cache fixture 修改后重跑发生 Node `ZoneAllocation` OOM，exit 1。最终 fixture strict 未确认通过，必须重新执行 |

```sh
corepack pnpm exec tsc --noEmit --strict --skipLibCheck --target ES2022 --module commonjs --moduleResolution node --esModuleInterop --types node --lib ES2022,DOM apps/worker/src/monitor-group-admission.ts apps/worker/test/monitor-group-admission.test.ts apps/worker/test/competitor-monitor-entry.integration.test.ts
```

原生执行在本机没有完成；Windows skip 与 OOM 不能登记为通过。主任务应在单 runner 窗口补最终 strict、相关测试、格式与仓库所需检查，推送后等待最新 CI；完整基线未由本轮只读审查执行，应在 PR `验证` 中逐项列出未执行命令与原因。

## 回滚

此片段不增加数据库迁移。停止 Neo Worker 并等待在途组实际结束后回滚本片段代码，可恢复此前手动监控执行行为；保留原 BullMQ job、任务元数据、业务历史、组收据和通知声明供对账，不删除记录来逃避未知执行结果。配置键保留不影响旧 Legacy 路径；如调整生产进程数，必须重新评估每进程限制和总配额，不能按单实例门禁宣称生产并发 gate 已通过。
