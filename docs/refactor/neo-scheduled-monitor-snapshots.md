# 定时监控完整成员快照与系统运行仓库

关联 #208，依赖 #204 的内部契约、CRC32/slot 政策和 `0016` 双库私有账本。这一层不注册 Worker，不创建 repeat job，不向公共任务中心索引 system 任务，也不启用生产调度。#188 后续连接业务检查、组事务回执、通知和竞品投递；#189 最后连接调度器。

## 首次受理与固定集合

`PgPrimaryScheduledMonitorRunRepository` 与 `PgCompetitorScheduledMonitorRunRepository` 各使用对应数据库连接。调用方拥有连接池；仓库关闭时只中断自己借用的事务，不关闭共享池。`assertReady()` 拒绝同时包含另一逻辑库商品表的目标，要求私有账本及本域商品表可访问。

`accept(job)` 验证严格 system actor、确定性 taskId/jobId 和全部不可变字段摘要。已有记录首先返回原快照；不会重新查询当前组或成员。相同 slot 身份但不同 requestedAt、保留期、country、batch 或 payload 会被拒绝。

首次新记录在有界 repeatable-read 事务内固定完整组与成员。原始 UTF-8 ID 不 trim、不改大小写、不 Unicode normalize；使用 #204 的 MySQL CRC32 原字节政策选批次，然后按原生 `create_time ASC NULLS FIRST,id COLLATE "C"` 固定 ordinal。所有业务时间保留 `YYYY-MM-DD HH:mm:ss.ffffff`，不能先经 Date 降为毫秒。主营保留人工异常、排除、通知开关及其原始元数据，后续检查可用原快照计算有效状态。

目录最多 1000 个选中组、20000 个成员、16 MiB JSONB。按 ID 分页最多扫描 100000 个同国家组；超限明确报错，不截断。读取完整组/成员后校验关系、国家、重复 ID、ordinal、顺序、CRC32、单组摘要及整次快照摘要。数据库 JSONB 的标点空格计入容量上界。

第一次超过 25 分钟或已到保留期的任务，只保存空目录的 `skipped-expired` 私有记录；先判断过期，随后才可能读取业务商品表。等于 25 分钟仍有效。旧 run 的原快照、完成结果与 child 身份仍可读取；读取收据与重新抓取属于不同操作。

## 运行状态与业务边界

- `pending` → `running`：必须仍新鲜、未过保留期、未请求取消。
- `pending/running` → `skipped-expired/cancelled/failed`：不改已有快照或业务历史；取消需要已持久化取消请求，过期结束需要确实过期。
- `running` → `business-completed`：要求每个固定 ordinal 都有相同 task/job/country/group/snapshot 的回执，原成员结果与总数一致，且回执结果可解析。取消请求阻止新的完成提交。
- `business-completed` → `completed`：只记录投递阶段完成；不受 25 分钟重新抓取门槛影响，不重新读取商品目录。

终态只允许同一终态的幂等重放。已提交主营业务后到达的取消请求返回原业务状态，不能改写已完成业务或生成新的竞品身份。

`completeBusiness(job,result,followUp)` 不创建业务回执。#188 的固定快照检查适配器必须在同一 PostgreSQL 事务里写业务状态、GROUP/ASIN 历史和私有 group receipt；不能先保存回执，再异步写历史。`scheduledMonitorGroupOperation()` 的稳定 key 绑定 task/ordinal，而 requestHash 绑定原 job、组 ID 与快照；替换输入只能与旧操作冲突，不能变成第二次成功写入。

`followUp=true` 只适用于 US 主营。仓库使用实际业务完成时间一次性构建严格 system competitor child，保留父 slot、interval、batch，完整保存 child payload、digest、requestedAt，与父 `business-completed` 在同一事务内提交。重放返回原 child，不能用当前时间重建。竞品或非 US 主营不能递归保存 child。保留期结束前无法构造有效 child 时拒绝新的完成边界，不能延长原任务 TTL。

后续消费者应先检查业务回执/完成边界，再判断是否还可以执行未提交组。已有 `business-completed` 只恢复原 child 的投递；Queue.add ACK 不明时只用同一个原 jobId/payload 对账或重投。通知 ACK 不明仍使用私有 claimed 收据待核实，不能盲目再次发送。

## 事务失败与隔离验证

每仓库最多 4 个操作，默认总时限 15 秒、单语句/锁等待 5 秒。每次事务使用局部限制，不改变共享池配置。连接取得、SQL、取消和关闭均纳入时限；迟到连接被销毁，容量槽直到该操作真正释放才归还。COMMIT 发出后的断连/取消/超时统一报告 `commit-uncertain`，不能证明回滚。

只对 PostgreSQL 明确拒绝的 serialization conflict，以及受理阶段的唯一键冲突，最多重新尝试 3 次 DB-only 事务。repeatable-read 的快照可能早于 advisory lock 等待，冲突后必须开启新事务；不能在旧快照下假定刚提交的 run 不存在。这里不包含外部请求，因此冲突重试不会重抓商品。

纯域测试覆盖原始 Unicode ID、六位微秒、固定成员/人工状态、污染、容量、批次和 child 摘要。事务测试覆盖时限、容量、迟到连接、取消、断连及不确定 COMMIT。真实 PostgreSQL 回归使用显式 `RUN_NEO_SCHEDULED_MONITOR_INTEGRATION=1`、两个不同 database 中随机私有 schema；只写自有 schema，结束时清理。缺少连接配置或连接失败会令已启用回归失败；未启用会明确 skip，不代表真实服务验收。

```sh
corepack pnpm --filter db exec vitest run test/scheduled-monitor-run.test.ts test/scheduled-monitor-transaction.test.ts --maxWorkers=1
corepack pnpm --filter db exec vitest run test/scheduled-monitor-run.integration.test.ts --no-file-parallelism
```

本层的仓库/收据读回不能替代 #188 的真实 BullMQ/Redis/双 PG 编译入口、业务事务故障注入和发送 ACK 丢失回归；生产数据对拍、旧 Bull drain 与 Legacy 退役门槛仍保持独立。
