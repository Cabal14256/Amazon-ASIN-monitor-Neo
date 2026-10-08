# Neo 目录操作结算恢复（Issue #224 / PR #229）

服务端目录保护覆盖原 owner/domain/operationId/generation/kind，并绑定原 taskId/userId/taskType/taskSubType/createdAt。Redis 终态、队列不存在、BullMQ 任务完成或时间经过都不是物理事务结束证明。主库槽与 pin ledger 是释放依据，不能强制删除或重置未知代次。

## Worker 的持久关闭标记

原消费者只有在 actionDone、没有待分配 pin、所有已分配 pin 已物理结算且无任何 unconfirmed，同时读到确切原任务的 completed/failed/cancelled 后，才关闭原代次的业务准入。先持久化 `closed / terminal=null`，随后保存该任务的终态 proof 并 release。两次关闭有不同用途：第一笔阻止后来业务进入并留下已排空标记，第二笔保存终态证明；释放仍要求同代次所有 pending/uncertain pin 为零。

读、关闭或释放的一次存储故障在原闭包中最多重试三次，重试只做结算。所有尝试仍未确认时抛出固定错误，不把 BullMQ completed 当作结算成功。原消费者的返回值或业务错误在结算确认后保留；active/retryable 非终态不写关闭标记，下一次原有业务尝试仍可正常进行。各队列原 attempts、backoff、业务期限和 SQL 期限保持不变，batch-delete 仍只有一次配置尝试。

新的 Worker 调用可重放已验证的原任务结果，并只对原 PostgreSQL closed、完整 binding 匹配且无 pending/uncertain pin 的代次补做结算。已有 terminal 必须同状态、同任务并来自 worker/cancel；closed/null 标记还需原合法任务 payload/完成 receipt 与当前确切终态，才能补原任务 proof。回放不调用业务消费者、不分配新 pin、不改 Redis 元数据。idle/MISSING、替换代次、open（即使零 pin）、uncertain 或仍有 pin 都不会因终态元数据被释放。

进程在读终态或关闭标记完全不可用时退出，可能留下保守的 open 槽；没有持久物理证明不能自动释放。存储未知、pin ACK 丢失及全存储失联须人工核验。显式重投原失败 BullMQ delivery 可恢复已有合法 drained marker，但 Worker 重启本身不自动重投失败任务，也不增加一次业务执行。

## 取消与写入背压

[任务取消](phase-2-task-cancellation.md)在真实 queue.remove 前取得最多八个结算许可。确切移除 ACK 先保存 queue proof，随后才写 cancelled 元数据；两个阶段不能混为一笔事务。HTTP 的三秒逻辑期限不释放已知 removed 的许可。三次结算仍未确认时，只有本进程保存的 exact remove proof 与当前 exact cancelled 可显式重试，不重新 queue.remove 或 metadata CAS。

取消进程重启、未知移除 ACK、非终态 CAS 失确认、全部存储失联、原身份缺失/替换及 release 实际提交但 ACK 丢失均需人工核验；这些情况不通过 MISSING 或 terminalmetadata 释放容量。独立 export/backup 等非目录取消不会被目录结算容量拦截。

新目录写入对原 slot 使用 `FOR UPDATE NOWAIT`。槽竞争及首次 slot INSERT 仲裁的 PostgreSQL 55P03/57014 归为 CATALOG_OPERATION_BUSY，API 返回固定 409，未进入业务动作；当前鉴权、管理锁、连接/IO 等其他错误不泛化为目录繁忙。原业务 COMMIT/ROLLBACK、真实连接释放与 pin finally 仍须独立完成，HTTP 409 不撤销原业务。

HTTP 鉴权先更新当前会话活跃时间。若原业务仍持有同一 session 的共享锁，这笔 heartbeat 可能在进入目录 reserve 前按原鉴权期限超时，返回固定 503；它不能被归为槽竞争。原目录保护仍保留，未开始第二笔业务。原生验收使用同 owner 的另一合法 session 单独触达真实槽 NOWAIT，并以同 session 的独立 503 控制保留这一边界，不跳过实际鉴权或提高期限。

## 验收门与回滚

- 定向 unit/HTTP：Worker catalog-operation-processor；API catalog-operation、task-cancellation、task-cancellation-settlement；DB catalog-operation-reservation。driver seam 故障测试不是原生数据库证明。
- 隔离 PostgreSQL：DB catalog-operation.integration 的两个 domain 持真实 assertPin SHARE 锁时新 reserve 返回 BUSY，原槽/pin/业务原值不变；API catalog-operation.integration 在原 4000ms 竞品业务事务期间，同 owner 第二合法 session 返回 HTTP 409、确实到达目录仲裁，同 session heartbeat 受锁返回鉴权 503 且未进入仲裁；两者均不调用第二业务事务，原槽/pin/业务值不变，原业务完成后下一写入成功。
- 隔离 PostgreSQL、Redis、Legacy fixture 与已构建正式 Worker：API asin-batch-delete.integration 保留真实删除、closed/null 标记、零 pin、Worker 关闭/重新启动及原失败 delivery 显式 retry，确认原 Redis receipt 不变、未申请第二次业务 pin。
- 本机未启用 RUN_INTEGRATION_TESTS 的 native skip 只表示未运行，不计为通过。CI 必须在隔离服务中实际执行上述用例并覆盖最终源码；浏览器与发布 gate 独立保留。

本次不新增迁移或变更队列策略。回滚修复代码前先停止相关生产者/消费者，核验并记录 retained 操作与取消许可；不得通过清 Redis、删目录槽/pin 或修改 taskId 解除保护。原业务结果与未知状态必须保留。
