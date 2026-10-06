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

业务完成边界同时复核每张收据完成时间在原任务创建与本次完成时间之间，并在实际 UPDATE 中用数据库 `clock_timestamp()` 检查保留期。先前读到未过期不能使跨越保留期后的写入继续成功；该失败回滚新完成边界，保留原组收据以供对账。

`followUp=true` 只适用于 US 主营。仓库使用实际业务完成时间一次性构建严格 system competitor child，保留父 slot、interval、batch，完整保存 child payload、digest、requestedAt，与父 `business-completed` 在同一事务内提交。child 的 requestedAt 和 createdAt 必须精确等于原 businessCompletedAt，expiresAt 必须等于父值；即使替换后的 payload 和 digest 相互匹配，也不能刷新时钟或更改 TTL。重放返回原 child，不能用当前时间重建。竞品或非 US 主营不能递归保存 child。保留期结束前无法构造有效 child 时拒绝新的完成边界，不能延长原任务 TTL。

后续消费者应先检查业务回执/完成边界，再判断是否还可以执行未提交组。已有 `business-completed` 只恢复原 child 的投递；Queue.add ACK 不明时只用同一个原 jobId/payload 对账或重投。通知 ACK 不明仍使用私有 claimed 收据待核实，不能盲目再次发送。

## 事务失败与隔离验证

每仓库最多 4 个操作，每次事务默认总时限 15 秒、单语句/锁等待 5 秒。每次事务使用局部限制，不改变共享池配置。连接取得、SQL、取消和关闭均纳入时限；迟到连接被销毁，容量槽直到该操作真正释放才归还。COMMIT 发出后的断连/取消/超时统一报告 `commit-uncertain`，不能证明回滚。

只对 PostgreSQL 明确拒绝的 serialization conflict，以及受理阶段的唯一键冲突，最多重新尝试 3 次 DB-only 事务。repeatable-read 的快照可能早于 advisory lock 等待，冲突后必须开启新事务；不能在旧快照下假定刚提交的 run 不存在。这里不包含外部请求，因此冲突重试不会重抓商品。

纯域测试覆盖原始 Unicode ID、六位微秒、固定成员/人工状态、污染、容量、批次和 child 摘要。事务测试覆盖时限、容量、迟到连接、取消、断连及不确定 COMMIT。真实 PostgreSQL 回归使用显式 `RUN_NEO_SCHEDULED_MONITOR_INTEGRATION=1`、两个不同 database 中随机私有 schema；只写自有 schema，结束时清理。缺少连接配置或连接失败会令已启用回归失败；未启用会明确 skip，不代表真实服务验收。

```sh
corepack pnpm --filter db exec vitest run test/scheduled-monitor-run.test.ts test/scheduled-monitor-transaction.test.ts --maxWorkers=1
corepack pnpm --filter db exec vitest run test/scheduled-monitor-run.integration.test.ts --no-file-parallelism
```

本层的仓库/收据读回不能替代 #188 的真实 BullMQ/Redis/双 PG 编译入口、业务事务故障注入和发送 ACK 丢失回归；生产数据对拍、旧 Bull drain 与 Legacy 退役门槛仍保持独立。

## Producer、source 与消费者接续边界

`actor.kind=system` 是内部任务身份字段，不是独立的鉴权凭据。只有受信任的服务调度/续接路径可产生此类任务；Redis 队列访问、Worker 选择与服务数据库连接仍需使用内部部署边界。普通 HTTP 用户不能通过提交 `source`、`actor` 或 `taskType` 字段调用本仓库，也不能让现有手动任务接口把用户输入转成 scheduled 任务。scheduled 身份不能写入普通用户的任务索引、任务分页或公共 WS task room。

首次 payload 来自 #189 的当前计划 slot 和实际首次投递时钟。消费者验证严格契约、确定性 jobId/taskId 和已持久化摘要；重试次数、进程重启、配置热更新均不能改变 `plannedSlot/requestedAt/createdAt/expiresAt`、country、interval 或 batch。严格解析失败时，freshness helper 的 Bull timestamp fallback 不会把伪造或不完整 payload 变成有效 scheduled 身份。

Producer 的 Queue.add ACK 丢失后，应先取回同一稳定 jobId 的原 Bull payload，或使用已经持久化的原 producer intent；无法确认时先停止投递并等待恢复。不能以新 requestedAt 再构造同 slot 的替代 payload，也不能调用 `accept()` 来提前冻结目录并充当 producer outbox。该方法只在消费者首次执行受理时固定业务集合。#208 的 `read(job)` 要求完整原身份；尚未提供仅凭 slot 找回 producer intent 的接口，#189 需处理首次投递与 ACK 不确定性的持久化安排。

