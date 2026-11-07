# P3：Neo 备份设置 UI

关联 Issue #221、#161、#48，前端 PR #250。此分支从 `origin/main` 的 `cdfd47e` 开始，已正常 merge 正式 main `3df5a2a`；后端 PR #171 尚未正式合入，当前保留前端实现及隔离验证。生产切换、Legacy 退役和真实恢复演练仍需各自阶段门禁。

## 实际接口与权限

2026-10-14：入口先用 `GET /api/v1/backup/capabilities` 确认当前配置的后端提供 `neo-postgresql-backup-v1`、custom 格式和 primary/competitor 两个目标。未实现的 route、Legacy 返回、协议不符或请求失败仅显示不可用和 GET 重试，不挂载备份操作页；旧 Vite 代理继续指向 Legacy 时不会发送创建、恢复或删除。身份、session 或传输 revision 改变会使旧确认失效，待新会话重新确认。后端 #171 新增相同协议端点；没有更改整个代理或复制未合后端。

共享流下载保留字节、30 分钟期限、块大小、前缀和磁盘背压校验。有效非空块不再受 200000 次固定上限约束，以免合法大于约 12 GiB 的归档被拒绝；连续空块仍限制 200000 次。普通 ASIN export 的调用方大小上限和 Blob 256 MiB 上限保持。新增测试复用 64 KiB chunk 验证 200001 块（不分配整个归档），并验证无字节进展拒绝。完整 Web 1187 项、lint/build 通过；真实 FSA 和 UI/API/两目标联动仍待独立验收。

UI 对应 #171 实际存在的八个接口：`POST /api/v1/backup`、`POST /backup/restore`、`GET /backup`、`DELETE /backup/:filename`、`GET /backup/:filename/download`、`GET/POST /backup/config`、`GET /backup/scheduled-tasks`。以上简写均在 `/api/v1` 下。列表、下载、配置及计划执行记录也要求 `settings:write`；只有 `settings:read` 的用户不发送这些请求。

创建与恢复固定使用 `useAsync: true`，不把同步成功消息假定为任务回执。主营和竞品各自使用真实 `target`。恢复前重读文件并比较原文件、大小、时间、来源与恢复能力；Neo custom 归档下载为包含 dump 与元数据的 `.tar`，不显示为 Legacy `.sql`。

## 提交与恢复

- 同一用户的两类数据库操作共享 Web Lock 与持久保护。发送前先写入并验证保护；网络中断、超时、取消、异常回执及带 taskId 的未知 500 都保留原操作，刷新或再次点击不重发 POST。
- 后续 localStorage 回执写入失败时，用 sessionStorage 保存原 taskId，原 localStorage 保护继续阻断重复提交。损坏或不可读记录不会自动删除。无法提供持久存储和 Web Locks 时不开放修改操作。
- 恢复原任务只使用其 taskId 的 GET。任务 404 不能证明从未执行。用户明确核实原任务、文件和数据库后，需成功重读列表才可解除原保护；有执行中的原任务时不能解除。清理失败或记录被替换时继续保留保护。
- 其他窗口解除保护后，本页保留 GET-only 重读入口，只有成功读取才解除缓存保护。此机制是当前 UI 的重复提交保护；不能宣称拦截其他管理员、旧版客户端或直接调用 API 的并发操作，后端排他能力须以正式 API 门禁为准。
- 自动计划提交完整频率、日期与上海时间字段；写入前比较配置版本及字段。当前接口没有 CAS，前读比较不能消除读写之间另一管理员修改的竞争。

## 下载边界

支持的浏览器在用户点击中立即调用 `showSaveFilePicker`，取得保存位置后才创建 writable 和发起认证 GET。每次读一块网络数据并等待写盘完成，再继续读取；前缀最多 512 字节，单块最多 8 MiB，不缓冲整个大备份。

下载限制为 30 分钟、实际 dump 大小加至多 16 MiB 元数据及 tar 对齐开销；校验 MIME、声明/实际字节数、首条 tar 文件名、dump 大小及校验和，兼容超过 8 GiB 的 GNU base-256 大小字段。请求和下载 URL 共用 `/api` 归一逻辑。

只有完整归档上限不超过 256 MiB 才使用 Blob 回退。缺少 File System Access、非安全上下文或大归档无法直接保存时，页面解释使用支持该能力的 Chrome/Edge 可信地址，或联系运维获取带元数据的归档。未放大现有 Blob 上限。退出页面、会话变化、撤权、主动取消、超时、磁盘或网络错误均中止请求与临时 writable，不显示完成；磁盘在 `close()` 完成后已提交的内容不能由页面撤销。

浏览器能力依据 [Chrome 官方文档](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access) 与 [MDN createWritable 文档](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable)。真实浏览器验收时须检查保存对话框的用户激活、磁盘背压、取消后的原文件及归档可解包性。

## 恢复回执

任务详情及设置页呈现 `restoreMode`、隔离数据库名称、在线目标是否改变与 `verification`。隔离恢复成功不表示生产已切换；即使任务登记为失败或取消，只要回执记录已提交且验证未确认，仍明确显示在线目标可能已变更，要求运维核实。

