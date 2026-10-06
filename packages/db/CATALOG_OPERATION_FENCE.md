# 目录操作持久保护（Issue #224）

`0017_catalog_operation_fence.sql` 只在主 PostgreSQL 创建两张内部表。主营、竞品均使用主库的 `(owner_id, domain)` slot；用户 ID 和 domain 以 `COLLATE "C"` 字面值比较。没有用户外键，删除账号不能删除仍在运行的保护。手工 SQL 迁移是部署 DDL，Drizzle 定义用于类型与结构契约校验。

## 事务边界

- `reserve` 在一个短 SQL 事务中按 RBAC shared advisory lock → slot UPDATE → 当前用户/session 鉴权的顺序，验证权限并打开新代次。首次不存在 slot 的并发调用也由唯一主键仲裁；鉴权失败会回滚首次插入。
- 任务身份由 `RedisTaskRepository.create(input, onPrepared)` 的回调在 Redis EVAL 前绑定：taskId、userId、taskType、taskSubType、createdAt 都不可更改。预留时可不知道 taskId，首次绑定在 slot UPDATE 锁下原子填入 expectedTaskId 与五字段；存在 expectedTaskId 时必须精确一致。UUID 使用小写标准拼写，不把不同 Redis task key 归一化为同一身份。绑定成功但 EVAL 或队列 ACK 丢失仍保留 slot。
- `withCatalogOperationExecution` 传递可信内部身份。实际目录 mutation method 还必须经过所属数据库事务的 `guard`，验证确切 open 代次/pin 并持有主库 SHARE locks。单独传递 scope、旧任务、closed 代次、缺失保护或错误 domain 都不能写目录。
- 每个实际事务先持久 `beginPin`，再开始数据库业务。主库事务持有 SHARE locks 到 COMMIT/明确 ROLLBACK；竞品事务在竞品 COMMIT 实际结束前保留主库保护。实际工作 promise 的结算回调记录 pin；HTTP/队列外层超时、取消、逻辑 Promise.race 结束不能代替物理结算。
- `committed` 需要实际 COMMIT ACK；`rolled-back` 需要未启动 COMMIT 的实际 ROLLBACK ACK（或连接取得失败、业务未开始）。断连、超时、COMMIT ACK 不明和进程崩溃保留 pending/uncertain。主库连接先归还，再借连接记录 pin，避免同池满载死锁。
- `close` 关闭代次、拒绝后来事务；`release` 仅在 exact identity、closed、明确 terminal proof、没有 pending/uncertain pin 时成功。已绑定任务要求相同五字段 proof，不能用同步结束证明解除异步任务。旧代次完成不会影响新代次。

内部 `producer/rejected` proof 仅供已明确证明未入队的提交失败，且必须包含原 bound task；未知 ACK、通用 failed、超时不能冒充 definite rejection。取消与 Worker 的 `cancelled` 证明只有在五字段任务身份一致时允许幂等汇合，保留首份证明；其他矛盾 proof 均拒绝，未结算 pin 仍持续阻止解除。

读取查询无需 scope。认证的异步 `parent-asin-query` 会写持久检查收据，所以也必须绑定主营 check operation；真实 taskType/subtype 必须成对匹配，不能把 `batch-check/parent-asin-query` 或竞品域当成合法替代。冻结的匿名检查和内部系统调度只能由可信调用点使用 `withCatalogOperationExemptExecution('anonymous-check'|'scheduled-system', action)`；其实际 check 事务仍有 lifetime guard。该作用域不能执行普通 CRUD/import/delete，也不能由请求参数指定。此保护按 owner/domain 排他；匿名检查、系统调度和其他 owner 不在同一互斥范围。

## 未知状态与恢复

`read(ownerId, domain)` 返回有界 snapshot（原 operationId/generation/kind、预定 taskId、精确绑定身份、pending/uncertain counts、terminal）。`findByTask` 需要完整身份；closed 身份可以读取但不能开始业务。任务 TTL、Redis/Bull Job 不存在、API/registry terminal、SQL try-lock、过期 timestamp 都不是解除依据。

本轮不提供自动重试未知提交或人工 unlock 写 API。进程崩溃留下 pending pin 时，主库连接已断开也不能证明竞品连接上的 COMMIT 结果；运维必须保留保护、核对实际业务与原任务身份，再另行安排审计后的处置。读取恢复信息不能重 POST，不得删除 SQL slot 来“解卡”。

## 部署与回滚

这次仅完成代码和隔离验收，不执行生产切换。上线需先停止目录生产者、停止并核验在途操作，明确处理原 Neo 无 fence 的旧作业：升级后的 Worker 不允许无保护回退执行。部署所有生产者和消费者前执行 `corepack pnpm db:upgrade:catalog-fence`；包装器只连接主库，SQL 自身再次检查主库前提。不要分批启用只保护部分入口的版本。

升级可重复运行；首建对象/索引冲突、部分表、非持有标记、列/约束/索引/trigger/RLS/policy 漂移都会失败，事务回滚。结构指纹不依赖账号 ACL/ownership。禁止用 `IF NOT EXISTS` 接纳陌生表。

回滚前停 API 和 Worker 并核验业务实际结算。运行相同包装器、指定 `/opt/asin-monitor/0017_catalog_operation_fence.rollback.sql`。回滚仅删除本迁移的两张表；存在 non-idle slot、任意 pin、结构漂移或非持有标记时拒绝，不能丢弃未知操作。恢复旧二进制前必须完成相应队列排空与数据核验。

## 验证

`catalog-operation.test.ts` 覆盖严格身份与 actual transport scope，`task-registry.test.ts` 覆盖 prepared binding/EVAL ACK 丢失；两类 deadline/lifecycle 测试以合成 SQL transport 检查实际 promise 结算顺序，不能视为真实数据库证据。

`RUN_INTEGRATION_TESTS=true` 的 `catalog-operation.integration.test.ts` 在显式 `DATABASE_URL` 上创建随机私有 schema，读取冻结 baseline 的真实业务表 DDL，执行 actual migration/repository/业务 unit 与 `pg_locks`，覆盖并发预留、slot 持锁、closed/旧代次 CAS、未知 pin、任务绑定、NULL CHECK、漂移、冲突和回滚。无 opt-in 时明确 skip；本地不加载 `.env`、不修改 public，不把 skip 计为已验收。POSIX 包装器测试在 Windows skip，由 Linux CI 运行。两域真实 HTTP、编译后 Worker 与跨库结算的端到端验证须由相应 API/Worker 集成用例提供。
