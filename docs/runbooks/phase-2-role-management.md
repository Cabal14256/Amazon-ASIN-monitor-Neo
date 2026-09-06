# P2 角色权限管理

Issue #57 迁移四个角色权限接口和用户管理的角色下拉接口。Neo 使用 PostgreSQL 的现有 RBAC 表，不增加 DDL；Legacy 的 Express 路由、MySQL 写入和缓存语义保留。用户列表、创建、编辑、删除及管理员重置密码仍待后续迁移。

## 接口与权威源

| 方法 | Neo 路径 | 权限 | 结果 data |
| --- | --- | --- | --- |
| GET | `/api/v1/roles` | `role:read` | 角色数组，包含权限摘要 |
| GET | `/api/v1/roles/:roleId` | `role:read` | 单个角色及权限摘要 |
| GET | `/api/v1/permissions` | `role:read` | `{ list, grouped }` |
| PUT | `/api/v1/roles/:roleId/permissions` | `role:write` | `{ roleId, permissions }` |
| GET | `/api/v1/users/roles/all` | `role:read` | 不含权限的角色数组 |

所有接口要求有效账号和 Session；ADMIN 名称不隐含授权。成功信封为 `{ success: true, errorCode: 0, data }`。只在 `AUTH_DATA_AUTHORITY=postgresql` 时开放；双跑期间设置为 `legacy-mysql` 时，已通过鉴权的请求返回 503 并指向现有管理入口，避免读写尚未成为权威的数据副本。切换权威源仍须先完成数据同步并冻结 MySQL 鉴权写入。

角色字段保留 `create_time`、`update_time`，权限字段保留 `resource`、`action`、`create_time`，数据库 NULL 原样返回 null。分组中的权限省略 `create_time`；空 resource 归入 `other`。角色按 code 排序，权限总表按 resource/action 排序且 NULL 在前，角色内权限按 code 排序，均以 ID 打破平局。日期使用既有北京时间 Drizzle codec 读取，再返回 ISO UTC。PostgreSQL 与 MySQL 的具体字符排序仍需以生产数据对拍。

## 写入、权限保护与并发

PUT 接受 `{ permissionIds: string[] }`，忽略未知对象字段、去重并过滤空字符串，保持 Legacy 表单兼容。原始数组最多 1000 项；角色及非空权限 ID 最多 50 个 Unicode 字符，拒绝控制字符。非法参数或不存在的权限返回 400，缺失角色返回 404。带 Origin 的请求必须精确匹配 `CORS_ORIGIN`；无 Origin 的原生/Bearer 请求继续由认证和权限守卫校验。

写事务先取得全局 RBAC advisory transaction lock `(1095977294, 1380073795)`，再依次锁定操作者用户、Session。取得锁后重新读取账号状态、密码要求、Session 和 PostgreSQL `role:write`，防止在 HTTP Guard 通过后排队期间被撤权的请求继续写入。后续 Neo 用户角色分配、账号状态及管理员管理事务必须复用 `lockRoleAdministration`，并保持全局锁先于用户/Session 锁的顺序；直接 SQL 或不遵守此约定的外部写入不受该保护。

如果操作者属于目标角色，新权限必须完整保留 `user:read`、`user:write`、`user:delete`、`role:read`、`role:write`、`audit:read`。即使其他角色已有这些权限，也不放宽 Legacy 的自身角色保护。删除旧关联、插入新关联和读取结果处于同一事务；任一步失败整体回滚。成功提交后才刷新权限缓存并由现有审计管道记录 `UPDATE_ROLE_PERMISSIONS`。

角色列表及详情使用只读 REPEATABLE READ 事务，使角色元信息和权限来自同一快照。每个 API 实例最多同时处理 8 个角色管理操作，超出返回 429。连接获取使用应用池的 `connectionTimeoutMillis`；取得独占连接后总执行截止 2 秒，单 SQL 截止 1.5 秒。数据库失败或超时返回固定 500；销毁故障连接中止未完成事务，避免超时响应后继续执行排队写入。日志仅记录操作、固定原因和数量，不记录用户 ID、权限载荷、SQL 或凭据。

## PostgreSQL 权限缓存

Neo PostgreSQL 权限及角色缓存使用独立键 `neo:auth:<generation>:permissions:<userId>` 和 `neo:auth:<generation>:roles:<userId>`，不读取或删除 Legacy 的 `user:permissions:*` / `user:roles:*`。共享 Redis 的 `neo:auth:cache-generation` 通过原子 INCR 推进；角色事务提交后推进版本，使其他 API 实例下一次读取使用新命名空间。迟到的旧查询只能回填旧版本键，不能覆盖新版本；旧键按 `AUTH_PERMISSION_CACHE_TTL_SECONDS` 过期。

进程内失效版本变化时，正在读取的请求最多重新读取三次，持续变化则失败。PostgreSQL 模式下 Redis 不可用时重新查询权威 PostgreSQL，不使用可能已撤权的内存条目；原 Legacy 模式的 Redis/内存 TTL 降级行为不变。缓存写入失败不使已完成的数据库读取失败。

PostgreSQL 提交与 Redis 失效不是分布式原子事务。若失效失败，写入实例保留待修复版本，后续读取重试推进版本，修复前直接读 PostgreSQL；其他实例在推进成功或旧缓存 TTL 到期前仍可能读到旧授权。如果写入实例在提交后退出，该窗口可能持续至 TTL。角色写事务本身始终重新从 PostgreSQL 鉴权。生产切换验收必须覆盖此故障窗口，并在需要立即全局撤权时暂停相关入口、确认 Redis 恢复及缓存版本推进后再恢复流量。Redis 缓存数据库应使用既定持久配置，不能单独删除/回退版本键而保留其旧版本缓存。

## 验证与回滚

根目录执行 `corepack pnpm test:contracts`、`corepack pnpm --filter contracts test`、`corepack pnpm --filter api test`、`corepack pnpm build:api`、`corepack pnpm build:db` 及项目完整基线。HTTP 测试覆盖五个接口、真实 Guards、参数/契约、自身权限保护、事务内重新鉴权、Origin 和脱敏失败；缓存测试覆盖跨实例版本失效、迟到回填、失败修复及 Redis 故障后的权威回查。

Integration 工作流在隔离 PG16/TimescaleDB 和 Redis 中执行 `RUN_INTEGRATION_TESTS=true corepack pnpm --filter api exec vitest run test/roles.integration.test.ts`，覆盖真实持久化与审计、NULL、只读快照、回滚、并发串行化、排队期间撤权和锁超时。测试仅插入随机夹具并清理自有记录/缓存键，不清空 Redis 或重置共享版本。本地未配置隔离数据库时显示 skipped；CI 实际执行结果写入关联 PR，不能把跳过视为通过。

本次不变更请求/导出 URL 组装；根契约测试继续覆盖 `/api` 去重。回滚代码移除 Neo 角色端点并恢复先前 PostgreSQL 缓存实现，角色权限的已提交业务变更仍保留；如需撤销某次授权变更，应依据审计记录通过受控管理操作恢复。无结构迁移或数据库回滚脚本，Legacy 生产入口继续可用。
