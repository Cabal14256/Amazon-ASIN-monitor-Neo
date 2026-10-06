# Neo 目录批量删除操作与恢复（Issue #211）

主营与竞品目录均支持选择变体组后批量删除组及执行时的全部子 ASIN。两类 bulk API/controller/service 需要 `asin:delete`；竞品原有单项按钮继续使用主线的 `asin:write` gate。当前页勾选支持移动端与桌面端；“选择本页可删除组”只选择本页，不代表全部筛选结果。翻页、每页数量、筛选、账号、会话或删除权限变化都会清除选择和确认。

确认面板列出冻结的原始 ID，并说明不可撤销和服务端执行时的数据口径。请求统一通过 typed service 与共享 HTTP URL builder，使用异步偏好；后端仍可能返回同步结果。同步统计显示实际组数、直接/级联 ASIN 数和跳过数，不能把请求数当作成功数。

## 迁移原始 ID 的暂时限制

当前批量后端保留 Legacy trim 规则，前后带空格的原始 ID 可能指向另一个 trimmed 邻居。UI 选择器与 typed service 双层拒绝这类 ID，不改展示或详情 ID；提示使用现有单项删除。后端安全兼容与真实 PostgreSQL/MySQL 对拍见 [Issue #212](https://github.com/Cabal14256/Amazon-ASIN-monitor-Neo/issues/212)。修复之前不得在控制台自行 trim 并发送 bulk。

## 回执与刷新

- `mode: sync`：保存准确统计，重读当前目录（空末页会纠正页码）成功后才解除共享写入保护。重读失败保持保护并可再次读取，不能再次删除。
- `mode: async`：只表示已受理，不表示已完成。保存任务 ID，HTTP 查询/现有 WS 失效通知同步状态与进度；只有相同 ID、`batch-delete` 与该目录 subtype 的终态任务，加成功目录重读，才能解除保护。失败或取消可能已有部分删除，显示实际回执与失败分块数。
- 500/503 的合法 `taskId + status: unknown`：保留任务查询 ID，按提交未确认提示。任务 404 或查询失败不能解除保护，也不能把 404 当成可以重新提交的证据。
- 响应丢失、超时、取消、无效响应或无 ID 的服务器故障：保留未知提交记录，不自动重试 POST。“重读目录核对结果”只读；读取目录不能证明延迟任务不存在。须先由操作员核实任务中心/管理员记录，勾选不存在待执行删除任务，再使用明确的“解除删除保护（不重发请求）”。
- 明确的参数、授权、容量或事务前置拒绝（400/401/403/404/409/413/429）仅清除自己的预提交 claim。不能清除其他标签创建的记录。

## 浏览器与跨标签保护

提交前必须能持久化恢复记录，并使用与现有单项写入/导入相同的 owner/domain Web Lock。写入保护存于 `neo:catalog-write-safety:<owner>:<domain>`；不要人工删除这个键来解决未知结果。首次存储失败时不发送请求；读取失败和 JSON 不能解析时保留核实保护，不能当作没有旧操作。回执更新或读取失败时保留原始持久化 claim、当前页面已知 ID/统计和可用的 sessionStorage 收据后备，并提示保存失败；重新进入只合并同一 operation、原始组列表、提交时刻、原 owner/session 的后备收据。后备清理失败不能先删除持久保护；迟到回执不能覆盖替换后的跨标签 claim。

账号和会话变化只清除可操作 UI；已受理工作仍可能继续执行，原账号下保留回执。同一已验证用户重新登录时不自动展示原会话统计或查询旧任务，须以当前 `asin:delete` 且已完成强制改密，显式点击“恢复原会话删除回执（不提交）”。恢复只读取该用户 gate 已绑定的原 session/operationId/原始组列表/提交时刻，锁内复查所有字段；恢复后仍需任务与目录核实，无 ID 未知结果仍须人工审计确认。恢复不枚举历史用户或自动重 POST。排队和响应期间换用户、session、权限或改密策略使旧请求失效；迟到回执只保存到原归属，不更新新会话界面、busy 状态或目录缓存。

## 隔离验收

新增 mounted tests 使用真实 HttpClient/typed service/TaskApi，合成 fetch 响应而不连接生产数据库；覆盖两域、`/api/` 与 gateway base、不重复 `/api`、当前页选择、原始 Unicode、padded ID 零提交、权限撤回/会话变化、强制改密、原会话显式恢复、未知恢复、终态与重读失败。独立 recovery tests 覆盖跨标签串行、先存后发、迟到回执、损坏/篡改记录、localStorage 读写失败后备、404/错误 subtype、替换 claim、后备清理失败与刷新期间身份变化。本任务不改变数据库/API/Worker；真实 bulk 执行沿用对应已存在 Integration CI，原始 ID 对拍由 #212 完成。

2026-10-07 最新配额保护修复后的本地验证（`NODE_OPTIONS=--max-old-space-size=1536`，Vitest 单 worker）：

- 定向 service/recovery/mounted：63 项 / 3 文件 / 零跳过。
- 完整 Web：827 项 / 62 文件 / 零跳过；Web strict、lint、build 通过。Vite 仍报告现有入口与 ECharts chunk 超过 500 kB，未放宽阈值。
- `corepack pnpm exec max setup` 补齐 fresh ignore-scripts install 未生成的 Legacy `.umi` 后，根 `tsc --noEmit --pretty false` 通过；未更改 Legacy tsconfig。
- 根 `test:contracts`：40 项；contracts：168 项 / 14 文件；请求/导出 URL 与 changed-format 回归：8 项，均通过。对全部本次变更文件执行 Prettier 与 `git diff --check`。
- 同一分支较早的 826 项全量结果属于配额修复之前的历史验证，不代表最新提交。

本地未重复运行 Legacy server unit / Legacy `npm run build`、config/db/api/worker 全套及 `build:api`、`build:worker`、`build:db`：本次只改 Web 和操作文档，后端和数据库没有变更，由 PR CI 执行对应基线。未连接真实数据库、生产环境或人工浏览器截图验收；mounted synthetic transport 不冒称真实数据库执行证明。
