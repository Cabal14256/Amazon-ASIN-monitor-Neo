# P2 登录迁移与验证

关联 Issue：#31。范围仅为 Neo `POST /api/v1/auth/login`，复用已存在的 `GET /api/v1/auth/current-user` 验证新 Session。没有新增数据库表或迁移，没有更改 Legacy 路由、代理或生产配置。

## 权威源与发布门槛

- 双跑期保持 `AUTH_DATA_AUTHORITY=legacy-mysql`，使用 Legacy 登录入口；Neo 登录返回 503，不访问 PG 登录仓储或验证密码。
- `postgresql` 只允许用于已完成最终同步、冻结 MySQL 鉴权写入的目标环境；同时使用同一个 `JWT_SECRET` 和约定的 Cookie 名称。不能让两套数据库各自创建、撤销或更新同一账号的 Session。
- 当前仅适合隔离验证。生产切换还需要全局限流（#21）、审计（#23）、剩余鉴权接口（密码修改/历史、注销、Session 管理、个人资料）、清理调度和整体 P2/灰度 Gate。此 PR 不声称满足这些门槛。
- 测试账号必须是专用 fixture；禁止使用真实账号、Token、数据库连接密码作为测试日志或 PR 证据。

## 事务和兼容行为

用户名通过 `lower(username)` 匹配现有大小写不敏感唯一索引，并获取用户行锁。该约定不额外声称兼容 MySQL 的所有重音/排序规则。

