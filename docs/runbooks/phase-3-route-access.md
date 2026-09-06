# P3-T2：页面权限与访问决策

关联 Issue #46。`apps/web/src/auth/` 提供权限工厂、15 页面清单与确定性导航策略，供后续 Auth context 和 TanStack Router 使用。此批没有把尚未迁移的业务页面接到生产入口，现有 `router.tsx` 仍为占位页；不能据此认定 15 页面或 P3 gate 已完成。

## 与 Legacy 的对应关系

- `access.ts` 的 `createAccess` 接收经过服务端验证的 `CurrentUserData`，对齐 Legacy `src/access.ts` 的 14 项权限、ADMIN/EDITOR/READONLY 角色和用户管理的 `user:read OR role:read`。ADMIN 角色本身不隐含全部权限。
- `pages.ts` 的 `PAGE_ROUTES` 精确对应 `.umirc.ts` 的 15 个 component 路由及 access key。根 `/` 是 `/home` 的跳转；FeishuConfig 是设置页中的功能，不额外创建孤儿路由。
- 强制改密综合顶层 `mustChangePassword`、用户 `force_password_change` 和 `passwordExpired`；限制期间仅允许 `/profile`，其他已知页面返回 `/profile?tab=password&force=1`。
- 当前用户必须具有非空 ID 和 ACTIVE 状态；其他账户状态不能通过角色或权限字符串取得访问权。服务器仍负责每个请求的最终鉴权。

Legacy 用浏览器 hint 临时放行 `isLogin` 来避免初始化期间显示 403。Neo 改用独立的 `loading → pending` 状态表达同一个等待过程，避免把存储提示等同于认证。网络或验证错误返回 `unavailable`，宿主可显示重试入口并保留会话提示；不会清除会话或渲染受保护数据。这个差异由测试明确记录，没有修改 Legacy 行为。

## Auth context 与路由接入约定

`RouteAuthState` 只包括 `loading`、`anonymous`、`error`、`authenticated`（带服务器验证的 identity）四种状态。`evaluateRouteAccess(target, auth)` 是纯函数，不发请求、不操作 history、不清 Cookie、不连接 WS。

| 决策          | Router / 页面后续应执行的操作                             |
| ------------- | --------------------------------------------------------- |
| `pending`     | 等待当前用户校验；显示加载状态，不运行受保护 loader/query |
| `unavailable` | 显示验证失败与重试，不放行受保护 loader/query             |
| `redirect`    | 按 `to` 使用 Router replace 跳转；目标页面仍重新检查权限  |
| `allow`       | 挂载返回的 page 对应页面组件，并按按钮权限启用操作        |
| `not-found`   | 显示不存在页面，不将未知路径映射成任意组件                |

宿主应将 current-user 的 401/403 映射为 anonymous；普通业务接口 403 仍是该操作的权限错误，不能据此注销整个会话。其他 current-user 失败映射为 error；本策略没有假设超时表示 Cookie 已失效。会话变化和重新获取当前用户后的权限更新都必须重新执行 guard。Auth context 和这些副作用的实现仍在后续应用骨架任务中。

登录页对匿名或 error 状态允许恢复登录，对 loading 等待校验，对已登录用户返回安全目标。403 页公开可访问；已验证且强制改密的用户会先进入个人中心。无权限访问返回 `/403`，不会通过二次登录把权限不足转换成授权。

## 登录返回地址

`safeReturnTo(value)` 接收 `URLSearchParams.get('redirect')` 已解码一次的值，返回已知应用页面的相对路径；无效输入退回 `/home`。`loginDestination(target)` 将安全路径编码一次放入登录页 query。不要再次手工 decode 返回值。

- 保留正常 query/hash；将根路径及一个尾部斜线规范化。
- 拒绝外域 URL、协议相对 URL、反斜线、控制字符、畸形 UTF-16、超长值、编码/点段路径与未知页面。
- 登录页和 403 不能成为登录成功返回目标，避免循环。查询条件可以携带普通 URL 字符串，它只是页面数据，不会作为导航地址执行。
- 返回地址不授予权限。例如仅有个人中心权限的用户登录后返回 `/settings`，设置页 guard 仍会转到 `/403`。

## 验证与回滚

新增测试直接转译并在隔离 VM 中加载当前 Legacy `.umirc.ts` 和 `src/access.ts`，以实际源码作对照：全量权限与角色矩阵、15 页面映射与访问结果、等待/错误/匿名状态、三种强制改密标志、返回地址及路径边界。测试只加载仓库源码，外部模块限定为测试 stub，没有浏览器或业务 API 调用。

运行根目录 `corepack pnpm --filter web test`、`typecheck`、`lint`、`build` 及契约/格式检查。没有页面视觉改动，故本批无需截图；真实 Router、Auth provider 与 15 页面端到端验收仍待后续接入。回退本 PR 可移除这组尚未接入的策略与说明，不涉及依赖、数据库或 Legacy 回滚。
