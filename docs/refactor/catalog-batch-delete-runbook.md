# Neo 目录批量删除操作与恢复（Issue #211）

主营与竞品目录均支持选择变体组后批量删除组及执行时的全部子 ASIN。两类 bulk API/controller/service 需要 `asin:delete`；竞品原有单项按钮继续使用主线的 `asin:write` gate。当前页勾选支持移动端与桌面端；“选择本页可删除组”只选择本页，不代表全部筛选结果。翻页、每页数量、筛选、账号、会话或删除权限变化都会清除选择和确认。

确认面板用与回执一致的 JSON 字符串表示列出冻结的原始 ID，并保留连续空白，使 padded ID、相邻 trimmed ID 和纯空白 ID 可以区分。引号和转义只用于显示，请求仍提交原始字符串。面板说明不可撤销和服务端执行时的数据口径。请求统一通过 typed service 与共享 HTTP URL builder，使用异步偏好；后端仍可能返回同步结果。同步统计显示实际组数、直接/级联 ASIN 数和跳过数，不能把请求数当作成功数。

## Neo 原始 ID 与输入边界

main 的 [PR #223](https://github.com/Cabal14256/Amazon-ASIN-monitor-Neo/pull/223) 已完成 [Issue #212](https://github.com/Cabal14256/Amazon-ASIN-monitor-Neo/issues/212) 的字面 ID 后端兼容。UI 选择器与 typed service 共用已有 Neo validator/request schema，前后 SP、NBSP、连续空白和非空纯空白 ID 均原样保留，不 trim、不去重或重写为相邻 ID。空字符串、C0/C1/DEL、未配对 surrogate、超过 50 个 Unicode codepoint 的 ID 被拒绝；groupIds 与 asinIds 合计最多 1000 项。非法页面 ID 不可勾选，非法 typed 请求在发送前拒绝。Legacy 实现与 Legacy schema 不变。

## 回执与刷新

- `mode: sync`：保存准确统计，重读当前目录（空末页会纠正页码）成功后才解除共享写入保护。重读失败保持保护并可再次读取，不能再次删除。
- `mode: async`：只表示已受理，不表示已完成。保存任务 ID，HTTP 查询/现有 WS 失效通知同步状态与进度；只有相同 ID、`batch-delete` 与该目录 subtype 的终态任务，加成功目录重读，才能解除保护。失败或取消可能已有部分删除，显示实际回执与失败分块数。
- 500/503 的合法 `taskId + status: unknown`：保留任务查询 ID，按提交未确认提示。任务 404 或查询失败不能解除保护，也不能把 404 当成可以重新提交的证据。
- 响应丢失、超时、取消、无效响应或无 ID 的服务器故障：保留未知提交记录，不自动重试 POST。“重读目录核对结果”只读；读取目录不能证明延迟任务不存在。须先由操作员核实任务中心/管理员记录，勾选不存在待执行删除任务，再使用明确的“解除删除保护（不重发请求）”。
- 明确的参数、授权、容量或事务前置拒绝（400/401/403/404/409/413/429）仅清除自己的预提交 claim。不能清除其他标签创建的记录。

## 浏览器与跨标签保护

提交前必须能持久化恢复记录，目录写入、导入与删除统一按 owner/domain 依次获取 catalog Web Lock 和原 import Web Lock。持有两锁后再次校验两个持久 gate，不能仅凭按钮状态或 HTTP 受理后释放的锁判断没有活动任务。写入保护存于 `neo:catalog-write-safety:<owner>:<domain>`，导入继续保留 `neo:asin-import:<owner>` / `neo:competitor-import:<owner>` 原键；不要人工删除这些键来解决未知结果。首次存储失败时不发送请求；读取失败和 JSON 不能解析时保留核实保护，不能当作没有旧操作。回执更新或读取失败时保留原始持久化 claim、当前页面已知 ID/统计和可用的 sessionStorage 收据后备，并提示保存失败；重新进入只合并同一 operation、原始组列表、提交时刻、原 owner/session 的后备收据。后备清理失败不能先删除持久保护；迟到回执不能覆盖替换后的跨标签 claim。

持久 shared gate 使用旧版 reader 认识的 `phase: inspection` 外壳，内部 `batchDelete` 保存完整删除回执，`importOperation` 保存导入原回执。删除同时在原 import 键保存绑定 operationId/提交时刻的 `uncertain` 阻断桥，防止旧 ImportPanel 在 ACK 后重新上传；桥只能由精确匹配的删除操作清理。旧页面可能把外壳显示为待核实新建，不应以“已核实新建”解除其他标签的删除/导入任务保护；应打开新页面核实真实操作。此兼容只协调同浏览器 owner/domain，多设备仍由后端事务与任务管理保证。

同一用户、session 与 runtime revision 的真实身份重验会暂时卸载目录。若合法异步 ACK 已返回，但 localStorage 与 sessionStorage 的回执更新均失败，当前 runtime 仍保留原任务 ID；loading/error 页面隐藏目录与回执，同身份验证成功后才恢复显示。恢复只允许原 `unknown` claim 与已知任务的 operationId、原始 ID 顺序、提交时刻、owner/domain/session 全部相等，且没有未知字段。peer 已替换绑定或保存更完整 task/refresh 状态时采用 peer 记录，目录保护水合完成前不查询旧任务。身份重新验证且目录保护水合后，任务面板可自动 GET 原任务状态。显式恢复在两锁内先补保存已知 ACK，再 GET 原任务；补保存失败时保留已知 ID 和原持久保护，本次恢复不额外发送任务 GET，也不重发删除。确定身份、session 或 revision 已变时，旧内存回执退休，返回原身份也不复活。

这份内存回执仅存在于当前 runtime。双存储持续不可写时，关闭页面或硬刷新会失去未保存的任务 ID，原持久 `unknown` claim 仍阻止再次提交。本地兼容和回执恢复仍不能替代 #224 / PR #229 的服务端持久排他；两个旧客户端人工清门的 P1 仍阻塞正式合并。

另一标签移除删除或导入 gate 后，本页仍须实际重读目录、修正空末页并丢弃旧详情，成功后才能开放写入。读取失败保持缓存 gate，提供 GET-only 重读/核实入口，不重发 POST；新 session/身份不能接收旧刷新结果。导入完整回执也保存在 shared 外壳内，旧标签仅清原 import 键后，新页面仍能恢复同一任务并核实终态；损坏导入记录不会自动删除或当作无任务重新上传。

账号和会话变化只清除可操作 UI；已受理工作仍可能继续执行，原账号下保留回执。同一已验证用户重新登录时不自动展示原会话统计或查询旧任务，须以当前 `asin:delete` 且已完成强制改密，显式点击“恢复原会话删除回执（不提交）”。恢复只读取该用户 gate 已绑定的原 session/operationId/原始组列表/提交时刻，锁内复查所有字段；恢复后仍需任务与目录核实，无 ID 未知结果仍须人工审计确认。恢复不枚举历史用户或自动重 POST。排队和响应期间换用户、session、权限或改密策略使旧请求失效；迟到回执只保存到原归属，不更新新会话界面、busy 状态或目录缓存。

## 隔离验收

新增 mounted tests 使用真实 IdentityStore/RouteGate/HttpClient/typed service/TaskApi，合成 fetch 响应而不连接生产数据库；覆盖两域、`/api/` 与 gateway base、不重复 `/api`、当前页选择、原始 Unicode、padded 与纯空白 ID 原字节提交、非法输入零提交、权限撤回/会话变化、强制改密、原会话显式恢复、未知恢复、终态与重读失败。独立 recovery tests 覆盖跨标签串行、先存后发、迟到回执、损坏/篡改记录、localStorage 读写失败后备、404/错误 subtype、替换 claim、后备清理失败与刷新期间身份变化。本任务不改变数据库/API/Worker；真实 bulk 执行沿用对应已存在 Integration CI，原始 ID 对拍由 #212 完成。

2026-10-07 正常合并 main cdfd47e、修复 peer 刷新与双版本互斥后的本地验证（`NODE_OPTIONS=--max-old-space-size=1536`，Vitest 单 worker）：

- 定向 service/recovery/mounted、两域 import 与冻结 main reader/claim：145 项 / 8 文件 / 零跳过。新增场景验证实际读取新目录后才解锁、失败保留保护、两域双方排队、accepted/unknown/remount、旧 import 锁与真实旧 parser 的保留/阻断、旧标签仅清原键时 known receipt 恢复。
- 完整 Web：875 项 / 64 文件 / 零跳过；Web strict、lint（零警告）与 build 通过。Vite 保留现有入口与 ECharts chunk 超过 500 kB 的提示，未放宽阈值。
- `corepack pnpm exec max setup` 补齐 fresh ignore-scripts install 未生成的 Legacy `.umi` 后，根 `tsc --noEmit --pretty false` 通过；未更改 Legacy tsconfig。
- 根 `test:contracts`：40 项；contracts：196 项 / 15 文件；请求/导出 URL 与 changed-format 回归：8 项，均通过。对全部 27 个本次变更文件执行 Prettier 与 `git diff --check`。
- 较早 826 / 827 以及仅合并主线后 847 项全量结果均属后续审查修复前的历史验证，不代表最新提交。

本地未重复运行 Legacy server unit / Legacy `npm run build`、config/db/api/worker 全套及 `build:api`、`build:worker`、`build:db`：本次只改 Web 和操作文档，后端和数据库没有变更，由 PR CI 执行对应基线。未连接真实数据库、生产环境或人工浏览器截图验收；mounted synthetic transport 不冒称真实数据库执行证明。

2026-10-09 恢复现有 #211 工作树并正常合并 main 后，原生产基线固定为 `2e2f4de`。真实 IdentityStore、RouteGate、TanStack Router 与 typed fetch 的 2 个健康存储对照通过，8 个双存储更新失败场景先在同身份恢复后的原任务 ID 断言 RED。修复并保留原断言后，54 项通过：原 10 项、36 项 peer 绑定/状态与 ACK 时序、6 项真实身份/session/revision 退休、2 项持续存储故障下的锁内 GET-only 恢复。该阶段 catalog 与 asin 相关 16 个完整测试文件 313 项、Web strict 与完整 Web lint 通过；完整 Web/build 当时尚未重跑。最终字面 ID 与确认显示补充验证如下，不把旧阶段结果算作最终 patch 的全量验收。

2026-10-09 最终字面 ID 与确认补充：

- 保全原 12 份文件 SHA 和旧 padded 拒绝用例后，原源码 28 项测试为 16 RED / 12 健康对照通过。复用正式 main 的 Neo validator/schema 后 28 项通过。旧两域 padded 拒绝用例保留 case 数量，改为原字节选择与提交；typed 负例替换为非法控制字符，数量、长度、身份与其他坏值控制保留。
- 6 项真实挂载确认用例复现未加引号的原始 ID 表示，原 28 项仍通过。首次运行中两条连续空白查询被测试库 accessible-name 归一化干扰，修正为校验实际 aria-label 后，6 条均在原确认内容断言 RED。修复仅用 JSON.stringify 与 whitespace-pre-wrap 显示；原 HTTP 和回执 ID 断言不改。最终 34/34 通过。
- 相关完整 18 文件 362 项通过，其中已包含 54 项身份恢复、34 项字面 ID 与 15 项 typed service，不重复相加。完整 Web 1038 项 / 69 文件、Web strict、完整 lint（零警告）、生产 build 与请求/导出 URL 回归 3 项通过，零跳过。Vite 原有大于 500 kB 的 chunk 提示保留。
- 单 worker、关闭文件并行，NODE_OPTIONS 为 1536 MiB。原源、失败与成功日志和源码/日志 SHA 保存在本机 `%TEMP%/neo-211-verification` 与 `%TEMP%/neo-211-literal-verification`。最终源码没有提交或推送，这些结果不代表远端旧 head 或未来发布 head。
- 未执行完整仓库基线、真实 PostgreSQL/Redis/API/Worker、浏览器 gate 或最新远端 CI/Review。jsdom 内容与编译后的空白 CSS 不能冒称实际浏览器视觉通过；两个依赖 #229 正式 main 的 P1 仍阻塞，PR 保持 Draft。