真实登录集成测试同时暴露了 D8 时间映射缺陷：Drizzle 会覆盖连接池 OID 1114 parser，默认 Date 字段的读写按 UTC 解释 `timestamp without time zone`，与库内上海墙钟时间不一致，导致 Session 到期和锁定时间偏移 8 小时。主库/竞品库的共享时间字段现使用同一个显式 UTC+8 双向转换器，SQL 类型仍为 `timestamp without time zone`，没有改表或批量移动既有数据；原始 pg.query 保留 OID parser。补充跨日/跨年/闰日、全部时间列、真实 Drizzle 读取和写入参数单测，并验证真实数据库中过期一小时的 Session 不能继续访问 current-user。[Drizzle 自定义类型转换](https://orm.drizzle.team/docs/custom-types)

失败结果也需要提交：密码错误记一次 `login_attempts` 并递增失败计数，第五次返回 401 同时锁定 30 分钟，之后的请求返回 423；不会因抛 HTTP 异常而回滚失败计数。不存在的用户执行一次公开 dummy hash 验证并记录失败，不创建 Session。锁定过期清除计数，但不会把已停用用户重新激活。

成功路径把登录信息、计数重置、密码过期强制修改标记、成功尝试和 Session 保存为同一事务。响应继续显式映射公开用户字段，不返回密码哈希。密码过期仍允许登录，并返回 `mustChangePassword`/`passwordExpired`；本 PR 只提供标记，不新增其他业务路由的强制改密拦截，完整密码修改流程和策略验收属于上线前置条件。业务校验失败与依赖故障分别返回既有 400/401/403/423 和 500 信封，503（权威源未切换）与 429（并发容量已满）是新入口的额外保护结果。

意外失败会中止并销毁独占数据库连接，让未提交写入回滚。不把原始 SQL、密码、用户名、IP 或数据库错误对象写入运行日志；仅记录固定错误分类。登录尝试表和 Session 内的账号/IP 字段属于既有业务数据，不是日志脱敏的替代品，保留/清理策略仍需后续调度任务完成。

如果数据库已经提交、但 COMMIT 回执在网络中丢失，客户端仍可能得到 500 且不收到 Token/Cookie，而数据库保留本次 Session 或失败计数。这是提交结果未知，不承诺任何网络故障都能撤销已经提交的数据；客户端重试可能产生另一条 Session/尝试记录。不能根据一次 500 擅自回退 MySQL 或清除失败计数，未使用 Session 需由后续到期清理处理。

## 资源和 Cookie 边界

- 单实例最多 8 个在途登录事务（包括等待锁/连接和密码计算），第 9 个返回 429；实际 bcrypt 计算另外有进程级 8 个槽位，在计算真正结束之前不会因事务超时提前释放。这不是跨实例或按时间窗口限流，不能替代全局限流。
- 用户名最多 50 个字符，密码输入最多 1024 个 JavaScript 字符；拒绝非字符串和错误的 `rememberMe` 类型。不会 trim 或改写密码。
- 兼容旧系统 cost 10 bcrypt 哈希，只允许 cost 4–12，异常工作因子在计算前拒绝并返回 500。保留 bcrypt 既有的 72 字节截断行为，不能把本登录迁移当作新密码强度/长度策略。[bcrypt.js 官方说明](https://github.com/dcodeIO/bcrypt.js)
- 获取连接受 `DATABASE_POOL_CONNECTION_TIMEOUT_MS` 约束（默认 2 秒，配置范围 50–30000 毫秒）；取得连接后沿用鉴权事务 2 秒总截止及事务内 SQL 1.5 秒截止。默认两段累计约 4 秒，调整池配置时累计上限为该配置加 2 秒，不宣称包含取连接的总期限只有 2 秒；事务截止不修改导出/分析共享池的全局设置。
- JWT 使用 HS256、`userId`/`sessionId`，默认有效期为 7 天，记住登录为 30 天；支持现有单位配置，但最终秒数必须在 1 秒至 10 年范围。JWT `exp`、Session `expires_at`、Cookie `expires` 对齐。
- Fastify Cookie 的 `maxAge` 使用秒，不使用 Express 的毫秒。认证 Cookie 为 HttpOnly；登录提示 Cookie 值为 `1`，可由前端读取；两者均为 `Path=/`、`SameSite=Lax`，仅在事务成功返回后设置。
- 生产强制 Secure；非生产根据 Fastify 的受信 `request.protocol` 设置，不直接相信请求自带的 `X-Forwarded-Proto`。生产需要 HTTPS；如启用反向代理信任，必须限制受信代理来源。
- 有 Origin 的请求必须精确匹配 `CORS_ORIGIN`；不接受 `null` 或跨站来源。无 Origin 的非浏览器请求仍必须提交有效凭据。

## 验证

从仓库根目录执行：

```sh
corepack pnpm build:api
corepack pnpm --filter api test
corepack pnpm --filter api exec tsc --noEmit --rootDir . --pretty false
corepack pnpm test:contracts
```

HTTP/单元测试覆盖请求校验、权威源阻断、签名及两个 TTL、Cookie 秒数/安全属性、来源拒绝、五次锁定、解锁/停用、密码过期、8 个并发上限、失败不发 Cookie、日志不含凭据以及 bcrypt 兼容验证。根契约测试继续验证请求和导出 URL 不出现重复 `/api`。

真实 PostgreSQL 测试默认跳过，必须在显式设置 `RUN_INTEGRATION_TESTS=true` 并注入隔离环境配置后执行：

```sh
corepack pnpm --filter api exec vitest run test/login.integration.test.ts
```

Integration CI 已使用其一次性 PostgreSQL/TimescaleDB 服务执行：验证大小写用户名登录及新 Token 访问 current-user、记住登录与过期标记、五个并发错误密码的原子计数、插入 Session 后失败时全部回滚、真实行锁等待超时且不产生 Session/Cookie。fixture 只清理本次随机前缀用户、关联 Session 和登录尝试，不修改业务账号。CI 验收不能替代生产规模性能、最终数据同步或灰度验证。

## 回滚

在隔离验证阶段撤销本 PR 的路由/仓储/依赖接线即可；无数据库 DDL 需要回滚。保留 Legacy 入口及原流量路由。

一旦生产 PG 已接受鉴权写入，不得直接把 `AUTH_DATA_AUTHORITY` 改回 MySQL，否则可能重新接受已撤销的会话或恢复旧账号状态。应先停止鉴权写入，按既有数据库回滚 runbook 执行最新数据回灌、校验和审批后再切换；无法可靠回灌时应明确使相关 Session 失效并要求重新登录，不假定旧库自动拥有新状态。参见 [P1 数据库回滚](./phase-1-database-rollback.md)。
