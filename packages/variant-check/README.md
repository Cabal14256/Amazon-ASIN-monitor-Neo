# 变体检查共享业务

API 和 Worker 共用的主 ASIN 检查业务。Catalog 抓取、配额、回退、缓存和父体查询在 `@asin-monitor/sp-api`；本包负责当前权限检查、PostgreSQL 状态/历史事务及完整业务结果。

`VariantCheckPipeline` 先授权并读取快照，在事务外调用 Catalog，再按组 → ASIN 顺序锁定并核对商品身份与检查时间。提交时保留最新的手工标记、组继承和排除设置，响应反映已提交记录的时间及有效状态。单 ASIN 检查原子写入完整历史；组检查本身不额外创建历史。空组保留 Legacy 的读取结果。

每个调用必须提供 `authorize(unit)` 和 `checkpoint()`。HTTP 调用由前者校验当前会话和权限；兼容匿名路由需要调用层明确提供匿名策略。已受理任务的调用层负责其授权策略，以及任务所有者、创建实例、租约、过期和取消检查。这些回调会在读取前、网络阶段及持锁写入边界重复执行，不能省略为隐式默认值。

共享管线最多接纳 8 个操作，组内最多并行检查 3 个商品，整体期限 15 分钟。等待者取消后，尚未结束的底层工作仍占用名额。完整响应及累计观察结果上限为 32 MiB；最终序列化检查在数据库仍可回滚时完成。`raw` 和每项 `variantView` 保留 Legacy 嵌套结构，不能用截断结果替代。

提交后的缓存清理最多并发 8 项、等待 2 秒，失败只记录固定原因的 `warn`。清理超时仍保留实际 I/O 的容量占用。已确认提交的业务不会因清理失败变成失败；提交期间取消或丢失数据库确认会抛出 `VariantCheckCommitUncertainError`。调用方不得盲目重试可能已写入的历史；实际 Worker 仍须实现持久化完成凭据及重放处理。

验证：

- `corepack pnpm --filter @asin-monitor/variant-check typecheck`
- `corepack pnpm --filter @asin-monitor/variant-check test`
- 设置 `RUN_INTEGRATION_TESTS=true` 和隔离的 `DATABASE_URL` 后，运行 `test/repository.integration.test.ts` 验证实际 PostgreSQL 写入及回滚；默认跳过不代表已验证数据库。

本包属于 Issue #105 的进行中实现。批量搜索优化、四个 HTTP 入口、两个实际 BullMQ 处理器和任务完整结果存储仍需接入，不能据此关闭迁移阶段门禁。
