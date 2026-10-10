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

## 后续最小验证切片：已准备，未执行

- 从原 `b48ddfb` 干净工作树正常 merge 正式 main `3df5a2a`，得到 `5fda806c`，无冲突；merge 前后的原 15 文件字节及 SHA256 一致。原清单与核验记录保存在本机临时证据目录 `neo-221-verification`，不提交临时日志或哈希文件。
- `backup-download.test.ts` 的成功输入改为真实双 member ustar：dump 与对应 `<filename>.meta.json`，各有合法头部校验和、对齐填充及两个终止块。元数据的 `archiveSha256` 绑定测试 dump；保存后的磁盘端口与 Blob 字节均解包检查成员、正文、padding 和终止块。该 dump 是带 `PGDMP` 前缀的测试内容，不是实际 `pg_dump`，不能据此声称真实恢复通过。
- 准备缺失 metadata 与字节数仍达到下载下限的截断终止块输入，仅在测试夹具解包检查中识别其不完整。当前下载传输只校验首 tar 头及有界字节数，metadata 的 schema 校验由 #171 服务端下载前执行；本切片不增加前端二次验证 sidecar 的产品契约，也不声称当前传输会拒绝这两种输入。真实完整归档仍需 #171 正式接口下载后解包与恢复演练。
- 新增 `backup-panel-identity.test.tsx`，使用实际 `IdentityStore`、`RouteGate`、`BackupPanel`、认证 HTTP 层与原任务 GET。准备 7 项生命周期场景：loading/error 后相同 verified session 恢复、localStorage 保护加 sessionStorage 已知回执恢复、最终 anonymous、不同 owner、相同 owner 的真实 sessionId 变化退休旧 GET，以及 loading 期间取消 POST 后保留未知保护。不同身份隐藏原上下文；未核实操作的 owner 保护继续保留，不因 logout 自动删除。恢复查询只用原 taskId GET，不重发 POST。
- 静态复核发现现有 workspace key 和请求 scope 只核 owner 与 `SessionStore.revision`，没有核服务端验证的 `sessionId`。上述 7 项显式等待 loading 画面，原页的 session 测试则改变本地 revision，因此两者不能代替 authenticated→authenticated 且同 owner、同 revision 的组件边界。另准备 `backup-panel-session-scope.test.tsx` 三项严格 mounted 测试：相同 session 的健康 ACK 控制、仅 sessionId 改变时退休旧 POST 并保留未知保护、仅 sessionId 改变时退休旧 GET 并允许原 taskId 的新 GET。它使用明确的认证 snapshot 测试端口和实际 BackupPanel/HTTP 层，不伪称真实 IdentityStore 跳过 loading，也不触发 runtime reset 来掩盖 scope 缺失。
- 该补充目前只有静态源码与测试准备，尚无实际 RED/GREEN。原身份 7 项、下载 2 项及 9 个产品文件 SHA 保持；新的测试不是通过记录。当前 tree 没有 node_modules；与已安装 tree 的根锁文件 SHA 相同，后续可在串行窗口从根执行 frozen-lockfile 安装并复用现有 pnpm 内容存储，不直接引用另一 tree 的 workspace 源码或 dist 作为本分支验收。
- 上述新增/更新用例、当前 head 的 strict/lint/full Web/build 与真实 FSA 浏览器检查尚未执行。上一节 67/67 是原 `b48ddfb` 夹具的历史结果，不能计作本切片通过。后续获串行验证窗口后先运行五个受影响 focused 文件，核实健康控制与实际身份生命周期，再执行 strict/lint/build、URL 与格式检查；真实浏览器仍需保存用户激活、慢盘背压、取消后原文件与解包证据。

## 回归与回滚

正式合入 #171 后正常 merge 最新 main，复核新增字段与双布局导出 HTTP 下载默认值，运行 Web 全套、strict/lint/build、请求/导出 URL 与格式检查。重点回归两个 target、未知提交 GET-only 恢复、active/404/损坏回执、peer 解除后 GET 失败、同 owner 的 session revision、撤权与强制改密、配置并发及大文件直接保存。

回滚本 Issue 的前端提交即可恢复备份占位区；不回滚数据库、备份卷、已创建任务或已经提交的恢复结果。Legacy 入口与生产切换状态按各自阶段保留。
