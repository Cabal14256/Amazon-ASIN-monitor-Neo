# P3-T2：Neo 前端通信层

关联 Issue #35。本批仅迁移通信基础设施；页面仍是原有占位页，不构成 15 路由、权限 guard、设计系统或 P3 阶段验收。

## 入口与兼容行为

- `apps/web/src/services/browser-runtime.ts` 创建一个 `transport` 单例，提供 `http`、`auth`、`ws`、`session` 和 `queryClient`。`main.tsx` 使用这个 QueryClient；创建时没有 HTTP 请求，也不自动连接 WS。
- `auth` 是登录、当前用户、注销、Session 列表/撤销、改密、资料更新七个真实 REST 端点的类型化 service，复用共享 Zod 响应契约。它可以对接 Legacy 或 Neo，不包含模拟成功后端。
- `lib/api-url.ts` 原样迁移 Legacy helper；测试直接对照源码和旧 URL 矩阵。`http.url(path, query)` 与 `http.request(path, { query })` 共用最终 URL 入口，兼容重复 `/api`/`v1`、部署子路径和已有 query/hash。新增参数覆盖同名参数，不再拼出第二个 `?`。
- `request` 返回完整信封，保留 `success/data/errorCode/message`，不静默丢弃分页/消息元数据。HTTP 非 2xx、`success:false` 和 401 分型为 `ApiError`；上游业务 `errorMessage` 限 500 字符供 UI 纯文本显示，不将原始请求/响应、凭据或完整网络异常附到 Error。
- 所有请求 `credentials:include`。只兼容读取旧 Web Storage token 并发送 Bearer；新的登录 token **不会写入 Web Storage**，只写 `authSession/rememberMe` 和非敏感 Cookie 提示。真正授权由服务端 HttpOnly Cookie/Session 决定，提示不能当作权限依据。
- 普通 403 保持权限错误，不清空全局登录；登录接口 401 不触发“旧会话过期”。其他 HTTP/信封 401 清本地提示、旧 WS/Query/在途请求并通知宿主；浏览器宿主转到 `/login?redirect=...`。bootstrap 的 403/强制改密/安全 redirect 校验属于下一批 auth context/guard。

## 配置与构建

`apps/web/.env.example` 提供公开 `VITE_API_BASE_URL=/api`；不要在 `VITE_*` 放密码、Token 或服务器密钥。默认同源 `/api` 和 `/ws` 仍经 Vite 代理到 Legacy :3001，没有改为 Neo :3100，也没有变更 Nginx/生产路由。

显式配置外部 API 根（例如 `https://api.example.test/api`）必须是受信部署配置，宿主须正确配置 CORS/Cookie；endpoint 本身不能指定外域。WS 使用相同部署根的 `/ws`，不附 Token 查询参数，也不硬编码 localhost:3001。

前端 build/dev/test/typecheck 会先构建 contracts；共享包当前给 Node 输出 CommonJS，因此 Vite 同时配置 `optimizeDeps.include` 和 `build.commonjsOptions.include`。这是 [Vite 6 对非 ESM workspace 链接依赖的要求](https://v6.vite.dev/guide/dep-pre-bundling#monorepos-and-linked-dependencies)，不复制契约源码或改变后端输出格式。修改 contracts 后须重建并重启 dev（必要时 `--force`）。

## 失败、取消和身份切换

- fetch 本身没有自动重试；Query 只对网络、截止或 5xx 错误再试一次，业务/权限/契约错误不重试。Mutation 不自动重试，避免重复写入。
- HTTP 默认 30 秒、可设 1 ms ～ 5 分钟，覆盖请求与 JSON 读取；原生 AbortSignal 取消实际 I/O。JSON 响应上限 8 MiB/10000 个读取块，请求准入最多 64 个实际未结束 work。注入 fetch 若忽略取消，调用方能收到截止，但旧槽直到依赖实际结束才释放。
- 原 helper 保持兼容，传输边界另拒绝危险协议、URL 用户名/密码、HTTPS 降级、API 根路径逃逸、编码分隔符/反斜线/控制字符及超长地址。`redirect:error` 禁止携带凭据跟随重定向；这是 [Fetch 显式支持的重定向策略](https://developer.mozilla.org/en-US/docs/Web/API/Request/redirect)。
- SessionStore 在存储/Cookie 不可访问时不崩溃；本地 clear 即使删除持久化失败也压制旧提示。旧请求的 401 不能清掉 revision 已更新的新会话。
- login/logout 在同一 AuthApi 实例中串行；默认 rememberMe=false。新登录成功会断开旧用户 WS、清 Query 和取消旧请求。其他标签页 storage 变更执行同样的旧工作清理和提示重读，不自动恢复连接；下一批 auth context 必须重新获取当前用户后再连接。
- 注销失败仍清本地提示并返回原错误，**不表示服务器 Cookie/Session 已撤销**。超时/取消同样无法撤销服务端已接收的写操作或已处理的 Set-Cookie；宿主须处理重试和再次验证，不把本地取消当数据库回滚。
- 默认诊断不打印 payload/URL/token；不要把 Error 或服务返回值整包写日志。上游业务提示仅用于纯文本 UI，不能作为 HTML 渲染。

## WS 生命周期

- 复用共享九种消息和仅 `ping` 上行契约；无效/过大（超过 1 Mi 字符）消息丢弃，单个订阅者抛错不阻挡其余订阅者。支持安全取消订阅。
- 30 秒一次 ping；握手 10 秒截止。连续失败按 1/2/4/8/16 秒最多五次重连；成功 open 后重置计数，保留 Legacy 语义。
- 4401/4403 停止自动重连；断开/注销清计时器和旧订阅。旧 socket 的迟到 open/message/close 不能影响新连接的状态、消息或心跳。
- 最多 8 个实际尚未 close 的 socket、256 个订阅者、发送缓冲超过 64 KiB 时不追加帧。浏览器 WebSocket 没有 Node 的 terminate；close 过程中槽仍被占用，不能声称握手截止会立刻释放底层连接。
- 登录后由 auth context 显式 `ws.connect()`，不能只凭 storage hint 自动订阅数据。runtime/HMR dispose 关闭客户端和缓存，避免重复连接。

## 验证及剩余工作

运行根目录 `corepack pnpm --filter web test`、`typecheck`、`lint`、`build`。新测试覆盖 URL 对照、Cookie/storage、HTTP/Query 策略、七个 auth service、WS 状态机，以及真实 loopback HTTP 请求/跨域重定向拒绝/响应流超时并确认 socket close。WS 使用确定性浏览器 socket 替身，Cookie 使用模拟存储；不是实浏览器 Cookie/CORS 或真实账号验收。

后续仍需完成：auth context/15 路由/权限 guard、登录与资料页、WS React hooks、任务中心与异步下载 hooks、导出浏览器落盘、设计系统和全部页面、浏览器 E2E/灰度验收。`http.url()` 目前只构建下载地址，不声称已实现完整导出/任务 UI；无前端路由或生产切流权限被此 PR 代替。

本批无数据库/依赖版本变化，Legacy 源码不删除。回滚本 PR 即恢复旧 Neo 空骨架 QueryClient 和构建配置，不影响 Legacy 用户流量。
