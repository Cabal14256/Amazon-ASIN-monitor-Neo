# Neo 本人资料与密码修改

Issue #53 补齐 auth 域 `PUT /api/v1/auth/profile` 和 `POST /api/v1/auth/change-password`。使用现有 Session Guard、共享 snake_case 资料契约和全局审计动作，不涉及数据库结构、管理员账号管理或生产流量切换。

## 权威源与输入

- 两个写接口仅在 `AUTH_DATA_AUTHORITY=postgresql` 启用；`legacy-mysql` 返回 503，继续使用 Legacy 原账号入口，不向 PG 副本写入。上线前仍须最终同步、冻结旧账号写入和按域切换路由。
- 只允许修改认证 principal 本人。存在 Origin 时必须匹配 `CORS_ORIGIN`。资料仅接收 `real_name`，允许空字符串清除，最多 100 个 Unicode 字符且拒绝 NUL。共享契约移除其他字段，不接受角色、状态、用户 ID 或密码注入；响应重新查询公开用户、权限和角色，不返回哈希。
- 密码沿用共享强度策略：至少八位、包含字母与数字、无空白、不在常见弱密码集合；不得等于用户名（不区分大小写）。原密码必须正确，新密码不得等于当前密码或最近五次历史密码。输入不 trim，最多 1024 个 JavaScript 字符，拒绝新密码 NUL。
- 新哈希使用 bcrypt cost 10，比较接受既有 cost 4–12。沿用 bcrypt 的 72 字节截断语义；比较当前/历史哈希同样会拒绝只修改截断后缀的密码，未静默更换密码算法。
- `PASSWORD_EXPIRE_DAYS` 默认 90，可设置整数 1–3650。空值、非正值、小数或超范围值使 Neo 启动校验失败，区别于 Legacy 无效值回退。到期按真实时刻加固定天数计算，经 D8 列映射存为北京时间，避免依赖宿主时区。

## 原子性与容量

先锁本人用户行，再锁当前 Session；在锁内重新检查账号状态与会话有效性，避免等待锁期间已撤销的会话继续写入。资料返回值也在事务内查询。改密比较、旧哈希入历史、按 created_at DESC NULLS LAST/id DESC 留五条、更新 password/password_changed_at/password_expires_at/force_password_change 和可选撤销其他 Session 使用同一事务。

`revokeOtherSessions` 默认 true，保留当前 Session，false 时不撤销；不重置登录失败计数或发新 Cookie。并发请求使用同一旧密码时，后取得用户锁的请求重新比较最新哈希并失败，不能覆盖前一个新密码。历史 ID 保留 bigint，避免迁移后的高位 ID 丢失精度。

账号请求最多八个在途事务，密码计算与登录共享进程级八个 CPU 槽位。超时不能取消 bcrypt，槽位必须等计算实际结束才释放。连接获取受应用池配置约束（默认 2 秒），取得连接后事务硬截止 2 秒、单 SQL 1.5 秒；最坏累计为取连接上限加 2 秒，不修改全局查询设置。超时销毁独占连接，后续每次账号 SQL 先检查事务是否仍有效，迟到的哈希不能触发写入。高成本旧哈希或并发压力下可能达到截止并返回 500，需在目标部署资源上复测。

异常会整体回滚未提交修改；COMMIT 已完成但回执丢失时提交结果仍可能未知，不能把所有 500 解释为数据库未改动。遇到这种情况应重新认证确认状态，不能自动回写旧哈希或切回 MySQL。运行日志仅固定操作和错误分类，不含用户资料、密码、hash、SQL 或原始异常。审计继续独立、尽力写入，不是账号事务的一部分；请求体密码和个人字段由既有审计脱敏器处理。

## 验证与回滚

- `corepack pnpm --filter api exec vitest run test/account.test.ts` 覆盖真实 AuthModule 的 HTTP 契约、非法输入、身份来源、策略、会话竞态、并发容量和日志边界。
- `corepack pnpm --filter db test` 包含事务超时后迟到哈希不会发起 SQL 的回归；Config 测试覆盖密码到期配置。
- 隔离 CI 运行 `corepack pnpm --filter api exec vitest run test/account.integration.test.ts`，验证真实 PG 的资料隔离、历史裁剪、到期时间、审计、并发改密、完整回滚与迟到计算。使用随机测试用户并按归属清理，不依赖生产账号，不重置历史 ID 序列。
- 回退代码可关闭新端点，不需要 DDL 回滚。已经提交的新密码和撤销会话属于用户操作，不随代码回滚恢复；若权威源已切换，数据回切必须按迁移运行手册同步，不允许单改环境变量恢复旧 MySQL。

auth 七个 REST 端点具备实现不表示 P2 出口通过。前端强制改密流程、D4 清理调度、真实数据同步、跨系统路由切换及整体业务验收仍需完成，Legacy 保留。
