# 变体检查共享业务

API 和 Worker 共用的主 ASIN 检查业务。Catalog 抓取、配额、回退、缓存和父体查询在 `@asin-monitor/sp-api`；本包负责当前权限检查、PostgreSQL 状态/历史事务及完整业务结果。

SQL 实现统一位于 `packages/db/src/repositories/variant-check-repository.ts`，数据库业务类型位于 `packages/db/src/domain/variant-check.ts`。本包的对应入口仅作重导出，编排层不包含 SQL。批量 Catalog 结果编解码在 `packages/sp-api/src/catalog-hybrid-result.ts`，数据库包使用它校验结果，依赖方向不形成环。

`VariantCheckRuntime` 统一组装检查管线和父体查询，接收应用已有的 `SpApiRuntime`、数据库仓库以及禁止离线排队/自动重发的 Redis 连接。它负责关闭本包创建的组件，应用继续负责基础连接的生命周期。应用应将共享环境的 `MONITOR_BATCH_ASIN_THRESHOLD` 传入 `batchThreshold`；默认 0，正小数向上取整以保持 Legacy 的数量比较语义，超过组上限 5000 会在启动校验时报错。

`VariantCheckPipeline` 先授权并读取快照，在事务外调用 Catalog，再按组 → ASIN 顺序锁定并核对商品身份与检查时间。提交时保留最新的手工标记、组继承和排除设置，响应反映已提交记录的时间及有效状态。单 ASIN 检查原子写入完整历史；组检查本身不额外创建历史。空组保留 Legacy 的读取结果。

每个调用必须提供 `authorize(unit)` 和 `checkpoint()`。HTTP 调用由前者校验当前会话和权限；兼容匿名路由需要调用层明确提供匿名策略。已受理任务的调用层负责其授权策略，以及任务所有者、创建实例、租约、过期和取消检查。这些回调会在读取前、网络阶段及持锁写入边界重复执行，不能省略为隐式默认值。

共享管线最多接纳 8 个操作，组内最多并行检查 3 个商品，整体期限 15 分钟。等待者取消后，尚未结束的底层工作仍占用名额。完整响应及累计观察结果上限为 32 MiB；最终序列化检查在数据库仍可回滚时完成。`raw` 和每项 `variantView` 保留 Legacy 嵌套结构，不能用截断结果替代。

提交后的缓存清理最多并发 8 项、等待 2 秒，失败只记录固定原因的 `warn`。清理超时仍保留实际 I/O 的容量占用。已确认提交的业务不会因清理失败变成失败；提交期间取消或丢失数据库确认会抛出 `VariantCheckCommitUncertainError`。调用方不得盲目重试可能已写入的历史；实际 Worker 仍须实现持久化完成凭据及重放处理。

非强制组检查达到 `batchThreshold` 时，可启用 `CatalogHybridChecker`。它按最多 20 个唯一 ASIN 搜索，收齐有界分页后再按原始顺序对有变体或搜索失败的商品查询详情，保留重复输入和 Legacy 的较小批量结果结构。搜索缺失项是 `NO_VARIANTS`，不冒充确认的 `NOT_FOUND`；详情失败保留搜索证据，错误文本使用固定安全消息。任务检查点失败、取消、依赖不可用等条件会停止后续工作。

Legacy 批量代码错误地使用 POST 请求体。新实现遵循 [Amazon Catalog Items 官方接口](https://developer-docs.amazon/sp-api/docs/catalog-items-api-v2022-04-01-reference)，使用 GET、CSV `identifiers`、`identifiersType=ASIN` 和 `pageSize=20`。请求仍经过已有的签名、共享配额及重试层。操作配额沿用现有保守配置，本次不提高限流上限。

验证：

- `corepack pnpm --filter @asin-monitor/variant-check typecheck`
- `corepack pnpm --filter @asin-monitor/variant-check test`
- 设置 `RUN_INTEGRATION_TESTS=true` 和隔离的 `DATABASE_URL` 后，运行 `test/repository.integration.test.ts` 验证实际 PostgreSQL 写入及回滚；默认跳过不代表已验证数据库。

本包属于 Issue #105 的进行中实现。四个 HTTP 入口、两个实际 BullMQ 处理器、应用配置和任务完整结果存储仍需接入，不能据此关闭迁移阶段门禁。
