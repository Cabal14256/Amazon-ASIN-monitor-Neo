# P2 登出与本人会话管理

Issue #51 增加三个 Neo 接口，使用与 HTTP/WS 鉴权相同的实时数据源。保留 Legacy 路由与数据结构，不切流、不回填。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/v1/auth/sessions` | 当前用户的全部会话，创建时间降序、ID 降序；包括过期和已撤销历史行 |
| POST | `/api/v1/auth/sessions/revoke` | 请求 `{ sessionId }`，撤销本人会话，允许撤销当前会话 |
| POST | `/api/v1/auth/logout` | 撤销当前会话，成功后清理认证和会话提示 Cookie |

## 权限和兼容

三个接口都要求有效 JWT 和 ACTIVE Session，不需要额外 RBAC 权限。所属用户只取鉴权后的 principal，不接受请求中的 userId。撤销 SQL 同时约束 sessionId 和 userId；非本人和不存在均返回 404，不泄露存在性。重复撤销本人已撤销的其他会话仍成功；撤销当前会话后，旧凭据不能再次通过 HTTP 或共享 WS 鉴权。

列表沿用冻结的 `sessionListResultSchema`，含 `user_id`、`user_agent`、`ip_address`、`remember_me`、`created_at`、`last_active_at`、`expires_at` 等 Legacy 字段，时间序列化为 ISO UTC。`remember_me` 使用契约已允许的 boolean。列表不自动删除或隐藏历史行；D4 清理调度另行迁移。

撤销请求沿用共享 `revokeSessionRequestSchema`，非字符串/空值或超过数据库 CHAR(36) 容量的 ID 返回 400。CHAR(36) 历史 ID 不被强制解释为 UUID。成功保留 `{ success: true, errorCode: 0, message }`。

POST 的 Origin 若存在必须精确匹配 `CORS_ORIGIN`，与 Neo 登录规则一致；无 Origin 的已认证客户端可访问。Cookie 清理使用配置名称、Path=/、SameSite=Lax，认证 Cookie 为 HttpOnly，提示 Cookie 可读；生产或 Fastify 解析为 HTTPS 时带 Secure，与 Neo 登录对齐，不直接信任转发协议头。

## 双跑数据源及故障

`AUTH_DATA_AUTHORITY=legacy-mysql` 时所有会话查询/撤销都使用现有 MySQL 鉴权仓库。改为 `postgresql` 时使用同一主库池的有截止事务。不要只切换某个会话接口的数据源；在写冻结和最终同步完成前，保持 Legacy 为权威源。这里沿用主线登录的阶段限制，未替代最终同步门禁。

会话操作最多 8 个同时等待，满载返回 503；数据库 I/O 复用现有鉴权仓库的截止和连接销毁机制。故障返回统一 5xx 信封，日志仅固定操作名/原因，不记录 sessionId、token、用户或数据库载荷。登出数据库失败不伪装撤销成功、不提前清理 Cookie；在已通过鉴权的并发登出中，数据库记录已被另一请求撤销或清理视为幂等成功。

撤销不主动广播踢出已有 WebSocket 连接；后续认证使用撤销后的状态。已有连接的重认证/断连周期继续沿用主线 WS 行为，不能据此声称即时断开所有活动连接。

## 验证与回滚

根目录执行 `corepack pnpm --filter api test`、`corepack pnpm --filter db test`、`corepack pnpm build:api`、`corepack pnpm test:contracts`。HTTP 测试通过真实 AuthModule/guards/异常过滤器，覆盖所有权、旧字段、Cookie、Origin、失效会话、错误脱敏及容量恢复。

隔离 Integration 工作流执行 `RUN_INTEGRATION_TESTS=true corepack pnpm --filter api exec vitest run test/sessions.integration.test.ts`，分别通过生产仓库工厂选择 PostgreSQL/MySQL，校验真实持久化、本人/他人隔离、重复撤销、历史非 UUID ID、北京时间与登出后旧凭据拒绝；按随机 userId 清理自有数据。本机未配置隔离数据库时显示 skipped，实际执行结果由远端提供。

无 UI 或 URL 组装变化，根契约继续验证请求/导出 `/api` 去重。回滚本 PR 移除三个 Neo 端点，已有 Legacy 服务与会话记录保留；已完成的撤销不自动恢复。无 DDL，无数据库回滚步骤。
