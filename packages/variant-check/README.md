# 变体检查共享业务

API 和 Worker 共用的主 ASIN 检查业务。Catalog 抓取、配额、回退、缓存和父体查询在 `@asin-monitor/sp-api`；本包负责当前权限检查、PostgreSQL 状态/历史事务及完整业务结果。

SQL 实现统一位于 `packages/db/src/repositories/variant-check-repository.ts`，数据库业务类型位于 `packages/db/src/domain/variant-check.ts`。本包的对应入口仅作重导出，编排层不包含 SQL。批量 Catalog 结果编解码在 `packages/sp-api/src/catalog-hybrid-result.ts`，数据库包使用它校验结果，依赖方向不形成环。

`VariantCheckRuntime` 统一组装检查管线和父体查询，接收应用已有的 `SpApiRuntime`、数据库仓库以及禁止离线排队/自动重发的 Redis 连接。它负责关闭本包创建的组件，应用继续负责基础连接的生命周期。应用应将共享环境的 `MONITOR_BATCH_ASIN_THRESHOLD` 传入 `batchThreshold`；默认 0，正小数向上取整以保持 Legacy 的数量比较语义，超过组上限 5000 会在启动校验时报错。

`VariantCheckPipeline` 先授权并读取快照，在事务外调用 Catalog，再按组 → ASIN 顺序锁定并核对商品身份与检查时间。提交时保留最新的手工标记、组继承和排除设置，响应反映已提交记录的时间及有效状态。单 ASIN 检查原子写入完整历史；组检查本身不额外创建历史。空组保留 Legacy 的读取结果。

每个调用必须提供 `authorize(unit)` 和 `checkpoint()`。HTTP 调用由前者校验当前会话和权限；兼容匿名路由需要调用层明确提供匿名策略。已受理任务的调用层负责其授权策略，以及任务所有者、创建实例、租约、过期和取消检查。这些回调会在读取前、网络阶段及持锁写入边界重复执行，不能省略为隐式默认值。

共享管线最多接纳 8 个操作，组内最多并行检查 3 个商品，整体期限 15 分钟。等待者取消后，尚未结束的底层工作仍占用名额。完整响应及累计观察结果上限为 32 MiB；最终序列化检查在数据库仍可回滚时完成。`raw` 和每项 `variantView` 保留 Legacy 嵌套结构，不能用截断结果替代。

提交后的缓存清理最多并发 8 项、等待 2 秒，失败只记录固定原因的 `warn`。清理超时仍保留实际 I/O 的容量占用。已确认提交的业务不会因清理失败变成失败；提交期间取消或丢失数据库确认会抛出 `VariantCheckCommitUncertainError`。

异步调用可提供 `operation` 完成凭据身份。它绑定任务 ID、所有者、精确创建时间、队列类型、子类型、步骤和请求摘要，步骤锁在业务行锁之前获取。单 ASIN/组管线在抓取前读取凭据，在提交前加锁复查；已完成操作返回保存的完整结果，状态/历史与新凭据在同一事务提交。因此提交确认丢失后可以按原任务身份恢复，不能把未知结果简单当作未写入。同步 HTTP 调用不创建任务凭据。

`VariantCheckExecutor` 处理四种业务请求。批量任务先恢复并计入全部已完成组，再按输入顺序保存完整成功/失败项；新组结果的总容量预留发生在当前组事务内，超限时当前组回滚并记录失败，不截断已提交结果。总量计入 JSONB 的空格和指数数字展开，并为失败项及任务汇总预留空间。父体查询和最终批量结果也保存完成凭据；Redis 和 BullMQ 只保存不足 1 KiB 的结果引用。读取引用时必须以独立验证的任务所有者、类型和创建实例重建操作身份。

实际 `apps/worker/src/main.ts` 在 PostgreSQL 权威模式下注册 `variant-check` 和 `batch-check` 两个消费者，使用共享 SP-API 配置源和业务执行器。处理器每秒及每个数据库检查点核对任务身份、租约、过期和取消状态；受理时授权沿用现有导入任务策略，退出登录不撤销已经受理的任务。第一次暂时失败保持可重试状态，沿用队列两次尝试和 5 秒指数退避；完成确认丢失时保留凭据供恢复。独立 Redis 控制连接禁用离线排队和未完成命令重发。`BATCH_CHECK_GROUP_CONCURRENCY` 默认 2，正数向下取整，实际并发限制为 1–8；整体仍受共享管线容量约束。

凭据存储使用主库 `variant_check_receipts`（JSONB），由 `0006_variant_check_receipts.sql` 显式升级，最多 32 MiB/条。过期身份不能再次执行；Worker 启动时验证升级并清理过期凭据，随后每分钟执行一次，每次最多 500 条且不重叠。运行 `corepack pnpm db:upgrade:variant-check-receipts` 升级已有 Neo 主库；该命令不改动竞品库和 Legacy 基线。回滚前必须停用检查生产者/消费者并保留需要的完成结果，再执行对应 rollback SQL；回滚会删除完成凭据，不能重放此前的队列任务。业务 ASIN、组和历史记录保留。

非强制组检查达到 `batchThreshold` 时，可启用 `CatalogHybridChecker`。它按最多 20 个唯一 ASIN 搜索，收齐有界分页后再按原始顺序对有变体或搜索失败的商品查询详情，保留重复输入和 Legacy 的较小批量结果结构。搜索缺失项是 `NO_VARIANTS`，不冒充确认的 `NOT_FOUND`；详情失败保留搜索证据，错误文本使用固定安全消息。任务检查点失败、取消、依赖不可用等条件会停止后续工作。

Legacy 批量代码错误地使用 POST 请求体。新实现遵循 [Amazon Catalog Items 官方接口](https://developer-docs.amazon/sp-api/docs/catalog-items-api-v2022-04-01-reference)，使用 GET、CSV `identifiers`、`identifiersType=ASIN` 和 `pageSize=20`。请求仍经过已有的签名、共享配额及重试层。操作配额沿用现有保守配置，本次不提高限流上限。

验证：

- `corepack pnpm --filter @asin-monitor/variant-check typecheck`
- `corepack pnpm --filter @asin-monitor/variant-check test`
- 设置 `RUN_INTEGRATION_TESTS=true` 和隔离的 `DATABASE_URL` 后，运行 `test/repository.integration.test.ts` 验证实际 PostgreSQL 写入及回滚；默认跳过不代表已验证数据库。

四个 HTTP 入口、API 共享运行时、本人任务完整结果与 JSON 下载已接入，调用规则和部署顺序见[检查业务运行手册](../../docs/runbooks/phase-2-variant-check.md)。任务查询可以凭原始队列操作身份及 PostgreSQL 完成凭据恢复丢失的完成确认；专用 `check-completed` CAS 允许纠正检查任务的失败状态，但不能覆盖取消、其他业务任务或不同创建实例。列表和 WS 保留小引用，详情和下载返回经过敏感字段过滤的完整结果。

本包仍属于 Issue #105 的进行中实现。实际 PostgreSQL/Redis/编译后消费者集成测试需在隔离 CI 通过，不能以本地跳过的测试关闭迁移阶段门禁。`apps/api/test/variant-check.integration.test.ts` 覆盖真实 HTTP → 编译后 Worker → 完整结果及双 API 网关；只替换 Amazon HTTP 传输为固定测试响应。
