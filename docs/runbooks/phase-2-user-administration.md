# P2 用户创建、更新与删除

Issue #61 迁移四个用户写接口，配合已有的用户查询和角色管理。管理员重置密码仍由后续任务迁移；不改动 Legacy、数据库结构或生产流量。

## 接口与请求

| 方法 | Neo 路径 | 权限 | 成功结果 |
| --- | --- | --- | --- |
| POST | `/api/v1/users` | `user:write` | data 为公开用户及角色摘要 |
| PUT | `/api/v1/users/:userId` | `user:write` | data 为更新后公开用户及角色摘要 |
| DELETE | `/api/v1/users/:userId` | `user:delete` | message 为删除成功 |
| POST | `/api/v1/users/batch-delete` | `user:delete` | data 为批量删除统计 |

成功 HTTP 状态均为 200，并使用 `{ success: true, errorCode: 0, ... }`，保持 Legacy 行为。所有接口要求有效账号、Session 和明确权限；ADMIN 名称不隐含授权。带 Origin 的请求必须精确匹配 `CORS_ORIGIN`。只有 `AUTH_DATA_AUTHORITY=postgresql` 时开放写入；双跑期仍为 `legacy-mysql` 的已认证请求返回 503，维持旧管理入口。

创建接受 `username`、`password`、`real_name`、`roleIds`、`forcePasswordChange`；更新接受 `real_name`、`status`、`roleIds`、`statusReason`；批删接受 `userIds`。使用共享契约并忽略未知字段。用户名和 ID 最多 50 个 Unicode 字符且拒绝控制字符，用户名不可全空白；姓名最多 100 字符，原因最多 255 字符并拒绝 NUL。角色输入最多 100 项，去重和过滤空字符串后至少一个有效角色。批删原始输入最多 100 项，去空白和去重后仍需非空，按输入顺序处理。

密码遵循共享强度规则，不可等同用户名；上限 1024 字符且拒绝 NUL。创建使用 bcrypt cost 10，在取得数据库锁前执行，复用全进程最多 8 个密码计算名额。服务另限制最多 8 个用户管理操作，过载返回 429，不排无限队列。默认 `forcePasswordChange=true`，密码有效期由 `PASSWORD_EXPIRE_DAYS` 控制，默认 90 天；姓名空字符串创建时转为 NULL，编辑时保留空字符串，与 Legacy 一致。

## 事务和管理员保护

所有写入先取得与角色管理共享的全局 RBAC advisory transaction lock，再锁操作者用户和 Session，重新从 PostgreSQL 校验账号、密码要求、Session 和本次写权限；随后锁目标用户。HTTP Guard 之后排队期间被撤权的请求不能继续写入。本人改密、登录等既有路径的用户行锁仍负责账号级串行化。

- 创建在同一事务中检查大小写不敏感的用户名唯一性、有效角色、插入用户和分配角色，再读取公开响应。密码哈希不会进入响应或日志。
- 更新资料、角色和状态处于同一事务。状态变化写入历史；变为非 ACTIVE 时撤销全部 Session；激活清除失败次数、上次失败时间和临时锁。未改变状态时不重复写历史。
- 沿用 Legacy 的自身管理员角色保护、不能禁用/锁定/停用自己、不能删除自己，以及管理员保留检查。管理员角色按 `ADMIN` 识别；启用管理员计数依据持久化 ACTIVE 状态，目标用户状态沿用现有归一化，不能将此检查视为保证所有管理员始终可以登录。
- 管理事务通过共享锁串行检查管理员数量，避免两个管理请求同时移除最后的管理员。直接 SQL 或未遵循共享锁约定的外部管理写入不受此保护。
- 删除依赖既有外键级联清理角色、Session、密码历史和状态历史；审计记录保留，供追溯。

获取连接使用应用池截止设置；取得独占连接后总执行截止 2 秒，单 SQL 截止 1.5 秒。数据库错误或总截止导致整笔事务回滚并返回固定 500；销毁故障连接，禁止超时响应后继续排队写入。

## 批量删除与缓存

结果为 `{ totalRequested, deletedCount, skipped, failed }`。自己、缺失用户和最后管理员进入 skipped；每个候选用户的查询、检查和删除使用独立 SAVEPOINT。可恢复 SQL 错误先真实回滚并释放保存点，再记为固定“删除失败”；若连接或总截止已失效、无法恢复保存点，则整批回滚，不能返回部分成功。只有实际删除成功才消耗管理员删除额度，最终统计在整个事务提交后返回。

事务提交后推进 PostgreSQL 权限缓存版本，角色变化和删除不会被旧在途读取回填覆盖。Redis 降级和 PostgreSQL 提交之间的跨实例撤权窗口沿用[角色管理运行说明](./phase-2-role-management.md)，不能将缓存推进误认为跨数据库原子提交。日志只记录操作和计数，失败仅记录固定原因，不输出用户名、状态原因、密码、哈希、请求对象或原始 SQL 错误。

## 验证与回滚

从根目录构建 contracts 和 db，再执行 API 全量测试、测试类型检查以及新旧完整基线。HTTP 测试覆盖四路由、权限/Origin/权威源、密码默认值、参数、管理员保护、事务内重新鉴权、批量统计和失败路径；角色管理测试同时覆盖提取后的共享授权逻辑。

Integration 通过 `RUN_INTEGRATION_TESTS=true corepack pnpm --filter api exec vitest run test/user-administration.integration.test.ts` 验证真实 bcrypt/登录、审计脱敏、状态/Session/权限缓存、SQL 回滚、最后管理员并发、保存点恢复、级联删除、排队撤权与锁超时。

该组创建随机私有 PostgreSQL schema，复制现有认证表的列、检查、索引和 identity，再将实际外键定义重绑定到私有表，以便控制管理员数量且不修改前序夹具。PostgreSQL `LIKE ... INCLUDING ALL` 为 identity 创建独立序列，但不复制外键，处理依据见[PG16 CREATE TABLE 文档](https://www.postgresql.org/docs/16/sql-createtable.html)。测试在私有表设置固定 SQL 故障触发器；关闭应用后只删除本次随机 schema，Redis 仅删除自身用户键，不重置共享缓存版本。该组不构成生产数据或容量验收。

本地未配置隔离 PG 时集成组 skipped，远端实际结果记录于 PR。请求/导出 URL 组装不变，根契约测试保留 `/api` 去重检查。

回滚代码可关闭 Neo 用户写入口，不涉及 DDL 回滚。已提交的用户创建、资料、角色和状态变化需依据审计做业务恢复；已删除账号及其级联数据不能仅靠回滚代码找回，需要从事先保留的数据库备份恢复。生产切流前仍须完成备份与恢复演练。