US 竞品 child 的稳定身份与相同 slot/country/batch 的独立 competitor scheduled 任务会占用同一命名空间。#189 应让 US 主营完成路径成为该 child 的唯一 producer；不能同时用独立 US 竞品 scheduler 重建同一个 child。若以后确需两个独立来源，必须先升级契约和身份命名空间，不得删除旧 job、覆盖原 payload 或放宽 job digest 冲突校验。

后续 #188 的固定组入口应接收仓库读回的 `ScheduledMonitorGroupSnapshot` 和由它生成的 `ScheduledMonitorGroupOperation`。网络检查遍历该快照的成员；不能把原 groupId 交给现有 `checkGroup(groupId)` 后重新加载实时成员。组/成员在执行期间被删除、重建、移动或不再满足原身份时，提交失败并保留原快照；不允许修改 run 快照、吸收新成员或自动用新目录重抓。

同一组业务事务的锁顺序为 scheduled run advisory/行锁 → ordinal 回执锁 → 业务组 → 按原始 ID 排序的成员。取消、组写入和完成边界都先核对相同 run 身份；组状态、成员状态、GROUP/ASIN 历史与原 ordinal 回执在同一次 COMMIT 内落库。外部请求不持有 SQL 事务或这些业务锁。

恢复处理先查原 operation 收据：已提交组只回放原结果，不能重新请求 SP-API/HTML 或再写历史。未提交组必须仍新鲜才可开始外部检查，提交前再检查 lease/取消/新鲜度；新鲜度已过的余下组不得继续抓取。全部组已经提交但父完成标记尚未确认时，可用原收据恢复 `completeBusiness()`，不刷新父时钟。已有 `business-completed` 则只恢复原 child 的投递，再调用 `complete()`；不能走 `start()` 重开业务。

`commit-uncertain` 必须先用原 operation 读回数据库收据。有效收据允许恢复原结果；收据损坏或读取不可用必须明确报告待核实，不能据此判断此前 COMMIT 失败并重抓。以上为后续接口与事务纪律，本次没有实现业务检查适配器、group receipt 写入、Worker dispatcher 或真实外部调用。

## 给 #188 的接口与尚未实现的执行能力

| 本层接口 | #188 调用边界 | 当前实现范围 |
| --- | --- | --- |
| `accept(job)` / `read(job)` | 首次受理，或用完整原身份恢复 | 固定全组/成员和原摘要，不含 producer intent/slot 查询 |
| `start(job)` | 未提交业务开始前 | 取消、25 分钟和 TTL 校验；没有 Bull lease ownership 校验 |
| `ScheduledMonitorGroupSnapshot` / `scheduledMonitorGroupOperation(job,group)` | 固定成员网络检查和同 ordinal 提交 | 完整目录和稳定操作身份；没有外部检查或 receipt 读写适配器 |
| `requestCancellation()` / `finishWithoutBusiness()` | 持久化取消意图、结束未完成业务 | 私有 run 状态；未连接 Worker shutdown 或公共取消接口 |
| `completeBusiness(job,result,followUp)` | 全部原组 receipt 已提交后的完成边界 | 复核收据/汇总，一次保存原 US child；未发通知或入队 |
| `complete(job)` | 原 child 投递已经确认后 | 幂等保存投递完成状态；未核验 Redis ACK |

#188 还需实现同数据库的固定组 receipt 读取与业务提交适配器，并把 lease ownership、取消和新鲜度复核放入每组提交边界。网络检查、状态更新和 GROUP/ASIN 历史不得借用现有要求 userId 的手动 operation 契约伪造用户。Worker dispatcher 只接严格内部身份；REST 分页/详情与 WS 发布必须继续拒绝或过滤 system 任务，并补实际队列入口的隐藏回归。本层未注册到这些入口，不能将私有仓库已实现描述为实际执行恢复已完成。

首次 producer intent 持久化、相同 slot 的原 payload 找回和 Queue.add ACK 未知结果对账属于 #189。父业务完成与原 child payload 已在本层同事务持久化，为 #188 后续续投提供来源；首次 scheduler 投递尚没有这类 outbox。两类入队来源都必须等待明确恢复证据，不能创建新身份绕过不确定状态。
