# 竞品批量删除与共享消费者

关联 Issue：#127。该阶段迁移 `POST /api/v1/competitor/variant-groups/batch-delete`，沿用 `asin:delete` 权限。Legacy 入口继续保留，生产迁移、切换与最终容量验收仍按 #48 的后续门禁执行。

## 请求与结果

请求接受 `groupIds`、`asinIds`、`useAsync`。保留 Legacy 标量字符串转换、去空白、去重及顺序；`useAsync` 支持布尔值和原有 true/false、1/0、yes/no、on/off 字符串。默认超过 50 个目标或估算 500 个 ASIN 时异步，分块默认 50，显式模式仍覆盖阈值。使用现有 `BATCH_DELETE_*` 环境配置。

两种 ID 原始数组合计最多 1000 项，超过返回 413。不可存储的 ID、未知字段及非对象请求返回 400；没有有效目标返回原有“请提供变体组 ID 或 ASIN ID 列表”。合法目标全部不存在时仍成功返回完整 skipped 列表。

Legacy 批量删除在 CI 查询后通过精确字符串 Set/Map 筛选，因此仅大小写、重音或尾随空格等价的 ID 不自动变成规范 ID。Neo 保留此行为。一个组与其子 ASIN 同时被请求时，子项计入嵌套删除，不重复计入直接删除。响应沿用共享完整契约，包括同步 counts/skipped、异步任务 ID，以及任务查询中的累计结果、失败分块和 verificationPassed。

## 数据库与鉴权

API 在主库事务中重新锁定并验证当前用户、会话和 `asin:delete`，随后才连接独立竞品数据库。主库鉴权锁持有到竞品事务提交结束。业务操作只访问竞品组、ASIN 和其真实 FK，历史记录保留。主库同名表不会被用作回退。

每次业务事务检查既有 `0011_competitor_write_policy`，无需新增迁移。按固定顺序先锁父组、再锁 ASIN；等待期间发生归属变化返回 409。直接删除只更新时间戳对应的剩余父组，删除组选定的子项由 FK 级联删除；后续失败整笔同步事务回滚。时间使用实际语句时刻、上海墙钟语义，保留既有 0011 策略。

沿用共享双库事务传输：SQL 最长 1500ms、整体最长 4000ms，API 最多 8 个在途操作，迟到的连接继续占用配额直到释放；超额返回 429。事务提交确认丢失时返回 503 和刷新提示，不自动重试可能已提交的删除。

## 共享队列与 Worker

继续使用一个物理 `batch-delete-task-queue` 和现有 Neo Redis 前缀。一个消费者根据严格 payload 分派到主营或竞品仓库。主营 job 名称与身份不变；竞品必须同时匹配：

- job name：`competitor-batch-delete`
- taskType：`batch-delete`
- taskSubType：`competitor-variant-group-delete`
- domain：`competitor`
- title：`批量删除竞品变体组`

API 创建 UUID 和服务端用户身份，以 Redis registry 的创建时间投递。Worker 在访问数据库前验证 job 名称、ID、完整 domain 身份及 registry 中的 userId/taskType/taskSubType/createdAt；每个分块检查租约、取消和关闭状态。已受理任务在提交用户退出登录后仍继续执行。查询和取消仍只允许任务所有者。

竞品连接及 0011 检查延迟到竞品任务实际访问数据库时，竞品库不可用不会阻止主营消费者启动。实际消费者并发为配置值与 16 的较小者，与数据库配额保持一致；超出的任务保留在队列等待。API 的 8 操作配额不变。

分块失败保留已完成删除，继续独立分块，并返回固定脱敏错误和完整累计结果。取消保留当前已提交分块，停止后续分块。关闭不伪装成用户取消；丢失租约停止后续写入。已有终态任务重放时读取保存的结果，不重复删除新建的同 ID 数据。任务终态先于 BullMQ 完成确认持久化。

任务提交以 3 秒为预算，命令不离线排队或自动重放。入队结果无法确认时返回固定 500、`data.taskId` 和 `status: unknown`，保留可能已入队的任务供查询，不删除或重投。日志不记录请求、原始数据库错误或任务 payload。

## 验证与回滚

共享 HTTP/消费者回归覆盖两种 domain，数据库测试与实际 Legacy service/result 代码比较完整分析及累计结果。集成流水线额外执行 `apps/api/test/competitor-batch-delete.integration.test.ts`：实际 MySQL Legacy controller、两个独立 PostgreSQL 数据库、Redis、编译后的 Worker 及 main 进程；覆盖混合队列分派、历史保留、别名/重叠/缺失、当前权限撤销、0011 回滚恢复、锁超时/并发移动、提交/入队确认丢失、任务归属、取消、分块失败、终态重放和进程关闭。

回滚代码前先停止接收新的竞品批量任务，查询并完成或由所有者取消已有竞品任务，再停止共享 Worker 并恢复此前版本；此前消费者只接受主营 payload，不能让它抢占仍待处理的竞品任务。无需回滚数据库 DDL；已完成的删除不能通过回滚代码撤销，应按备份恢复流程处理。生产切换未在本阶段执行。
