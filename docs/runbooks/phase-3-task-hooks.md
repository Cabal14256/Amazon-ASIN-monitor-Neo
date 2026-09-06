# P3-T2：任务客户端与 Query hooks

关联 Issue #44。复用已合入的 HTTP、Session、WS、REST/WS 契约，为后续任务中心和导出页面提供基础设施。当前首页仍是占位页，本批不改变生产入口、代理目标或任何 Legacy 页面。

## 接入与授权

`services/browser-runtime.ts` 的 `transport.tasks` 提供以下方法：

| 方法 | 行为 |
| --- | --- |
| `list(filters?, signal?)` | 读取任务列表，校验 status/limit 与响应 |
| `get(taskId, signal?)` | 读取完整任务快照并核对标识 |
| `createExport(body, signal?)` | 创建导出任务，复用共享请求和响应契约 |
| `cancel(taskId, signal?)` | 显式请求服务端取消任务 |
| `wait(taskId, options?)` | 等待任务完成，失败或取消时抛出 `TaskCompletionError` |
| `downloadURL(taskId)` | 构建同一部署根下的规范化下载地址 |
| `cancelWaits()` | 结束当前客户端等待，不发送服务端取消请求 |

`hooks/tasks.ts` 导出 `useTaskQuery(runtime, taskId, enabled)`、`useTaskListQuery(runtime, filters, enabled)`、`useCreateExportTask(runtime)` 和 `useCancelTask(runtime)`。所有 hook 使用传入 runtime 的 QueryClient；页面须在验证当前用户及路由权限后才启用查询或提供写操作。浏览器存储的登录提示不能作为授权依据。

```tsx
const task = useTaskQuery(transport, taskId, authReady && canReadTasks);
const cancelTask = useCancelTask(transport);
// 在有权限的用户操作中调用 cancelTask.mutate(taskId)。
```

Auth context 必须在身份变更时重新渲染，完成当前用户校验后才重新连接 WS。Query hook 以 Session revision 重新订阅，避免 runtime 清理旧订阅后永久收不到新用户通知。初始化 transport 或渲染禁用的查询不会创建后台任务或自动连接 WS。

## 更新与取消语义

- 任务状态以 HTTP 完整快照为准。WS 中的进度、完成和下载地址只作为更新提示，绝不将不完整 WS 对象覆盖到 Query 缓存，也不跟随其中的下载 URL。
- `pending`、`processing`、`cancelling` 每 1.5 秒刷新详情；`completed`、`failed`、`cancelled` 停止轮询。未知状态也停止自动轮询，避免将新增或异常状态伪装成等待中。列表每 15 秒刷新，以发现新任务。
- Query 只对既有策略允许的网络、截止、5xx 错误重试一次；详情暂时性错误改为 10 秒刷新。权限、业务、契约等永久错误停止定时刷新，保留显式重试入口。已经终态的详情即使遇到后台刷新错误也不会重新开始轮询。
- WS 进度突发合并为 300 ms 内一次失效；终态提示立即失效。如果提示发生在旧 HTTP 请求期间，会等待其结束并补读一次，避免旧快照吞掉完成通知。只失效相关任务详情或各筛选条件的任务列表。
- Query 消费 TanStack 的 AbortSignal；最后一个观察者卸载时可以中止实际 HTTP 请求。取消服务端任务必须调用 `cancel`，不能把页面卸载、请求超时或浏览器中止理解为服务端回滚。
- Mutation 不自动重试。取消后重新读取详情与列表，避免取消响应与稍后的任务完成互相覆盖。

## 命令式等待与下载

```ts
const created = await transport.tasks.createExport(request, signal);
const completed = await transport.tasks.wait(created.taskId, {
  signal,
  timeoutMs: 10 * 60 * 1000,
  onProgress: (snapshot) => updateProgress(snapshot.progress),
});
const href = transport.tasks.downloadURL(completed.taskId);
// 交给经授权的页面下载动作；本批没有实现浏览器文件保存流程。
```

等待先订阅 WS 再读取 HTTP；没有 WS 连接时继续轮询。默认截止 10 分钟、最多 64 个等待者；间隔允许 250 ms ～ 60 秒，截止须为有效整数。完成、失败、取消、调用方中止、回调抛错、HTTP 错误或截止都会清理计时器、订阅与请求。请求依赖即使忽略 AbortSignal，等待仍按时结束并忽略迟到响应。相同状态、进度、消息和错误不重复触发进度回调。

登录切换、注销、其他标签页会话刷新和 runtime dispose 会结束旧等待。重新登录不会自动恢复旧任务等待；宿主按新用户权限决定是否读取任务。

请求与导出 URL 都使用已有 `HttpClient` 合并规则，去重 `/api`/`v1`、保留部署子路径；拒绝路径穿越和无效任务标识。原生下载依赖 HttpOnly Cookie，不向 query 附加 Token。跨域 API 的 Cookie/CORS 与浏览器下载仍需真实部署验收；仅有旧 Bearer 凭据时不能假设原生下载会自动携带它。

## 验证与限制

- 新增 45 项自动测试：任务请求/导出 URL、响应验证、等待状态机、截止和实际请求中止、WS/HTTP 竞态、真实 QueryClient/QueryObserver 缓存失效与取消、身份清理。完整 Web 套件 181 项通过。
- 本地隔离浏览器页面使用 React 19 StrictMode 和真实 hooks，注入虚构 HTTP/Socket；验证了 WS 完成停止刷新、会话切换重新订阅、创建/取消 mutation、卸载中止请求且不继续轮询，控制台无警告或错误。该临时页面与截图移入忽略的 `artifacts/refactor-audit/task-hooks/`，不进入应用构建。
- 运行 `corepack pnpm --filter web test`、`typecheck`、`lint`、`build`，以及根契约、格式与差异检查。没有新增依赖、数据库变更或生产配置变更。
- 浏览器测试不代表真实任务后端、Cookie 跨域、导出内容/文件落盘或完整任务中心验收；这些仍属于后续业务页面与端到端工作。

## 回滚

回退本 PR 会移除 Neo 任务 service/hooks 和 runtime 清理接入；此前 HTTP/Auth/WS 基础设施及 Legacy 服务保持可用。无数据库回滚步骤。