## 当前实现与回归证据

截至 2026-10-11，前端已发布源码 head 为 `0dcd8379cc298b205f67ec7fcc1fae026bbfb1f6`，PR #250 保持 Draft、未合并。本节文档纠正发布后产生的新 head，需要重新等待对应 CI 和最新提交审查；以下结果明确绑定原 head，不预先算作新 head 通过。

- 原 `b48ddfb` 正常 merge 正式 main `3df5a2a` 得到 `5fda806c`，原 15 文件 SHA256 不变。原检查的 67/67、strict/lint、URL 3/3 及格式 5/5 为该阶段历史证据。
- 原实现只检查 owner 与本地 `SessionStore.revision`，遗漏服务端已验证的 `sessionId`。同 owner、同 revision、仅 sessionId 变化的三项 mounted 用例实际得到 2 RED、1 健康对照通过。修复 `53e2e67` 将 sessionId 纳入请求 `current()` 与 workspace key；格式提交 `0dcd837` 保留行为，原三项随后 3/3 通过。
- `backup-panel-identity.test.tsx` 的 7 项使用实际 `IdentityStore`、`RouteGate`、`BackupPanel` 与认证 HTTP 层，实际验证 loading/error 后同会话恢复、sessionStorage 已知回执、anonymous、不同 owner、同 owner 的真实 sessionId 变化及 loading 中止 POST。与三项 sessionId 组件边界合跑 10/10 通过；新 snapshot、同会话健康控制和 GET-only 恢复断言保留。
- 两 member ustar 下载夹具包含 dump 与对应 `<filename>.meta.json`、各自合法头部、摘要、padding 和两个终止块。磁盘端口与 Blob 保存字节解包检查，CI 下载文件 16/16 通过；7 项身份、3 项会话与 16 项下载合计 26 项在相同发布源码的 CI 中实际通过。
- dump 是带 `PGDMP` 前缀的测试内容；10 GiB 用例只验证数值头部。缺少 metadata 与截断终止块由测试解包器识别，当前前端传输只检查首 tar 头与有界字节数，未新增前端 sidecar 全量校验。上述结果不证明实际 pg_dump、10 GiB 传输、真实磁盘或恢复通过。

本机日志保留 `%TEMP%/neo221-session-scope-isolated-red.log`、`neo221-session-scope-isolated-green.log`、`neo221-session-scope-related.log`，原冻结清单保留于 `neo-221-verification`。一次非隔离 fixture 执行的 2 个失败也保留为 `neo221-session-scope-red.log`；它不能代替后续同会话健康对照与隔离的实际 RED。日志及临时哈希不提交仓库。

## 已发布 head 的完整 CI

