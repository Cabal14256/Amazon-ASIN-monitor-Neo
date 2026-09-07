# P2 用户列表与详情

Issue #59 将用户管理的两个只读接口接入 Neo PostgreSQL。角色下拉由 Issue #57 提供；创建、更新、删除、批量删除和管理员重置密码仍待后续迁移。本次不改动 Legacy 入口、数据库结构或生产流量。

## 路由与权限

| 方法 | Neo 路径 | 结果 data |
| --- | --- | --- |
| GET | `/api/v1/users` | `{ list, total }`，用户公开字段及角色摘要 |
| GET | `/api/v1/users/:userId` | 用户公开字段、`roles`、`permissions`、`statusHistory` |

两个接口均使用 AuthenticationGuard / PermissionsGuard，要求有效账号、Session 和 `user:read`。ADMIN 名称不隐含权限，`user:write`、`role:read` 也不替代 `user:read`。既有 `/api/v1/users/roles/all` 继续要求 `role:read`。

只有 `AUTH_DATA_AUTHORITY=postgresql` 时读取 PostgreSQL；已通过鉴权但权威源仍为 `legacy-mysql` 时返回 503，并提示使用现有用户管理入口，防止把迁移副本当作实时权威数据。未认证返回 401，无权限或未完成密码要求返回 403，用户不存在返回 404。成功信封为 `{ success: true, errorCode: 0, data }`。

## 查询与兼容行为

- 列表接受 `username`、`status`、`current` 和 `pageSize`，拒绝未知参数、重复参数数组和非法类型。默认第 1 页、每页 10 条，最多每页 100 条；页码及最终 offset 必须为安全整数。用户名筛选最多 200 字符并拒绝控制字符，ID 最多 50 个 Unicode 字符并拒绝控制字符。
- `username` 为忽略大小写的包含匹配；保留 Legacy SQL LIKE 的 `%`、`_` 通配符。空 username 或 status 表示不筛选。非空 status 接受共享五种标准状态，不接受任意字符串。全部值使用 SQL 参数绑定。
- status 筛选针对持久化的状态列，与 Legacy 一致。响应状态另按既有规则归一化：未来的 `locked_until` 可将 ACTIVE 显示为 LOCKED；显式 LOCKED 不因时间过期自动变为 ACTIVE。列表不是登录解锁操作，不更新用户状态。
- 返回 `{ list, total }`，不新增 Legacy 未回显的页码字段。用户按创建时间降序、ID 降序，NULL 创建时间最后；角色和权限按 code 排序。PostgreSQL 与 MySQL 的具体 Unicode/重音排序可能不同，生产对拍仍需覆盖实际用户名。
- 用户公开字段保留 snake_case、合法 NULL 日期和空资料；`force_password_change` 归一化为布尔值，NULL 失败次数沿用现有 Neo 公开资料映射为 0。仓储明确选择公开列，不查询 password、password_hash 或 last_failed_login。
- 详情返回角色摘要、去重权限码和最近 10 条状态历史。历史按创建时间降序、ID 降序，NULL 时间最后；`old_status`、`reason`、`changed_by` 及日期允许 NULL，历史 bigint ID 不能安全转为 JavaScript 整数时显式失败，避免舍入。
- 日期通过既有北京时间 Drizzle codec 读取，JSON 返回 ISO UTC。例如数据库 `2026-09-01 08:00:00` 返回 `2026-09-01T00:00:00.000Z`，不受机器时区影响。

## 一致性、容量与故障

同次列表的总数、用户行和角色来自一个只读 REPEATABLE READ 快照；详情的用户、角色、权限和历史也来自同一快照。非空列表固定三条业务 SELECT，按当前页用户 ID 批量读取角色，避免每个用户再查询一次。空页省略角色查询。

每个 API 实例最多同时处理 8 个用户查询，超出立即返回 429。连接获取由应用池 `DATABASE_POOL_CONNECTION_TIMEOUT_MS` 约束；取得独占连接后总执行截止 2 秒，单 SQL 截止 1.5 秒。超时或 SQL 故障销毁该事务连接，不影响共享池其他连接的设置。数据库故障返回固定 500；日志仅记录 list/detail 操作和固定原因，不输出筛选内容、用户名、IP、状态原因、SQL 或原始异常。

用户名包含匹配、计数及深分页可能扫描大量数据。截止时间是容量保护，不能代替真实用户规模下的延迟验收。本次没有新增表达式索引或生产性能报告。

## 验证与回滚

从仓库根运行 `corepack pnpm --filter contracts build`、`corepack pnpm build:db` 后，再执行 `corepack pnpm --filter api test`；API 使用 contracts 的 dist 导出，不能用旧构建产物判断新契约。另执行共享契约、API 测试类型检查和完整新旧基线。

HTTP 测试使用真实 Guards，覆盖两路由、权限分离、权威源门禁、公开响应、参数、状态、404、异常脱敏、安全 bigint 和并发容量释放。Integration 在隔离 PG16/TimescaleDB 执行 `RUN_INTEGRATION_TESTS=true corepack pnpm --filter api exec vitest run test/user-query.integration.test.ts`，验证真实分页/NULL/时区/角色批量查询、状态历史、列表及详情的并发快照，以及数据库锁超时与恢复。认证数据也来自该 PostgreSQL；该组 Redis 缓存采用隔离夹具，真实 Redis 失效由角色管理集成测试覆盖。

集成夹具使用随机用户/角色，清理仅按自有 ID 删除记录。本地没有隔离数据库时该组 skipped，关联 PR 中记录远端实际执行结果；不将跳过或 CI 隔离数据当作生产出口证据。

根 `corepack pnpm test:contracts` 保留请求/导出 `/api` 前缀去重回归。本次没有 UI 变更或 DDL。回滚代码即移除 Neo 用户查询入口，已存在的数据与 Legacy 用户管理不受影响，无需数据库回滚脚本。
