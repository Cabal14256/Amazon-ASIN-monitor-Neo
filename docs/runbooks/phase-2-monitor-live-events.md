# Neo 手动监控实时消息（Issue #252）

## 已实现范围

正式主线现有 `monitor` / `competitor-monitor` 手动消费者将业务消息发布到 Redis，任意 API 实例的 `/ws` 会广播给当前有效的已认证连接。`task_*` 继续仅发给任务所有者。所有消息批次使用网关原有当前会话复核；401 / 403 分别关闭为 4401 / 4403，依赖故障关闭为 1013。

这项修改不接管生产流量、定时任务、监控组准入或目录互斥；不声明全监控任务等价 Gate 通过。`stats_update` 在 Legacy 没有主动发送调用点，此处没有增加触发。

## Legacy 字段与节拍

参考 `server/src/services/monitorTaskRunner.js`、`competitorMonitorTaskRunner.js`、`deferredASINRetryService.js` 及 `utils/dateTime.js`：

| 阶段 | 消息与语义 |
| --- | --- |
| 开始 | `monitor_progress` / `started`，`countries`、手动任务 `batchInfo: null`、UTC+8 `timestamp`；竞品另有 `isCompetitor: true` |
| 主营进度 | 每国每第 10 个组及最后一组，在检查该组前发送 `current` / `total` / `Math.round(current/total*100)` |
| 竞品进度 | 每国每个组检查前发送，相同字段并含 `isCompetitor: true` |
| 完成 | 所有实际业务结果提交并且当前任务确认 `completed` 后发送 `monitor_complete`，真实 checked/broken/normal、两位小数秒数、完整国家摘要、UTC+8 时间及竞品标记 |

这是国家组级百分比；原任务中心的 5→90 全任务进度仍然独立。进度 100 表示该国最后一个组已开始，成功完成必须等待 `monitor_complete`。取消、失败、部分提交和最终 Redis 确认失败都不伪造成功完成广播。

国家摘要包含 `country`、`totalGroups`、`brokenGroups`、`brokenGroupNames`、`brokenGroupDetails`、`brokenASINs`、`brokenByType`、`asinClassifications`、`checkedGroupKeys`、`checkTime`。主营保留组与 ASIN 人工异常来源、原因和更新字段；竞品保留 Legacy 相应字段。分类按当前结果与 `MANUAL` / `AUTO+MANUAL` 来源计算；自动分类与人工分类不混计。

飞书开关只影响摘要内 Legacy 已经按开关选择的 `brokenASINs`，不会清除 brokenGroups、brokenGroupNames/details、分类或检查组列表。该公开摘要与现有通知候选、通知认领和任务结果分开构造；现有任务结果和飞书发送逻辑不变。外层时间为 `+08:00`，`checkTime` 保留 Legacy Date 经 JSON 序列化后的 UTC ISO 字符串。

## 发布与恢复

内部频道为 `<BULL_PREFIX>:neo:monitor:events`。Pub/Sub 只携带严格版本、任务 owner/type/subtype/createdAt/revision、slot 与 sequence 小提示，不能直接携带广播载荷。

Worker 在 Lua 内核对当前任务身份、revision、processing/completed 状态与取消标记，再保存严格有界事件证明并发提示。证明键为 `<BULL_PREFIX>:neo:monitor:proof:<encoded taskId>:<encoded createdAt>`，TTL 与任务元数据相同；仅保存 started、六国最新 progress、complete 八个槽和各槽高水位。Worker 重试使用相同阶段/国家序号，重复或倒退发布不会覆盖。各国的高水位独立，完成有单独容量。

API 原子读取前先检查任务 `STRLEN` 与证明 `HSTRLEN`，再验证严格 schema、提示与证明、不可变身份、状态以及完成结果各国家的真实计数。验证后才进入 authenticated-all 广播。每实例的监控消费者最多 8 个活跃读取、256 个待处理提示，seen 与阶段表各最多 4096 条；进行中的任务阶段记录被保留到读取完成。已验证 progress 后丢弃迟到 started；已验证 complete 后丢弃所有迟到 started/progress。