[CI 38053489533](https://github.com/Cabal14256/Amazon-ASIN-monitor-Neo/actions/runs/38053489533) 在 `0dcd837` 的 29 步全部成功，包括以下实际命令；原生 opt-in skip 不算通过：

| 命令 | 结果 |
| --- | --- |
| `pnpm run test:contracts` | 40/40，包含请求与导出 URL `/api` 去重 3/3 |
| `pnpm --filter amazon-asin-monitor-server run test:unit` | 55/55 |
| `pnpm exec tsc --noEmit --pretty false`、`pnpm run build` | Legacy strict/build 成功 |
| `pnpm --filter @asin-monitor/contracts test` | 213/213 |
| `pnpm --filter @asin-monitor/config test` | 41/41 |
| `pnpm --filter @asin-monitor/db test` | 907 passed、218 skipped |
| `pnpm --filter @asin-monitor/api test` | 1710 passed、549 skipped |
| `pnpm --filter @asin-monitor/worker test` | 250 passed、41 skipped |
| `pnpm --filter @asin-monitor/web test` | 930/930，69 文件 |
| `pnpm --filter @asin-monitor/web lint`、`pnpm --filter @asin-monitor/web build` | 成功，Web build 包含自身 TypeScript 检查 |
| `pnpm --filter @asin-monitor/config --filter @asin-monitor/contracts --filter @asin-monitor/db --filter @asin-monitor/sp-api build` | 成功 |
| `pnpm --filter @asin-monitor/api --filter @asin-monitor/worker build` | 成功 |
| `pnpm run test:changed-format`、`pnpm run check:changed-format` | 5/5 与改动文件格式检查成功 |

[Integration 38053489518](https://github.com/Cabal14256/Amazon-ASIN-monitor-Neo/actions/runs/38053489518) 同样绑定 `0dcd837`，97 步成功，其中正式 main 的 task-query 24 项实际通过。该 workflow 没有 #171 的真实备份/恢复步骤，不能据此宣称本 UI 已与未合并备份后端联调。后续文档 head 7c4563d 的 Review 已完成并提出一项 P1 和一项 P2，修复与新 head 门禁见下节。

## 503 未知提交与损坏日期保护

文档 head 7c4563d 的最新 Codex Review 已完成，提出一项 P1（503 可能发生在 POST 已接受后，不能解除保护）和一项 P2（安全整数超出 Date 范围会导致渲染崩溃）。这两项在新的修复提交完成 CI 与 Review 前仍属于开放门禁，PR 保持 Draft。

- 所有 5xx HTTP 状态或业务错误码保留 unknown 保护，即使错误被包装为 CLOSED、CAPACITY、AUTH 或 INVALID_INPUT。CLOSED/CAPACITY/INVALID_INPUT 仅在没有响应状态与业务错误码的本地发送前拒绝时释放；刷新页面不会自动重复提交创建或恢复。
- decode 要求提交时间能产生有效 Date；精确上限 8.64e15 和合法未来时间保留。超范围整数、NaN、负值和非安全整数进入现有损坏保护恢复流程；必须人工核实并成功重读，不能自动删除记录来开放提交。
- 本轮冻结原 head 7c4563d 的源码并恢复原字节实际执行：选定 RED 为 15 failed / 8 passed；健康控制 12 passed。mounted 测试使用实际 BackupPanel 与 HttpClient，create/restore 的代理 503 在重载后仍需阻止第二次 POST，损坏 local/session 日期原实现实际抛出 RangeError。
- 恢复修复源码并核对 SHA 后，备份相关六文件 110/110 通过；Web strict、lint 和 production build 通过。完整 Web、根契约及格式结果按本次实际命令另列于 PR 验证；旧 CI 不能替代新 head。
- 临时完整日志、原始和修复源码、SHA 清单位于 %TEMP%/neo-250-review-repair-7c4563d，不提交生产凭据或真实用户数据。mounted 与传输夹具不替代下述真实 FSA 或正式后端联调。

## 尚未通过的阶段门禁

真实浏览器已在独立测试页面挂载 Settings，并观察同步原生保存对话框调用、用户激活和选择前 GET 为零；随后 Computer Use 因无法可信确认 Windows 当前浏览器 URL 而停止，未选择文件或写盘。真实 File System Access 保存、慢盘背压、取消后原文件、网络/磁盘错误和下载归档解包仍未通过；mounted 通过不能替代这些结果。#171 正式合入后还需以真实认证接口下载两种 target 的备份，核验 sidecar 并执行隔离 PostgreSQL/TimescaleDB 恢复。生产切换和 Legacy 退役继续暂缓。

## HTTP 200 业务拒绝

提交 `1b0693d` 的 CI 和 Integration 已通过，最新 Review 新增一项 P2：HTTP 200 的 `success: false, errorCode: 409` 会由 HttpClient 包装为 BUSINESS 错误，但原分类只取 HTTP 状态，遗漏明确的业务拒绝。

- HTTP 状态和业务错误码独立判断明确拒绝，任一为 5xx 时仍优先保留未知操作保护。不得因 HTTP 200 直接认为提交成功，也不能释放未知业务错误。
- 精确原提交源码下，七种明确业务拒绝码的创建/恢复共 14 项实际 RED；已有 5xx 未知保护与发送前拒绝 17 项健康控制通过。回归检查持久保护解除、sessionStorage 清空及下一次操作仅发送一次。
- 原始源码、RED 和健康日志保留于 `%TEMP%/neo-250-review2-1b0693d`。新提交的页面回归、CI、Review 和线程门禁需重新验证；本节不把父提交绿色证据计作新提交通过。

## 回归与回滚

当前备份入口先以 GET `/api/v1/backup/capabilities` 确认 `neo-postgresql-backup-v1`、custom 格式与 primary/competitor 两个 target；旧服务或未启用备份的服务不开放操作。探测受当前用户、sessionId、revision、权限和取消信号约束，不发送备份 POST。

直接写文件复用共享 `saveToFile`：原生 `createWritable`、write、close 或 abort 未返回时，取消及期限仍及时结束界面等待；迟到的句柄只清理一次，不启动下载或写入。尚未结束的原生操作保留其物理并发许可。下载传输层与失败路径共享同一次 abort，磁盘失败不额外启动第二次清理。

流式归档按字节总量、期限和连续空读取次数约束；正常有字节进度的读取不受累计 200000 次限制。回归包含 200001 个正常 64 KiB 块、无进度流、待返回句柄取消、迟到句柄零 GET/零写入及磁盘失败单次 abort。这些合成端口用例不替代上述真实 File System Access 与正式后端联调阶段门。

正式合入 #171 后正常 merge 最新 main，复核新增字段与双布局导出 HTTP 下载默认值，运行 Web 全套、strict/lint/build、请求/导出 URL 与格式检查。重点回归两个 target、未知提交 GET-only 恢复、active/404/损坏回执、peer 解除后 GET 失败、同 owner 的 session revision、撤权与强制改密、配置并发及大文件直接保存。

回滚本 Issue 的前端提交即可恢复备份占位区；不回滚数据库、备份卷、已创建任务或已经提交的恢复结果。Legacy 入口与生产切换状态按各自阶段保留。
