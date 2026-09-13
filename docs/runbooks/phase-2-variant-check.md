# Neo 主 ASIN 变体检查（Issue #105）

四个业务入口共用 `packages/variant-check` 与 `packages/sp-api`，SQL 收敛在 `packages/db`。双跑期间继续保留 Legacy；这些入口要求 `AUTH_DATA_AUTHORITY=postgresql`。

| 方法 | 路径 | 同步与异步 |
| --- | --- | --- |
| POST | `/api/v1/asins/:asinId/check` | 无凭据时同步；有凭据时默认创建本人任务 |
| POST | `/api/v1/variant-groups/:groupId/check` | 同上 |
| POST | `/api/v1/variant-groups/batch-check` | 当前登录与 `asin:read`；默认异步，批量超过配置阈值时强制异步 |
| POST | `/api/v1/variant-check/batch-query-parent-asin` | 当前登录与 `asin:read`；默认异步，可显式同步 |

成功返回 HTTP 200、冻结 Result 契约和 `Cache-Control: no-store`。提供无效凭据不会降级为匿名。匿名显式要求异步返回 401，避免创建无所有者任务。Origin 提供时必须与配置一致。

`useAsync` 优先取 body，再取 query；支持布尔值和 true/1/yes/on、false/0/no/off。无效值按登录状态使用默认值。单 ASIN/组的强制刷新保持 Legacy 比较规则：query 的字符串 `false` 或 body 的布尔 `false` 才关闭刷新。批量只以 body 的布尔 `false` 关闭。父体输入最多 1000 项、批量最多 1000 个组；输入顺序和重复项保留。

## 运行配置与升级

- `BATCH_CHECK_SYNC_MAX_GROUPS` 默认 20；无效或非正值回退 20，正小数向下取整（小于 1 时强制所有非空批量走异步），最大 1000。
- `BATCH_CHECK_SYNC_CONCURRENCY` 默认 3，`BATCH_CHECK_GROUP_CONCURRENCY` 默认 2；正数向下取整并限制为 1–8，无效或非正值使用默认值。
- `MONITOR_BATCH_ASIN_THRESHOLD` 默认 0；正值启用非强制组检查的批量 Catalog 搜索。详情、搜索、父体查询仍经过实际 SP-API 配额、重试和回退层。
- 在最终 Legacy 数据快照和既有主库升级之后运行 `corepack pnpm db:upgrade:variant-check-receipts`，显式安装 `0006_variant_check_receipts.sql`。Worker 启动会检查完成凭据表；本次不改动竞品库。
- 按现有 Worker 选择器启用 `variant-check,batch-check`。两个队列使用 `${BULL_PREFIX}:neo`，不会消费旧 Bull4 队列。生产仍需完成整体迁移阶段门禁后再切流量。

## 执行、重试与结果

同步请求先校验当前权限和快照，在事务外抓取 Catalog，再锁定和复核商品并保存。单 ASIN 状态与完整历史原子提交；组检查不额外创建监控历史。当前手工标记、继承和排除设置在提交时重新计算。

异步请求先提交 PostgreSQL 授权读取，再创建 Redis 所有者元数据并入队。提交结果不确定时返回固定错误及原 taskId，应查询该 ID；不能换 ID 盲目重发。已受理任务采用与导入相同的策略：退出登录不撤销任务；Worker 持续核对原任务身份、有效期、BullMQ 租约和取消。

执行器保存完整 PostgreSQL 完成凭据，绑定 taskId、owner、精确 createdAt、队列类型、子类型、步骤、有效期和原始请求摘要。单 ASIN/组凭据与业务写入同事务；批量每组独立记录，重试恢复已经提交的组，最终完整汇总也保存凭据。Worker 使用既有两次尝试和 5 秒指数退避。

`GET /api/v1/tasks/:taskId` 和 `/download` 仅供当前本人访问，并在读取检查结果前后核对当前会话与 `asin:read`。列表/WS 保留小引用；详情与下载返回完整业务 JSON，并过滤内部路径和凭据等字段。单条上限 32 MiB，超过容量时当前写入回滚，不能用截断结果冒充成功。下载使用 `check-result-<taskId>.json` 和统一规范化 API URL。

队列最后一次尝试失败也可能已有数据库结果。任务查询从经过验证的原始队列数据重建请求身份，等待同一操作的提交锁，确认凭据后用专用 `check-completed` CAS 恢复完成状态并通知各 API。CAS 再次核对 owner/type/subtype/createdAt，保留取消状态，禁止复活已过期元数据。其他业务任务的终态规则不变。若元数据已过期，仍可按留存队列中的本人身份读取有效结果，不重建元数据。

批量取消沿用现有任务取消入口：运行前可移除，运行中在检查点停止；已提交状态/历史保留。`variant-check` 不在冻结 Legacy 取消映射中，继续返回 400。过期凭据由 Worker 每分钟单次清理，最多 500 条，跳过其他事务锁定的行。

## 验证与回滚

- 本地：API 的 `variant-check.test.ts`、`variant-check-task-results.test.ts`、现有任务查询/下载测试；Worker 的 `variant-check-processor.test.ts`；完整共享包与数据库单元测试；API/Worker/测试类型检查和请求/导出 URL 验证。
- 隔离 CI：`packages/variant-check/test/repository.integration.test.ts` 验证真实提交、丢失 COMMIT 确认、并发重试、历史只写一次及升级/回滚。`apps/worker/test/variant-check-entry.integration.test.ts` 验证实际编译后进程注册两个消费者。
- `apps/api/test/variant-check.integration.test.ts` 验证 HTTP → 实际共享管线 → 编译后 Worker → PostgreSQL 完整结果/下载 → 双 API 网关，覆盖本人隔离、取消及重试耗尽后的恢复。只替换 Amazon HTTP 传输，使用隔离 schema 和随机 Redis 前缀；默认跳过不代表已通过集成验证。
- 回滚前停止相关 API 生产者和两个消费者，保留仍需下载的结果，再执行 `0006_variant_check_receipts.rollback.sql`。该脚本删除完成凭据，保留 ASIN、组和历史。回滚后禁止重放此前队列任务，以免失去去重依据；Legacy 路径继续保留。

本阶段不包含监控调度、竞品检查、业务页面与生产数据切换，不能据此宣称完整重构或生产迁移完成。