断连 generation 丢弃正在进行的旧读取并清空待处理。重连与 API 重启不回放历史提示。较新国家进度覆盖的旧提示也会安全丢弃。这是可丢失的实时提醒，不承诺消息 exactly-once；任务 HTTP 查询和监控历史是恢复来源。若最终业务已完成而任务 Redis ACK 尚待对账，现有任务查询可以恢复结果，此处不会提前发成功广播。

## 容量与日志

完整完成消息遵守既有 WebSocket 1 MiB 预算；内部证明另留 2 KiB 身份开销。started/progress 以及提示最多 4 KiB，每国进度槽不能耗尽完成容量。序列化按实际转义 JSON 字节计数，超预算在深层 schema 检查前拒绝。网关原有 32 条/1 MiB 缓冲和 8 个认证并发保持。

摘要收集按新增数组/分类项的转义 JSON 字节增量记账，超过 1 MiB 时释放整个 WS 摘要并拒绝该次完成消息，避免通知关闭时仍积累无界分类；不截断数组、删字段或把省略后的消息声明为 Legacy 完成等价。超限发脱敏 `monitor_event_capacity` warning；网络或格式失败发 `monitor_event_unconfirmed` warning。已提交监控结果与原飞书处理不因实时提醒失败被重分类。通过历史/任务查询查看结果，并缩小手动监控范围。日志不输出任务 payload、通知内容、Token 或异常原始对象。

## 验证命令

从根目录使用根 lockfile：

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm --filter db build
corepack pnpm --filter worker build
corepack pnpm --filter api build
corepack pnpm --filter db exec vitest run test/monitor-events.test.ts --maxWorkers=1
corepack pnpm --filter worker exec vitest run test/monitor-live-events.test.ts test/primary-monitor-processor.test.ts test/competitor-monitor-processor.test.ts --maxWorkers=1
corepack pnpm --filter api exec vitest run test/monitor-notification-consumer.test.ts test/task-notification-consumer.test.ts test/redis-websocket-events.test.ts test/websocket.test.ts --maxWorkers=1
```

原业务处理器字节的复现是新增两例确实失败（收到 0 条业务发布），41 个既有健康控制通过，然后才修改产品源码。记录见本次 PR 验证附件；仓库不提交本机运行日志。

已有 Integration job 显式运行 `test/task-websocket.integration.test.ts`，并先构建 Worker。使用真实独立 PostgreSQL 数据库、Redis/BullMQ、编译 Worker 及两个 API 实例，测试主营 11 组的 10/11 节拍、竞品 3 组的每组节拍、完整完成摘要、当前接收方会话撤销、外国已认证用户的业务广播与任务所有者隔离，另测坏/超限 hint、无证明、重复/取消/替换身份、1000 次进度后约 600 KiB 完整完成及超 1 MiB 拒绝。

```sh
RUN_INTEGRATION_TESTS=true corepack pnpm --filter api exec vitest run test/task-websocket.integration.test.ts --maxWorkers=1
```

本机不具备 PostgreSQL/Redis 服务时必须记为未运行；opt-in skip 不是 native PASS。编译 Worker 用例在 Windows 明确 skip，需在 Linux Integration job 实际执行并检查计数。最终 head 的 CI / Review 结果记录于 PR，本文不把准备好的 fixture 当作已经通过的运行结果。

## 回滚

停止本次 Neo 手动监控 Worker 后回滚本次 API/Worker/共享 DB 包代码并重新构建。没有数据库迁移或公开协议变更。新 Redis 证明有任务 TTL，不必进行无界扫描或删除共享命名空间；可以等待自动过期。原 `task_*`、HTTP 查询、Legacy 生产路径继续按既有配置工作。
