# P2 审计日志查询

Issue #41 将 Legacy 审计的四个只读接口接入 Neo。旧 Express 路由、审计写入与数据库结构保持兼容；本次没有 DDL、数据回填或流量切换。

## 路由与鉴权

| 方法 | Neo 路径 | 结果 data |
| --- | --- | --- |
| GET | `/api/v1/audit-logs` | `{ list, total, current, pageSize }` |
| GET | `/api/v1/audit-logs/:id` | 审计详情 |
| GET | `/api/v1/audit-logs/statistics/actions` | `[{ action, count }]` |
| GET | `/api/v1/audit-logs/statistics/resources` | `[{ resource, count }]`，保留 null 分组 |

所有接口均通过真实 AuthenticationGuard / PermissionsGuard，要求有效 Session 和 `audit:read`。沿用 `AUTH_DATA_AUTHORITY` 对应的全部鉴权数据源及权限缓存；权限允许读取全站审计，与 Legacy 一致，不按当前用户强制过滤。未认证返回 401，无权限返回 403，缺失详情返回 404。

成功使用 `{ success: true, errorCode: 0, data }`；记录只含 camelCase 字段，不附带 Legacy snake_case 别名。JSON 历史值可以是对象、数组、标量或 null；null 创建时间省略 `createTime`。响应 ID/计数保持安全整数，遇到不能无损表示的 bigint 显式失败，不返回舍入值。现有 Legacy 契约不变，新校验使用共享 `neoAudit*` 契约。

## 参数与时间

列表支持 `userId`、`username`、`action`、`resource`、`resourceId`、`startTime`、`endTime`、`current` 和 `pageSize`。统计只接受时间范围。未知参数、重复参数数组、非法日期、倒置区间、无效 ID 与分页返回 400。分页默认 1/10，每页最多 100，分页及偏移均须为正或非负安全整数；ID 必须是无前导零的正十进制整数。

- 用户名使用不区分大小写的包含匹配，保留 Legacy SQL LIKE 的 `%` 和 `_` 通配符。其余文本筛选按忽略大小写的完整值匹配。全部值为绑定参数，不拼接为 SQL。
- 无时区的 `YYYY-MM-DD` 或 `YYYY-MM-DD HH:mm:ss[.SSS]` 按固定北京时间 UTC+8 解释；也支持 `T` 分隔及显式 `Z` / `±HH:MM`。不依赖主机 TZ 或数据库会话 TZ。
- 开始和结束边界均包含。仅日期的结束时间表示当日 00:00:00，不自动扩展到日末。例如整个 9 月 1 日可使用开始 `2026-09-01`、结束 `2026-09-01 23:59:59.999`。HTTP 查询中的 `+08:00` 需将 `+` 编码为 `%2B`。
- 返回时间为 ISO UTC，前端沿用北京时间格式化工具。所有范围参数通过同一 Drizzle UTC+8 codec 绑定为本地 timestamp。
- 列表按创建时间降序、ID 降序排列，null 创建时间最后。计数与列表来自同一个只读 REPEATABLE READ 快照，避免并发写入使同次响应不一致。
- 统计忽略 action/resource 大小写分组，返回该组按数据库排序最小的原始拼写；次数降序，拼写升序作为平局顺序。PostgreSQL 的 Unicode/重音排序与 MySQL 的具体 collation 并非完全相同，切流验收需用实际数据核查这些边界。

## 数据来源和容量

仅查询 PostgreSQL 主库 `audit_logs`；双跑期 Legacy 仍写 MySQL，其新增记录不会自动出现在 Neo 查询里。迁移快照与后续同步的完整性属于 P1/P2 切流门禁，不能据此接口可用宣告数据迁移完成。

查询最多同时占用 8 个连接获取/执行名额；超额立即返回 503。获取连接到完成请求总截止 5 秒，事务内单语句超时 4 秒；数据库取消或总超时返回 504，其他查询故障返回 500。全局信封统一使用固定“服务器内部错误”，日志仅含操作名和固定原因，不记录筛选值、SQL、请求或审计行。截止销毁活动连接，迟到连接归还后才释放获取名额，避免隐形队列持续增长。

只读事务及 SET LOCAL 不影响共享池其他查询的超时或可写性。大小写转换、用户名包含查询及全表统计可能扫描较多记录；已有索引未新增表达式索引，也未预聚合。真实生产容量验收仍需验证宽时间范围和深分页 P95；超时保护不等于性能出口通过。

## 验证和回滚

根目录执行 `corepack pnpm --filter contracts test`、`corepack pnpm --filter db test`、`corepack pnpm --filter api test`、`corepack pnpm build:api`。新 HTTP 测试使用真实 guards、DTO 校验和统一异常过滤器，鉴权数据源以虚构夹具隔离。

Integration 工作流在独立 PG16/Timescale 实例执行 `RUN_INTEGRATION_TESTS=true corepack pnpm --filter api exec vitest run test/audit-query.integration.test.ts`，校验真实 SQL 参数、时区、分页、JSON、bigint、大小写/NULL 统计、只读快照和慢 SQL 取消。仅插入和按随机 userId 清理自有数据；本地未配置隔离 PG 时该组显示 skipped，由远端实际执行。

本次不增加 UI，不改变请求/导出 URL 组装；根 `corepack pnpm test:contracts` 继续覆盖 `/api` 前缀去重。回滚本 PR 即移除 Neo 查询端点，既有审计写入及记录保留；无需数据库回滚。
