# P2 / D4 认证维护 Worker 与调度

## 启用前提与范围

先完成[数据层运行说明](./phase-2-auth-maintenance-data.md)中的最终 Legacy 冻结快照导入、`0003` 升级和对拍，再部署 API 与 Worker。Worker 启动会检查会话表、归档父表和冷热统一视图；数据库或迁移不可用时以固定错误退出，不能当作维护已启用。数据库角色需要分区创建和挂接权限。

本次在实际 `apps/worker/src/main.ts` 入口注册一个认证维护 Processor，处理会话清理、审计归档两类任务。原八个业务队列继续保留名称和策略，业务 Processor 仍需按 P2-T2 逐域迁入；本次不代表监控、备份、分析等通用调度已经完成，也不自动操作生产环境。

在仓库根目录使用根锁文件安装依赖并执行：

```sh
corepack pnpm --filter @asin-monitor/worker^... build
corepack pnpm build:worker
corepack pnpm --filter worker start
```

由部署环境提供 `PROCESS_ROLE=worker`、`AUTH_DATA_AUTHORITY=postgresql`、正确的 `DATABASE_URL` / `REDIS_URL` / `BULL_PREFIX` 和其余必需配置。不要把连接凭据复制到命令日志。维护专用实例使用 `WORKER_ENABLED_QUEUES=maintenance`；负责安装计划的实例设 `SCHEDULER_ENABLED=true`，其他维护消费者可为 false。部署后的启动日志应包含 `mode: auth-maintenance`、`registeredProcessors: 1`，专用实例 `queueCount: 1`。

| 队列选择                            | 行为                                 |
| ----------------------------------- | ------------------------------------ |
| 未配置、空白、`all`、`*`            | 原八个业务队列加认证维护             |
| `maintenance` 或 `auth-maintenance` | 仅认证维护，不回退到全部业务队列     |
| `monitor,maintenance` 等显式组合    | 所选业务队列加认证维护               |
| 仅业务队列子集                      | 不隐式启用认证维护                   |
| 仅 `none` / `off`                   | 完全空闲，不连接 Redis 或 PostgreSQL |

认证权威源仍为 `legacy-mysql` 时跳过维护，既不创建 PostgreSQL 维护池，也不安装这两项计划。只选择 maintenance 的 Legacy 实例保持空闲，直到收到停止信号。

## 计划、互斥与重试

物理队列为 `auth-maintenance-queue`，Redis 前缀为 `${BULL_PREFIX}:neo`，与 Legacy Bull 数据隔离。任务数据只允许 `{ "schemaVersion": 1 }`，操作只允许以下两种；不接受保留天数、SQL、表名或任意批量大小。

| 稳定计划 ID            | 操作              | Asia/Shanghai 时间 |
| ---------------------- | ----------------- | ------------------ |
| `auth-session-cleanup` | `session-cleanup` | 每天 02:00         |
| `auth-audit-archive`   | `audit-archive`   | 每月 1 日 03:00    |

使用当前锁文件中的 BullMQ 5 Job Schedulers API。安装计划的实例竞争 `${BULL_PREFIX}:neo:scheduler:leader`：随机所有者值、15 秒租约、5 秒刷新，Lua 比较所有者后原子续约/释放，每实例最多一个刷新在途。失败后重新竞争；稳定计划 ID 让重复安装收敛到两项定义，其他实例在租约释放或过期后接管。该租约保护计划安装，数据库维护仍由 PostgreSQL 每类事务锁和行锁保护，不能把 Redis 租约当成数据事务锁。

单实例维护并发为 1，多实例共享队列。每个任务最多执行 100 批或运行约 30 秒，每批最多 1000 行，每次归档处理一个月份，截止时间在单次尝试内固定。会话清理只删除到期且期限非 NULL 的会话；归档严格早于 90 天，不自动删除已归档证据。达到预算后投递延迟 1 秒的续跑任务，ID 从当前任务 ID 的 SHA-256 派生，以减少 Redis 回执丢失后的重复投递；数据库已提交批次可安全重做。重试与续跑重新计算截止时间。

