# P3：Neo 系统设置工作台

关联 Issue #159。Neo `/settings` 现在承载已迁移的 SP-API 配置、监控参数、配额/错误状态和飞书通知管理。Legacy 设置页和备份入口继续保留。

## 入口与权限

- 页面路由：`/settings`，需要 `settings:read`。
- 保存 SP-API、飞书配置或切换飞书开关需要 `settings:write`；服务端会在事务内重新校验当前权限。
- SP-API 敏感键由服务端返回掩码；只读账号收到空的 `configValue`，页面不会把掩码回写。
- 配置读取使用 `Cache-Control: no-store`，页面卸载或会话失效时由统一 HTTP 客户端取消请求。

## 页面分区

1. **SP-API 与监控**：编辑 19 个显示键，覆盖 US/EU LWA、AWS 签名、监控间隔、竞品开关和备用客户端。页面只提交用户明确修改的键。
2. **配额与错误**：读取 `/rate-limiter/status` 和 `/error-stats`，展示 US/EU 配额、Redis 回退状态和当前 API 进程的上游错误窗口。错误统计不代表所有 Worker 的全局累计值。
3. **飞书通知**：按 US/EU 保存 Webhook 和启用状态。只读账号只能看到服务端掩码；保存沿用现有六个配置端点和 Origin 保护。
4. **备份与恢复**：当前明确显示不可用。Neo 尚未实现 backup controller、pg_dump Worker 和异步任务链路，不发送未实现请求；Legacy 入口继续承担备份业务。

## 排障

- 出现 503 时检查 `AUTH_DATA_AUTHORITY=postgresql`；Neo 配置服务在 Legacy 权威源期间会拒绝读写。
- 出现 403 时重新验证 `settings:read`/`settings:write`，不要仅依据登录时缓存的角色名称判断权限。
- 出现 429 时等待当前配置事务完成；API 与配置仓储均有界限制活动请求。
- 配置保存成功表示数据库已提交，不等于 Legacy 调度器或尚未迁移的 Worker 已经热加载。后续调用按各自来源读取新快照。

## 回滚与后续

回滚页面提交即可恢复 `/settings` 占位入口；不涉及数据库迁移、生产流量或 Legacy 设置页。备份 API/Worker、监控调度热加载和真实生产切换属于后续独立阶段，不得通过本页面提前宣称完成。
