# Neo 主营组内批量添加验收

关联 [Issue #193](https://github.com/Cabal14256/Amazon-ASIN-monitor-Neo/issues/193)。本任务起点为主线 `92a472ae0147ed34a8e3945f7f9a285d593e8cd8`：#167 共享目录锁与持续核验、#182 即时检查、#202 首页真实图表、#203 原生 ID 传输均已正式合入；本 PR 只接入主营组内批量添加，不复制其它未合入分支。

## 生产行为

- 主营变体组详情增加“批量添加 ASIN”，仅在 `asin:write`、共享写入保护及当前身份允许时显示或启用；竞品目录保持原入口。
- 输入支持换行、空格、中英文逗号和分号，先验证原 token 为 10 位 ASCII 字母数字，再大写化并按首次出现顺序去重；显示有效数量、重复数量及无效项的原始项号、行、列。`ſ`/`ß` 等 Unicode 大写映射为 ASCII 的 token 必须拒绝，最多 1000 个唯一有效编码。
- 继承选定组的国家和原始 `parentId`；站点、品牌、类型及可选统一名称使用普通表单。站点/品牌按 100 Unicode 码点、名称按 500 码点验证，禁止控制字符；HTML 输入容量允许合法 astral 字符。站点、品牌及非空名称发送原值，可选名称全空时发送 `null`；国家保留既有 trim/uppercase 处理。
- 在现有目录 Web Lock 中重新读取原始组 ID 并核对打开表单时的完整源字段；记录变化或最新组内数加本次唯一输入的最坏成功数超过 Neo 查询的 5000 子项上限时，不创建 claim、不发送 POST。该保守限制可能拒绝实际会因重复而少成功的批次，用户应减少输入；它不表示服务端已回滚。只调用一次现有 `POST /api/v1/asins/batch-create`，复用根锁依赖和真实 `HttpClient` 的 URL 合并，不增加后端/数据库语义。
- 响应必须完整对应每个输入 index/ASIN/国家，统计相符，失败行与 errors 的 index 和消息一一对应。全成功、全失败和部分成功均显示逐行结果，失败项可单独筛选；每页最多 50 行。
- 写入入口保持保护，已知逐行回执在保护屏也可查看；目录与目标详情都重新读取且共享 claim 成功解除前不能关闭回执。回执按 owner/session、operationId、原始 groupId、完整 submitted items 与逐行结果严格校验并持久化；刷新或重新挂载后仍可查看失败原因，不会把成功行当作可重发项。已知回执的刷新失败只重试 GET，每次新 batch 关闭旧回执并使用独立提交身份，避免继承上次失败过滤。
- localStorage 回执保存失败时保留共享 claim、可用的 sessionStorage 后备及保护屏的完整已知结果；修复存储并成功保存后才允许 GET-only 恢复解除保护。损坏或丢失的已知回执不能自动放行；不同 owner/session 或 operation 的回执不会串入当前操作。回执在恢复后继续保存，用户明确“关闭结果”或开始下一次操作才清理对应记录。
- list 查询的累计子项超过 5000 也会返回 413。“改为每页 1 组重读（不重发）”显式将实际目录范围更新为每页 1 组，并提示原大页未完成。未知结果缩小读取范围后仍进入原 inspection 核实步骤，不能以 GET 成功代替原 POST 结果，也不会重发。
- 超时、网络错误、无效响应、取消及无法确认的 5xx 走现有 `createUncertain` 持续核验；重挂页面后仍需重新读取和显式核实，不能自动重发失败或未知项。
- 关闭在排队/提交中禁用；同步 ref 防重复提交。owner、session、权限或页面变化使旧请求失效，只更新匹配提交的 busy 状态。撤权恢复重新水合原 claim；旧 owner 的迟到 GET/403 不写入新 owner 缓存、结果或权限状态，也不清除替换的跨标签 claim。

## Review 修复的专项验证

2026-10-07 针对 PR #206 的两个 P1 与一个 P2，新增原始 Unicode 编码、4999+2 最坏容量和部分回执重挂四项测试，原 head 全部失败；修复后四项通过（定向筛选 45 skipped，仅筛选而非服务缺失）。增加两个实际 413 页容量恢复用例（已知/未知）、存储配额失败后备恢复、原组与输入一起篡改时保留 gate，以及严格 metadata/逐行回执测试。修复后专项命令 `corepack pnpm --filter web exec vitest run src/pages/asin/asin-batch-input.test.ts src/pages/asin/asin-batch-create-form.test.tsx src/pages/asin/asin-batch-receipt.test.ts src/pages/catalog/primary-batch-page.test.tsx src/pages/catalog/catalog-safety-gate.test.ts src/services/asin-batch-create.test.ts --maxWorkers=1`：116 passed / 6 files / 0 skipped；Web strict `tsc -p tsconfig.json --noEmit`、lint（0 warnings）、URL 与格式脚本单测（8 passed）、显式改动文件 Prettier 与 `git diff --check` 通过。本轮使用 NODE heap 1536 MB、单 worker。下表保留的是修复前的整套验收记录，修复后的完整 CI 仍须覆盖最新 head，不能把旧 845 项计作修复后全套通过。

## 自动验证（修复前历史记录）

所有命令从该 managed worktree 根执行，仅使用根 `pnpm-lock.yaml`；未改变服务等待门槛或测试超时。2026-10-07 接续时重新检查现有 diff 与新增文件，并重跑下表注明的完整前端与根级检查；历史专项和 RED 探针单独标注，不冒充本轮重跑。

| 命令 | 实际结果 |
| --- | --- |
| `corepack pnpm install --frozen-lockfile --offline` | 接续前历史验证成功，未修改锁文件；本轮依赖已就绪，未重复安装 |
| `corepack pnpm --filter web test src/pages/catalog/primary-batch-page.test.tsx src/pages/asin/asin-batch-create-form.test.tsx src/pages/asin/asin-batch-input.test.ts src/services/asin-batch-create.test.ts --maxWorkers=1` | 接续前专项为 81 passed / 4 files / 0 skipped；本轮完整套件再次执行并通过相同实际页面 29、表单/结果 6、传输 30、解析 16 项 |
| `corepack pnpm --filter web test --maxWorkers=1` | 本轮 845 passed / 63 files / 0 skipped；267.63 秒；实际单 worker |
| `corepack pnpm --filter web lint` | 成功，0 warnings |
| `corepack pnpm --filter web typecheck` | 成功，包含生产源与测试的 strict 类型检查 |
| `corepack pnpm --filter web build` | 本轮成功；Vite 47.27 秒；既有 entry 548.81 kB、独立 ECharts runtime 565.53 kB 的 >500 kB 提示保留，未抬高阈值 |
| `corepack pnpm test:contracts` | 成功，包含 request/export URL 3 例及完整根合同脚本 |
| `corepack pnpm --filter contracts test --maxWorkers=1` | 155 passed / 13 files / 0 skipped |
| `corepack pnpm exec tsc --noEmit --pretty false` | 成功 |
| `npm run test:changed-format` | 5 passed |
| 显式 15 文件 Prettier / `git diff --check` | 成功；浏览器证据填入后再核对文档 |

本地有意跳过的默认后台基线：`npm --prefix server run test:unit`、`npm run build`、`corepack pnpm --filter config test`、`corepack pnpm --filter db test`、`corepack pnpm --filter api test`、`corepack pnpm --filter worker test`、`corepack pnpm build:api`、`corepack pnpm build:worker`、`corepack pnpm build:db`。本 PR 未修改 Legacy、API、Worker、Notify、DB、Config、合同源码、依赖或根锁；它们的实际 CI/Integration 门禁仍须在本 PR 最新 head 上完成。这是未重跑的说明，不能记作本地通过，也不能把 prior PR 的后端计数移作本 PR 收据。

## 红绿与竞态证据

- 暂时使用原主线 CatalogPage 源，实际挂载“全成功”用例因不存在批量入口而 1 failed / 21 名称筛选 skipped；随后 `finally` 恢复新源。日志位于本机 Temp `neo-193-red-old-entry.log`。
- 暂时恢复表单的 `site.trim()/brand.trim()/name.trim()`，两个 base 的原空格/astral 容量真实请求用例 2 failed / 20 名称筛选 skipped；`finally` 恢复原值提交。日志 `neo-193-red-field-trim.log`。
- 暂时移除新增 `afterWrite` catch guard，旧 owner 的迟到 403 与同 session 撤权恢复的迟到 403 两例 2 failed / 27 名称筛选 skipped；`finally` 恢复 guard。日志 `neo-193-red-late-403.log`。
- 上述名称筛选跳过只发生在有意 RED 探针，完整 GREEN Web 无 skipped。最初测试夹具的查询选择和共享 inspection phase 断言修正不算产品 RED 证据。
- mounted CatalogPage 使用真实 HttpClient/Query/IdentityStore 边界：两个 API base、原生空格与 50 码点 ID、完整/部分/失败回执、刷新失败只 GET、未知结果重挂、真实 120 秒传输定时器（fake clock 不增加门槛）、重复 submit、排队换 owner/session、撤权恢复、旧 GET/403、跨标签替换及卸页取消。

## 浏览器验收

2026-10-07 本轮实际浏览器验收未能执行。子代理的可见 IAB 返回 `IAB visibility is not supported in a subagent thread`；隐藏 IAB 及根代理 IAB 均在等待 webview attach 时超时，根代理 Edge 连接也失败。未沿用历史截图或旧浏览器操作作为本轮证据。上面的 mounted 组件、实际 HttpClient 与 loopback 网络测试已通过，但不替代真实浏览器布局、键盘和像素验收。

当前源码的 `/asin` 预览和独立本地 HTTP fixture 已准备好，供恢复浏览器工具后或人工继续验收。HTTP 数据不是生产账号、数据库或 Amazon 实测；不得把夹具验收写成生产 15 页面已全部通过。

- Web 预览 `http://127.0.0.1:5178/asin`；独立 HTTP fixture 3001。fixture mode 只通过明确的 CLI 控制接口设置为 `partial`、`success`、`failure` 或 `unknown`，`/__fixture__/log` 保留实际 URL/payload/行变更收据；不调用裸 state URL。
- 默认源组 ID 为 `Gróup 批量`，站点 `amazon.com`、品牌 `Fixture 中文`，保留首尾空格；另一组 ID 为首尾空格加 48 emoji，共 50 码点。`unknown` 先实际修改 fixture 行，再返回 total 不相符回执，恢复后应核验重挂不会重复 POST。
- 尚待实际浏览器记录：桌面/窄屏宽度、键盘焦点/提交、部分结果和失败过滤、下一次全成功结果、未知结果 reload/显式检查、实际 wire 数量与截图路径。目前仅表示服务已就绪，未产生本轮 UI 验收截图。

## 范围、风险与回滚

本次仅一个主营批量创建闭环，18 文件中包含分离的输入解析、合同响应适配、表单/结果/协调器、operation-bound 收据存储、实际挂载竞态与文档；文件数与变更行数超过警戒线。创建入口、容量与恢复、逐行回执保护必须作为同一次写入闭环验收，不能拆成缺少持久核验或会丢失部分成功结果的可发布入口。没有竞品批量、批量删除/检查、图表、虚拟任务提示或后端变更。

回滚普通 PR 提交即可恢复既有单项入口，已创建数据不会自动删除。共享 claim 使用已有 schema，已尝试但未知的写入仍须在目录中显式核实；用户应在确认回执/目录后再决定是否另外添加失败项。风险集中在权限/身份切换和 POST 后读失败，实际挂载竞态测试及浏览器 wire 应共同核对。