锁竞争或所有候选行暂时被锁时直接重试，不忙循环。任务最多尝试 3 次，指数退避从 5 秒开始；非法数据为不可恢复失败，不重试。一次失败不回滚此前已提交批次，失败发生的数据库批次整体回滚。连续失败后保留失败任务供运维检查，在依赖恢复后通过受控队列管理重试，或等待下一次计划；不会无限重试。日志及 BullMQ 失败原因只保留固定错误、操作和本次尝试的已处理数，不保留数据库原始异常、SQL、账号或审计内容。

完成任务保留不超过 1 天/50 条，失败任务保留不超过 7 天/200 条，由 BullMQ 后续完成/失败时惰性清理；这只是维护队列结果保留，不是审计数据保留策略。

## 停止与恢复

**`SCHEDULER_ENABLED=false` 仅停止该实例安装计划。已有计划保存在 Redis 中，消费者取走计划任务时 BullMQ 会安排下一次任务，因此仅停掉调度实例不会取消计划。** 普通 SIGTERM 会停止本实例租约刷新并等待在途任务，随后关闭 Worker、队列、数据库池和控制连接，保留计划供其他实例继续处理。

全局停用 D4 的受控步骤：

1. 停止所有启用认证维护的 Worker，确认进程停止、在途维护事务已结束。不要只停止一个调度实例，或仅把部分实例改为 false。
2. 使用相同权威源、Redis 与前缀配置，在仓库根运行 `corepack pnpm --filter worker maintenance stop`。命令先持久暂停整个维护队列，再删除上述两个计划；失败时保持已完成的暂停，不自动恢复消费，可排障后重跑。
3. 确认维护队列 paused、两项计划不存在、没有 active 维护任务，再执行数据回滚或其他操作。此命令保留等待任务、失败任务和历史结果，不清空队列、不删除数据库数据。

恢复时先确认数据库升级和连接正常，然后运行 `corepack pnpm --filter worker maintenance resume`，再启动至少一个 `SCHEDULER_ENABLED=true` 的维护 Worker，让其重新安装计划并消费余量。若 Worker 在 resume 前启动，队列仍保持持久暂停；resume 后才会开始消费。单纯 resume 不绕过租约安装计划。

进程关闭总等待上限沿用 10 秒；超过上限会强制退出，BullMQ 锁过期和 stalled 检测后由存活/重启的消费者接管，已提交数据库批次保持幂等。暂停无法中断已经运行的事务，所以数据库回滚必须等待所有维护实例及在途事务结束。回滚代码可停止并移除维护计划后退回本次提交前版本；数据层降级另按其运行说明操作，不能用恢复过期会话来回滚清理。

## 验证证据

本地单元测试覆盖选择语义、租约原子所有权与单次在途刷新、预算/续跑、锁竞争、非法任务、脱敏、暂停/恢复。Worker 源码与测试均做 TypeScript 检查。

Integration 在既有 PostgreSQL / Redis 服务、最终快照导入和 `0003` 升级之后执行：

```sh
corepack pnpm --filter worker build
corepack pnpm --filter worker exec vitest run test/auth-maintenance.integration.test.ts test/auth-maintenance-entry.integration.test.ts --no-file-parallelism
```

真实测试使用随机私有 schema 和 BullMQ 前缀，覆盖两个运行实例与租约接管、上海时区计划及实际定时投递、数据库竞争/插入失败与重试、101 个月跨任务续跑、持久暂停和恢复、非法任务以及迁移缺失后的修复。Linux CI 还直接启动编译产物，验证两类数据库效果、SIGTERM 正常退出、编译后的控制命令、空闲/Legacy 路径和启动失败脱敏。测试结束仅清理测试创建的隔离数据，检查 Legacy 队列哨兵不变。
