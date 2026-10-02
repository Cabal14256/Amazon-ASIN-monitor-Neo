# P3：Neo 全局公告

关联 Issue #194。Neo AppShell 使用已有公开 `GET /api/v1/system/alert` 恢复 Legacy 全局公告。公告位于页头下方的普通内容流，不添加任务提示或可编辑的公告设置。

## 展示与读取

- API 仍读取部署配置 `GLOBAL_ALERT_MESSAGE` 和 `GLOBAL_ALERT_TYPE`；更新配置后的公告在页面重新进入、陈旧缓存的窗口聚焦刷新，以及可见页面每 60 秒刷新时重新读取。
- 复用共享 SystemAlert 契约与统一 HttpClient；请求和共享 URL 生成均去重 `/api` / `v1`，支持部署子路径。
- `info`、`success`、`warning`、`error` 使用独立状态色和图标，其他类型回退为 info。空消息或纯空白消息不占空间；消息按纯文本展示，保留换行，长链接可换行。
- 公告读取失败时隐藏公告，包括上一次成功但当前刷新失败的公告；页面、命令面板和原有输入继续可用。后续正常读取会恢复展示。公开接口的 401 不触发全局注销，受保护接口的认证处理保持既有机制。
- 公告不是用户私有数据，使用公共 Query key，不新增按用户持久化的缓存。现有 runtime 会在会话重置时取消读取、清理 QueryClient；最后一个公告观察者卸载时中止其 HTTP 读取。
- 公告不移动键盘焦点。CmdK 打开时公告随工作区背景进入 inert，原生 dialog 保持顶层和既有焦点行为；窄屏内容自然换行。

## 验证与回滚

- 实际 HttpClient 回归覆盖基址前缀、共享 URL 生成、Cookie、响应契约及公开端点 401。
- 实际挂载 AppShell 回归覆盖四种状态及未知类型、空消息、纯文本、配置更新/删除、重新进入页面、失败恢复、焦点保持、命令面板背景和卸载取消。
- 根代理的真实 IAB 浏览器使用纯本地 HTTP fixture 和实际 AppShell/HttpClient 验证：1440×900 桌面长链接换行、未知类型回退、503 重试失败隐藏旧公告且输入可编辑、恢复后 Ctrl+K 背景 inert 与 Escape 关闭；390×844 窄屏正文 scrollWidth 为 375（另 15px 竖向滚动条），无横向溢出，空公告后输入正常。
- 本地截图位于 `C:/Users/Admin/.codex/visualizations/2026/10/02/01a0fcfb-30a4-7fd3-9f52-b687920a7b97/global-announcement-desktop.png` 和同目录 `global-announcement-mobile.png`，未提交到仓库。该证据不代表生产账号、生产数据或 15 页端到端验收。
- 只涉及 Neo Web，不修改 API、数据库、Legacy、生产流量或配置内容。回滚本 PR 即移除 Neo 公告展示，不影响已有公开端点。
