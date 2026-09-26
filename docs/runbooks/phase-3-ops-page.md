# P3：Neo 运维观测页面

关联 Issue #155。Neo `/ops` 提供当前 PostgreSQL 权威源下的运维概览、分析缓存清理和 Timescale 连续聚合刷新；Legacy 运维入口继续保留，生产流量和数据切换仍按 #48 阶段门执行。

## 已接入范围

- `GET /api/v1/ops/overview`：当前进程角色、调度开关、Neo 分析缓存条目、监控/竞品 BullMQ 队列计数与暂停状态、聚合刷新状态和 Worker 队列配置。
- `POST /api/v1/ops/analytics/cache/clear`：仅清理 `${BULL_PREFIX}:neo:analytics:v1:*`，返回清理时间和前缀；清理时间存储在 Neo 专用 Redis 键中，供多 API 实例共享，保留 30 天。
- `POST /api/v1/ops/analytics/refresh`：按小时、日或月刷新连续聚合；使用 PostgreSQL advisory lock 防止多 API 实例并发刷新，单次时间范围最多 31 天，连接语句超时为 120 秒。
- 所有端点重新读取当前会话和 `settings:read`/`settings:write` 权限；响应使用 `Cache-Control: no-store`。

## 数据边界

当前页面只展示 Neo 已有可靠来源的数据。`workerRegisteredQueues` 表示 `WORKER_ENABLED_QUEUES` 配置，不代表跨进程 Worker 实例已经注册；`riskControl`、详细 scheduler 运行记录和实时 Worker processor 注册表待对应 Neo Worker/调度模块接通后再填充。页面不会使用队列等待数推断暂停状态，暂停状态直接读取 BullMQ。

## 验证与回滚

- API 测试覆盖当前权限、概览契约、真实队列状态适配、Redis 缓存清理、共享清理时间、刷新日期边界、advisory lock 冲突和 no-store 响应头。
- Web 测试覆盖 `/ops` 路由权限、导航展示、操作成功/失败提示和输入边界；页面动作会在清理缓存和刷新聚合前要求确认。
- 回滚应用提交即可移除 Neo 运维路由、页面和导航；不修改 Legacy 表、生产数据、队列迁移或代理流量。
