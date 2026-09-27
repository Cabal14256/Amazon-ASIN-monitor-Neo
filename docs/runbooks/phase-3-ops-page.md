# P3：Neo 运维观测页面

关联 Issue #155、#162。Neo `/ops` 提供当前 PostgreSQL 权威源下的运维概览、分析缓存清理和 Timescale 连续聚合刷新；Legacy 运维入口继续保留，生产流量和数据切换仍按 #48 阶段门执行。

## 已接入范围

- `GET /api/v1/ops/overview`：当前进程角色、调度开关、Neo 分析缓存条目、监控/竞品 BullMQ 队列计数与暂停状态、聚合刷新状态和 Worker 队列配置。
- `POST /api/v1/ops/analytics/cache/clear`：仅清理 `${BULL_PREFIX}:neo:analytics:v1:*`，返回清理时间和完整前缀；清理时间存储在 `${BULL_PREFIX}:neo:ops:analytics-cache:last-cleared-at`，供同一 Neo 环境的多 API 实例共享，保留 30 天。扫描每次最多 100 页、10,000 个匹配键，扫描、删除和时间戳写入共用 5 秒预算，每条 Redis 命令也受剩余预算约束；配置前缀中的 Redis 通配符按字面转义。先完成扫描再分批 `UNLINK`。扫描超限返回 409，不删除缓存；删除超时或依赖失败返回 503。已发出的 Redis 删除命令在请求超时后仍可能完成，删除中途失败也可能留下部分键，可安全重试；并发查询可能立即重新填充缓存。
- `POST /api/v1/ops/analytics/refresh`：按小时、日或月刷新连续聚合；使用 PostgreSQL advisory lock 防止多 API 实例并发刷新，单次时间范围最多 31 天，所有聚合共用 120 秒语句预算。未知字段、非字符串时间、无效日历时间和越界窗口返回 400；已在刷新返回 409，依赖失败或耗时超限返回 503。失败后释放 advisory lock，无法复位连接状态时丢弃该连接。
- 三个端点均要求登录，并在 PostgreSQL 管理事务内重新读取当前会话和权限：概览需要 `settings:read`，两项维护操作需要 `settings:write`。这比 Legacy 仅要求登录的 ops 路由更严格；前端按钮禁用不替代服务端检查。响应使用 `Cache-Control: no-store`。

## 数据边界

当前页面只展示 Neo 已有可靠来源的数据。`workerRegisteredQueues` 表示 `WORKER_ENABLED_QUEUES` 配置，不代表跨进程 Worker 实例已经注册；`analyticsAgg.isRefreshing` 只表示当前 API 进程正在刷新，跨实例冲突由 PostgreSQL advisory lock 处理。`riskControl`、详细 scheduler 运行记录和实时 Worker processor 注册表待对应 Neo Worker/调度模块接通后再填充。页面不会使用队列等待数推断暂停状态，暂停状态直接读取 BullMQ。概览扫描超限时 `cache.activeEntries` 和 `cache.totalEntries` 为 `null`，`cache.truncated=true`，避免把不完整计数当作精确值。

## 验证与回滚

- API 测试覆盖当前权限、概览契约、队列状态适配、Redis 清理精确前缀、通配符转义、扫描超限和命令截止、共享清理时间、依赖失败脱敏、刷新日期/总耗时边界、advisory lock 冲突和 no-store 响应头。
- Web 测试覆盖 `/ops` 路由权限、导航展示、操作成功/失败提示和输入边界；页面动作会在清理缓存和刷新聚合前要求确认。
- 回滚应用提交即可移除 Neo 运维路由、页面和导航；不修改 Legacy 表、生产数据、队列迁移或代理流量。
