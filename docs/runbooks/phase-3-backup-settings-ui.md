# P3：Neo 备份设置 UI

关联 Issue #221、#161、#48。此分支从 `origin/main` 的 `cdfd47e` 开始；后端 PR #171 尚未正式合入时，只保存前端实现及隔离验证。生产切换、Legacy 退役和真实恢复演练仍需各自阶段门禁。

## 实际接口与权限

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

## 本轮实际验证

- `corepack pnpm install --frozen-lockfile --filter web... --ignore-scripts`：成功，根锁文件不变。
- `corepack pnpm --filter contracts build`：成功，仅构建叶包。
- 单 worker 四个 focused 文件：67/67 通过，其中真实 BackupPanel/TaskDetails 挂载 20 项、流下载 14 项。流测试使用实际 HttpClient、ReadableStream 与有背压的测试磁盘端口；10 GiB 场景只验证真实数值头部，不声称传输了 10 GiB。
- 初轮发现两处回归：缺省模型字段断言及 peer GET 失败覆盖恢复提示，已修复并回归通过。严格类型检查发现的 UUID/ArrayBuffer 四处错误已修复。
- `corepack pnpm --filter web exec tsc --noEmit --pretty false`：通过。`corepack pnpm --filter web lint`：通过，初次唯一 ref cleanup 警告已修并对对应文件重跑 ESLint 通过；Prettier 与 `git diff --check` 通过。`npm run test:api-url` 3/3、`npm run test:changed-format` 5/5 通过。
- 完整 Web/full graph/build 尚未执行：与 #212/#171 的重型窗口串行协调，待 #171 正式合入后验收真实接口。
- 实际浏览器 File System Access、本轮截图和真实备份 API/数据库恢复联调未执行。现有浏览器运行链路此前返回连接/附加失败；mounted 测试不能代替浏览器或生产恢复证据。

## 回归与回滚

正式合入 #171 后正常 merge 最新 main，复核新增字段与双布局导出 HTTP 下载默认值，运行 Web 全套、strict/lint/build、请求/导出 URL 与格式检查。重点回归两个 target、未知提交 GET-only 恢复、active/404/损坏回执、peer 解除后 GET 失败、同 owner 的 session revision、撤权与强制改密、配置并发及大文件直接保存。

回滚本 Issue 的前端提交即可恢复备份占位区；不回滚数据库、备份卷、已创建任务或已经提交的恢复结果。Legacy 入口与生产切换状态按各自阶段保留。
