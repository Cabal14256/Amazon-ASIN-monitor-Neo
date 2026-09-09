# P2 主营批量删除与实际 BullMQ Worker

## 入口与前提

`POST /api/v1/variant-groups/batch-delete` 已迁移同步删除和异步任务。需要 `asin:delete`，带 Origin 时必须匹配 `CORS_ORIGIN`；当前账号、密码有效期、会话与权限在 PostgreSQL 事务中再次复核。要求 `AUTH_DATA_AUTHORITY=postgresql`，按最终 Legacy 导入 →0003→0004 顺序完成存储升级。Legacy 入口保留，当前没有切换生产流量。

API 和 Worker 必须使用同一 PostgreSQL 主库、Redis、`BULL_PREFIX`；Neo 命名空间固定为 `${BULL_PREFIX}:neo`。启动已构建的 `apps/worker/dist/main.js`，将 `WORKER_ENABLED_QUEUES` 包含 `batch-delete`，即可注册主营实际消费者。可同时选择 `maintenance`；日志以 `mode=business-worker` 和准确的 `registeredProcessors`/`queueCount` 表示已注册资源。剩余七类业务消费者与竞品批量删除仍待迁移，队列健康不代表这些业务可执行。

## 输入与兼容行为

请求字段为 `groupIds`、`asinIds`、`useAsync`。两个列表保留 Legacy 的标量转字符串、去两端空白、去空值、按首次出现去重；非数组列表视为空。显式 `useAsync` 接受布尔值及大小写不敏感、去空白后的 true/1/yes/on、false/0/no/off 字符串；其他值按阈值判断。

新增资源边界：原始两个数组合计最多 1000 项，重复项也计入此上限，超出返回 413。ID 最多 50 个 Unicode 码点且不得含 ASCII 控制字符，额外顶层字段、无法转换的值、空目标返回 400。旧服务未限制这些输入；这是 PostgreSQL 存储与任务大小的明确边界，不截断目标。

| 变量 | 默认 | 规则 |
| --- | --: | --- |
| `BATCH_DELETE_SYNC_MAX_ITEMS` | 50 | 规范化目标数大于此值时使用异步 |
| `BATCH_DELETE_SYNC_MAX_ASINS` | 500 | 预计直接与组内 ASIN 总数大于此值时使用异步 |
| `BATCH_DELETE_CHUNK_SIZE` | 50 | 异步每块 1–500 个组或直接 ASIN |

无效或非正阈值回退默认；正数向下取整并至少为 1，修复旧小于 1 的分块配置产生 0 的问题。超过安全整数或分块大于 500 拒绝启动。显式模式覆盖阈值。同步仍受原有 2 秒事务截止、1.5 秒 SQL 截止，强制同步的大组超时需缩小请求或改异步；异步单个大组也受同样事务截止。

分析保持请求顺序，先删除存在的选中组；同时选中的组内 ASIN 不再作为直接删除项。原本缺失的组与 ASIN 放入 `skipped`。成功返回 200/现有信封：同步结果含三种删除计数、原始规范化目标数和跳过列表；异步返回 `mode=async`、UUID `taskId`、`status=pending`、`totalRequested`、`estimatedAsinCount`。

## 事务和并发

同步删除在一个事务内完成。先读取候选父组，再按数据库 ID 排序锁定所有父组，最后锁 ASIN 并复核归属；等待期间发生移动则 409，不在持锁途中改锁新的父组。父组 FOR UPDATE 锁同时阻止 FK 插入，级联计数在锁内读取；直接删除及组删除均验证 RETURNING 实际行数。组级联、直接删除、直接 ASIN 原父组时间更新同属事务，任意失败全部撤销。监控历史不删除。

异步先分析，再按组块、直接 ASIN 块的顺序执行，各块独立提交。结果的 `failedCount` 是失败分块数，失败样本只含序号、数量和固定公开错误；其他分块继续。最终保存完整 summary、三种删除计数、跳过列表、warnings、verificationPassed，与旧结果正常语义对拍。提交时连接中断可能无法确认结果，失败提示要求刷新核实，不能把未获确认等同于数据库必然回滚。

API 接受授权的时点是上述当前权限事务提交。随后创建任务元数据、再入队；任务使用元数据的**同一个 createdAt**、所有者和 UUID，不另取时钟。PostgreSQL/Redis/队列三者不是分布式事务。接受后退出登录或会话撤销不撤回后台任务，沿用旧语义；取消须调用任务取消端点。

元数据创建或入队应答超时返回固定 500 与 `data: { taskId, status: "unknown" }`。这类专用错误只公开服务器生成的 ID；普通 5xx 仍经过全局脱敏。先用该 ID 查询任务，或查看本人任务列表，避免盲目重新提交。未确认的 job 不会自动删除或被改成失败；如果只有 pending 元数据且无 job，可取消该记录。API Redis 使用有界连接/命令等待，关闭或截止后不发起新命令，也不离线排队或重发已发出的命令。

## 取消、故障与关闭

Worker 校验完整规范化 payload、job ID/名称、元数据所有者/type/subtype/createdAt。开始分析、每个分块和进度写入前核对当前元数据及 BullMQ 锁 token。元数据缺失、身份变化、锁丢失或 Redis 不可用会停止后续数据库工作；绝不重建已过期任务。进度和终态写入均等待有界 Redis 命令完成，终态先持久化再返回 BullMQ；已完成、已失败或已取消的记录再次投递时不重复删除。

排队任务可由现有取消接口原子移除；运行中的任务在当前块结束后确认取消，之后不再开始新块。已经提交的删除保留，取消结果不承诺撤销。进程正常关闭也停止新块，并记录固定的“Worker 正在停止”失败原因，不冒充用户取消；连接资源归还，主入口保留整体 10 秒强退上限。

批量删除配置沿用一次尝试、成功保留 3600 秒、失败保留 86400 秒、跨消费者每秒一个任务及独立并发变量。异常进程退出仍可能触发 BullMQ stalled 恢复；删除按目标存在性执行，但没有持久化数据库分块检查点，崩溃前已提交的数量可能在重新分析时变成跳过，不能声称跨崩溃结果恰好一次。故障/取消后的计数以重新查询剩余业务数据为准。跨进程 WebSocket 事件桥尚待后续迁移，当前通过既有任务查询与客户端轮询观察持久状态。

## 验证与回滚

规则测试执行真实 Legacy 分析/同步删除/异步结果归一化代码；HTTP 测试覆盖精确权限、事务内复核、Origin、输入限制、同步阈值、任务身份及未知应答。Worker 测试覆盖顺序、失败分块、取消、终态重投、身份变化、到期、锁丢失、Redis 故障与关闭。

真实集成通过独立随机 PostgreSQL schema、真实 FK/0004 触发器及随机 Redis 前缀执行；先 `corepack pnpm build:worker`，再在明确的一次性依赖环境以 `RUN_INTEGRATION_TESTS=true` 运行 `corepack pnpm --filter api exec vitest run test/asin-batch-delete.integration.test.ts`。覆盖同步级联/历史/父组时间、故障回滚、撤权、真实 HTTP→ 已编译 Worker→ 查询结果、排队/运行取消、部分失败、移动竞争、Linux 编译入口单独/联合注册和 SIGTERM 关闭。根 17 项基线继续保留请求与导出 URL `/api` 去重回归。

回滚先停止 Neo 批量删除生产者和消费者，记录并处理在途任务，再恢复 Legacy 入口。不得将 Neo job 复制到旧 Bull 队列，也不得清空生产 Redis。回退代码不会恢复已删除数据，数据恢复须按备份与记录级核对流程单独处理；本批不新增数据库迁移。
