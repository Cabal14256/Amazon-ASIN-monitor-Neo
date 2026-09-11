# Neo 本人任务取消（Issue #97）

`POST /api/v1/tasks/:taskId/cancel` 返回冻结 TaskInfo/Result、HTTP 200 和 no-store。沿用任务查询的实时登录及 PostgreSQL 权威源门槛，不增加额外权限或强制改密限制。必须存在本人注册表记录；无记录 404，无 owner/非本人 403，已终态 400。支持旧版取消映射中的 export/import/batch-check/batch-delete/backup；variant-check 不在旧取消映射中，保持 400。

## 队列与状态协调

- 使用 Neo 前缀及共享队列目录，不读取旧 Bull4 或裸任务注册表。保留队列键不能作为任务 ID，producer 应使用 UUID。
- 同一 Redis Lua 调用先复核注册表 owner/type/createdAt 和最新非终态，再复核 job data 的 owner/createdAt。新 producer 必须将已创建注册表的原始 createdAt 写入 job data，不能另取时钟生成。缺失或不一致的身份拒绝写入。
- 检测到 completed/failed 时返回 400，保留队列结果；后续 GET 仍可正常对账。处于 active 或持有锁的任务只请求取消，即使锁已过期也不直接删除 active 工作。
- waiting/paused/delayed/prioritized 可移除。状态检查与 BullMQ 原有完整 removeJob 脚本在同一 EVAL 中执行，Worker 领取/完成不能插入二者之间。复用锁文件中 BullMQ 5.81.3 的脚本而非复制维护其清理实现，版本、脚本名和参数数量检查在加载时失败关闭；升级 BullMQ 必须同步审核此适配器并通过真实测试。
- 本人业务任务为独立 job，拒绝 flow 父子关系、scheduler/repeat 和依赖图；不递归移除其他任务。预检查删除所需 key 类型和事件上限参数，防止已知错误导致 Lua 部分写入；Redis Lua 的原子执行不等于通用错误回滚。
- 队列移除成功或 Neo job 已不存在时，使用注册表身份 CAS 写 cancelled。运行中使用 cancel-request，保持取消请求粘性；不改写 job.data，避免覆盖并发更新或重编码空数组。首个注册表终态获胜，已完成的业务修改不撤回。
- Worker 必须在开始执行前及每个批次边界复核同一注册表身份和取消状态，确认停止后写 cancelled；业务提交和完成元数据应先于队列完成。这里尚未实现八个业务 Processor，不能据此宣称端到端批量业务完成。producer 与取消并发时也须复核注册表状态，避免处理已取消记录。

## 授权、失败和通知

当前登录账户/会话在请求鉴权阶段实时读取；浏览器 Origin 必须匹配配置，沿用既有写接口规则，cookie 和 Bearer 均适用。本接口不持有跨 PostgreSQL/Redis 的事务锁，也不保证请求接受后撤权能撤回已经发出的 Redis 操作。队列状态与任务身份在 Redis 原子写入前再次验证。

最多 8 个取消请求；复用任务请求连接的 1 秒就绪总截止、1 秒命令超时、无离线重发和关闭策略。3 秒后不启动新依赖命令，等待已发命令结束才释放容量。固定 500 提示刷新同一任务确认状态；日志不包含 driver payload、任务业务数据或用户标识。

队列删除与注册表 CAS 是两个操作：中途失败可能留下非终态元数据而 job 已移除，重试取消会恢复为 cancelled。已过期记录不会复活，身份被复用返回 409。超时不代表撤销已完成写入，不能通过换 ID 重试制造重复任务。

注册表 CAS 提交后统一发布最小变更通知，由各 API 重新读取当前状态并发送给明确的 owner；cancelling 不发送 task_cancelled。取消接口不再额外调用进程内 helper，以免重复推送。通知失败节流 warn 并保留持久化成功；去重、实时会话复核和断线 HTTP 恢复见[跨进程任务 WS](phase-2-task-websocket.md)。

## 验证与回滚

- 本地：`corepack pnpm --filter api exec vitest run test/task-cancellation.test.ts test/task-query.test.ts test/task-query-runtime.test.ts`，并运行完整仓库基线、API 测试类型检查和请求/导出 URL 去重检查。
- 设置隔离测试数据库和 Redis、`RUN_INTEGRATION_TESTS=true`，运行 `corepack pnpm --filter api exec vitest run test/task-cancellation.integration.test.ts`。真实测试覆盖五队列、暂停/延迟/优先级、完成/失败竞争、执行前取消、两会话并发、实时撤销、身份复用/过期、流任务保护、去重键清理、损坏 key 预检查和停止生命周期。
- 无数据库 schema 变化、生产切换或旧路径删除。移除 TaskCancellationController/Service 的模块接线即可停止取消入口；保留已经提交的任务状态，不重新入队被取消任务。
