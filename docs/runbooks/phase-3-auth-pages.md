# P3：认证状态、权限路由与账号页面

关联 Issue #55。接入现有七个 auth service、共享权限策略与设计基础，完成登录、403、个人中心三个页面及全部 15 个业务路径的权限入口。首页、ASIN、监控、分析、设置、运维、用户、审计、任务等其余 12 个页面目前显示“此页面暂不可用”；完整应用外壳和这些业务功能仍待迁移，不能将本批作为 P3 出口或生产切流证据。

## 身份和路由

- `IdentityStore` 构造时没有请求。应用启动后调用 `current-user`，即使没有可读 Cookie/storage 提示也会验证服务端 HttpOnly Cookie；只有成功信封、有效数据和 ACTIVE 用户能建立身份并连接 WS。
- `beforeLoad` 等待身份校验；页面内 `RouteGate` 同时订阅身份变化，防止已挂载页面在退出、换号或校验失败后继续展示。加载、匿名、已认证和网络失败分别处理，网络失败只提供重新校验入口，不使用缓存身份放行。
- 沿用 #46 的逐页权限、ADMIN 不隐式绕过 permission、强制改密、404 和安全返回地址策略。匿名访问保留合法路径/query/hash；登录成功后再验证 `current-user`。强制改密只允许个人中心，其他已知页面转到密码页。
- 登录成功、退出和跨标签页 storage 变更清理旧 Query、HTTP、任务等待及 WS；换号后迟到的旧响应不能覆盖新身份。没有 storage 事件的 Cookie 变化，也会在下次身份刷新发现 user/session 变化时先清缓存。
- 普通业务 403 不清全局身份；`current-user` 的 401/403 则视为无有效会话。退出请求失败仍退出本机状态，并明确提示无法确认服务端撤销。Token 不写入新 Web Storage，也不放入身份快照或 URL。
- React StrictMode 重启可以重新校验，HMR 卸载 React 根节点并清理身份监听。身份刷新会暂时移除受保护页面；个人中心页签保存到 URL，更新姓名后仍保留选中页签。

## 账号操作

- 登录：用户名、密码、记住登录状态、提交期间禁用和错误提示。登录响应不直接作为页面身份依据。
- 个人资料：用户名只读，只提交 `real_name`；按 Unicode 码点限制 100 字符。保存后重新获取服务端用户。
- 修改密码：共享强度契约、本地确认一致、提交后清空密码字段、刷新强制改密状态；默认同时退出其他设备。密码只存当前表单状态，不进入 Query mutation 缓存或日志。最终密码历史、旧密码和会话检查由后端事务执行。
- 登录设备：当前/其他/撤销/过期会话、加载/空/错误/刷新状态；撤销其他会话后重读列表，撤销当前会话立即退出本机。时间及无时区旧日期都按北京时间处理。强制改密期间仍可在个人中心管理资料和会话，其他业务路径保持阻断。

## 双跑配置

从仓库根运行 `corepack pnpm --filter web dev`。默认 `VITE_API_BASE_URL=/api`，Vite 将 `/api` 与 `/ws` 代理给 Legacy :3001；Legacy 已提供 `/api/v1/auth/*`。本批不修改生产 Nginx、数据库或默认流量。

在隔离环境联调 Neo 时，可显式设置公开 `VITE_API_BASE_URL=http://localhost:3100/api`，并令 Neo `CORS_ORIGIN` 精确包含当前前端 origin（例如 `http://localhost:5173`）。HTTP Cookie/Origin 与 WS 必须使用同一套受信域配置，不能混用 localhost 和 127.0.0.1；`VITE_*` 只能包含公开配置。Neo 的资料/改密/会话写入须满足 [PostgreSQL 权威写入开关](phase-2-auth-account.md)，不得通过前端页面绕过数据迁移 gate。

请求仍经统一 HTTP URL 合并逻辑，导出地址仍经同一 helper。运行 `corepack pnpm test:contracts` 和 Web 测试验证 request/export 不出现重复 `/api`/`v1`。

## 验收与回滚

- 自动化：`corepack pnpm --filter web test`、`lint`、`build`。身份测试覆盖匿名/失败/重试、StrictMode、跨标签页/静默换号、迟到响应、Token 不落存储和业务 403；实际 Memory Router 使用客户端加载流程覆盖 15 路径权限、强制改密、异步校验及 query/hash 返回地址。
- 浏览器隔离验收使用实际页面和 transport，注入纯内存 HTTP/WS 替身；覆盖错误登录、强制改密与确认错误、资料保存、页签保持、当前/其他会话撤销、403、网络恢复和跨标签页退出。桌面及 390 px 宽度检查排版和键盘焦点；测试数据无真实账号、凭据、Cookie 或业务写入。
- 此验收不证明真实浏览器 Cookie/CORS、PG 写入、生产账号或全部业务页面可用；Neo 后端真实 PG 事务证据由后端 CI 提供，完整端到端和生产灰度仍是后续 gate。
- 回滚本 PR 可恢复此前 Neo 前端入口与通信宿主；Legacy 继续承担当前业务流量，无数据库回滚或数据清理。
