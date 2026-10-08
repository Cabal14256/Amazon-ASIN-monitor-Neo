# Neo 主营组内批量添加验收

关联 [Issue #193](https://github.com/Cabal14256/Amazon-ASIN-monitor-Neo/issues/193)。本任务起点为主线 `92a472ae0147ed34a8e3945f7f9a285d593e8cd8`：#167 共享目录锁与持续核验、#182 即时检查、#202 首页真实图表、#203 原生 ID 传输均已正式合入；本 PR 只接入主营组内批量添加，不复制其它未合入分支。

## 生产行为

- 主营变体组详情增加“批量添加 ASIN”，仅在 `asin:write`、共享写入保护及当前身份允许时显示或启用；竞品目录保持原入口。
- 输入支持换行、空格、中英文逗号和分号，先验证原 token 为 10 位 ASCII 字母数字，再大写化并按首次出现顺序去重；显示有效数量、重复数量及无效项的原始项号、行、列。`ſ`/`ß` 等 Unicode 大写映射为 ASCII 的 token 必须拒绝，最多 1000 个唯一有效编码。
- 继承选定组的国家和原始 `parentId`；站点、品牌、类型及可选统一名称使用普通表单。站点/品牌按 100 Unicode 码点、名称按 500 码点验证，禁止控制字符；HTML 输入容量允许合法 astral 字符。站点、品牌及非空名称发送原值，可选名称全空时发送 `null`；国家保留既有 trim/uppercase 处理。
- 在现有目录 Web Lock 中重新读取原始组 ID 并核对打开表单时的完整源字段；记录变化或最新组内数加本次唯一输入的最坏成功数超过 Neo 查询的 5000 子项上限时，不创建 claim、不发送 POST。该前端保守限制可能拒绝实际会因重复而少成功的批次，用户应减少输入。Neo 和 Legacy 还在实际写事务中持有父组锁并重新计数，避免不同用户的 4500+500+500 并发突破读取上限；超容量组本批新行按实际 HTTP 200 逐行 failure 回执呈现，并不伪装整批已回滚。只调用一次现有 `POST /api/v1/asins/batch-create`，复用真实 `HttpClient` 的 URL 合并。
- 主营 HTTP 批量的父组 ID 在两端写入、响应和收据中均保持字面原值，包括前后空格、非空全空格与 50 码点 astral ID。拒绝空串、控制字符、孤立 surrogate 与超长值；成功行的 parentId 必须精确等于原提交，trimmed 邻组回执视为未知，不重发。全空格组的详情 GET 同样保留编码原值，不改变其它单项写入的既有校验。
- 响应必须完整对应每个输入 index/ASIN/国家，统计相符，失败行与 errors 的 index 和消息一一对应。全成功、全失败和部分成功均显示逐行结果，失败项可单独筛选；每页最多 50 行。
- 写入入口保持保护，已知逐行回执在保护屏也可查看；目录与目标详情都重新读取且共享 claim 成功解除前不能关闭回执。回执按 owner/session、operationId、原始 groupId、完整 submitted items 与逐行结果严格校验并持久化；刷新或重新挂载后仍可查看失败原因，不会把成功行当作可重发项。已知回执的刷新失败只重试 GET，每次新 batch 关闭旧回执并使用独立提交身份，避免继承上次失败过滤。
- localStorage 回执保存失败时保留共享 claim、可用的 sessionStorage 后备及保护屏的完整已知结果；修复存储并成功保存后才允许 GET-only 恢复解除保护。损坏或丢失的已知回执不能自动放行；不同 owner/session 或 operation 的回执不会串入当前操作。回执在恢复后继续保存，用户明确“关闭结果”或开始下一次操作才清理对应记录。
- 内存恢复 Map 只保留当前未能完成保护解除的操作；完成目录核实、关闭结果或开始新批次清理旧内存引用。迟到原会话结果只写入原归属存储，不加入当前界面的 Map；已知行仍通过 mounted result 和持久收据展示，当前存储失败记录不会提前释放。
- 同一用户重新登录时不自动展示原会话回执。“恢复原会话已知回执（不提交）”要求当前已验证身份有 `asin:write` 且无需强制改密，锁内再次核对当前用户共享 gate，仅读取 gate 绑定的原 session/operationId/groupId 精确回执，不枚举其他用户或历史操作。恢复保留原会话记录归属与写入保护，之后仅通过 GET 核实；缺失、篡改、存储失败或身份/权限变更继续阻断。排队期间换用户、换 session 或旧会话迟到的 GET/403 均不能发布到新会话界面。
- list 查询的累计子项超过 5000 也会返回 413。“改为每页 1 组重读（不重发）”显式将实际目录范围更新为每页 1 组，并提示原大页未完成。未知结果缩小读取范围后仍进入原 inspection 核实步骤，不能以 GET 成功代替原 POST 结果，也不会重发。
- 超时、网络错误、无效响应、取消及无法确认的 5xx 走现有 `createUncertain` 持续核验；重挂页面后仍需重新读取和显式核实，不能自动重发失败或未知项。
- 关闭在排队/提交中禁用；同步 ref 防重复提交。owner、session、权限或页面变化使旧请求失效，只更新匹配提交的 busy 状态。撤权恢复重新水合原 claim；旧 owner 的迟到 GET/403 不写入新 owner 缓存、结果或权限状态，也不清除替换的跨标签 claim。

## Review 修复的专项验证

2026-10-07 针对 PR #206 的两个 P1 与一个 P2，新增原始 Unicode 编码、4999+2 最坏容量和部分回执重挂四项测试，原 head 全部失败；修复后四项通过（定向筛选 45 skipped，仅筛选而非服务缺失）。增加两个实际 413 页容量恢复用例（已知/未知）、存储配额失败后备恢复、原组与输入一起篡改时保留 gate，以及严格 metadata/逐行回执测试。另补同一用户重新登录后的显式精确恢复、当前撤权/强制改密门槛、原会话迟到 GET/403、新会话排队取消及三类原绑定篡改测试；安全 gate 也覆盖外部用户/域/session 类型与损坏绑定。该轮专项命令为 `corepack pnpm --filter web exec vitest run src/pages/asin/asin-batch-input.test.ts src/pages/asin/asin-batch-create-form.test.tsx src/pages/asin/asin-batch-receipt.test.ts src/pages/catalog/primary-batch-page.test.tsx src/pages/catalog/catalog-safety-gate.test.ts src/services/asin-batch-create.test.ts --maxWorkers=1`：历史 131 passed / 6 files / 0 skipped（mounted 47、回执 storage 21、解析 18、表单/结果 6、传输 30、gate 9）；Web strict `tsc -p tsconfig.json --noEmit`、lint（0 warnings）、URL 与格式脚本单测（8 passed）、显式改动文件 Prettier 与 `git diff --check` 通过。本轮使用 NODE heap 1536 MB、单 worker。下表保留的是修复前的整套验收记录，修复后的完整 CI 仍须覆盖最新 head，不能把旧 845 项计作修复后全套通过。

随后审查发现实际 Legacy `asinBatchCreateService.addSuccess` 和 Neo `addBatchAsinSuccess` 的成功行均含 `parentId`，原收据 allowlist 漏掉该字段。历史 2de9d42 补齐 allowlist 后曾按两个 producer 当时的 trim 规则校验；之后审查定位该规则会指向 padded ID 的 trimmed 邻组，现已在两端和前端改为原提交的精确字面匹配。storage test 直接调用更新后的 Neo 纯 producer，mounted synthetic transport 使用实际字段形状并验证 padded/all-space/50 码点成功回执与 remount。历史 allowlist 修复前定向复现三项失败（71 skipped 仅筛选），当时 137 passed / 6 files 不代表当前 literal/capacity 修复的验收。

本轮 literal/capacity/内存修复的最新前端专项（NODE heap 1536 MB、单 worker）：182 passed / 7 files / 0 skipped（mounted53、receipt37、input18、form6、batch transport37、gate9、canonical transport22）。首次新增全空格 mounted 场景 159 passed/1 failed，发现详情 GET 仍拒绝 canonical 全空格值，修复仅 GET 字面读取后全绿；不是删除用例或降低校验。Web strict、lint 零警告、URL/格式脚本 8、变更文件 Prettier/diff 通过。Backend deea75ae 专项 DB19、API48、Legacy unit55 及 expanded source strict 通过；21 实际 PG/MySQL 场景本地 opt-in 跳过，待 Integration CI。最新 full Web/build/graph 与后台全套由 root 协调或新 head CI 执行，历史 845/137 不移作当前全套结果。

共享 normalizer 的 literal 行为已收窄为主营 HTTP batch-create，竞品和文件导入继续冻结 trim 口径；实际调用者 oracle 专项 DB23、API48、Legacy55、expanded source strict 通过。随后 Integration `37528062785` 的竞品 comparator 28 项通过，主营实际 PG/MySQL 21 项中 20 通过，PG 4500+500+500 的等待观察失败：同一观察事务中的 `pg_stat_activity` 可能缓存第二 HTTP 连接出现前的统计快照。夹具改为实时 `pg_locks` 未授予 transaction-ID 锁并精确证明第一批 PID 是 blocker，保持暂停第一批真实 insert、第二批真实等待、500/0 成功计数、500 行失败、最终 5000 和详情 GET 成功全部断言。该修复后本地 source strict/收集通过，21 项仍因未启 opt-in 跳过；实际锁证明须最新 Integration CI 21/21 验收，不能将本地 skip 称作恢复成功。

## 生产 JSON 解析层验收（评论 4201134469）

Legacy `server/src/index.js` 调用 `installBodyParsers`，Neo `apps/api/src/main.ts` 调用 `createHttpAdapter`；两端 JSON body 均限制为有界 **4 MiB**。普通 1,000 行请求超过原 Legacy 100 KiB，合法最大宽度 Unicode 1,000 行请求超过原 Neo 1 MiB；调整解析上限使其能进入后续鉴权、合同和业务校验，超过 4 MiB 的请求仍在 dispatch 前以 413 拒绝。

root 已执行两个生产解析器的独立原生回归，Legacy `server/test/json-body-parser.test.js` **1 passed**，Neo `apps/api/test/http-body-limit.test.ts` **1 passed**：实际 Express loopback 与生产 Fastify adapter inject 分别验证普通 1,000 行及最大 Unicode 宽度 1,000 行（parentId/site/brand/name 分别 50/100/100/500 码点）为 200 且 count=1000；大于 4 MiB 为 413，已 dispatch 数仍为 2。Neo 回归同时断言两端字节上限相同。测试路由只回报解析后的条数，**此证据仅证明生产解析层，不证明完整鉴权、写事务、逐行业务回执或浏览器验收通过**。

两项回归也完成实际 RED→GREEN：临时将 Legacy 恢复为默认 `express.json()`、Neo 移除 `bodyLimit` 时，各自的合法请求均得到 413，两个测试分别因 expected 200 而失败；`finally` 精确恢复修复源码后，各自 **1 passed**。本机 Temp `neo-206-bootstrap-verification/*default-parser-red.log` 与 `*parser-green.log` 保存解析层红绿日志。

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

上述历史全量验收未重复默认后台基线，当时尚未修改后端。后续 Review 的 literal/capacity 修复涉及 Neo repository/domain 与 Legacy service，对应最新专项和真实数据库 opt-in 验证以 PR `验证` 为准；本地没有把 skip 计作真实 SQL 通过。未修改数据库 schema、Worker、Notify、Config、公共 v1 合同、依赖或根锁。

## 红绿与竞态证据

- 暂时使用原主线 CatalogPage 源，实际挂载“全成功”用例因不存在批量入口而 1 failed / 21 名称筛选 skipped；随后 `finally` 恢复新源。日志位于本机 Temp `neo-193-red-old-entry.log`。
- 暂时恢复表单的 `site.trim()/brand.trim()/name.trim()`，两个 base 的原空格/astral 容量真实请求用例 2 failed / 20 名称筛选 skipped；`finally` 恢复原值提交。日志 `neo-193-red-field-trim.log`。
- 暂时移除新增 `afterWrite` catch guard，旧 owner 的迟到 403 与同 session 撤权恢复的迟到 403 两例 2 failed / 27 名称筛选 skipped；`finally` 恢复 guard。日志 `neo-193-red-late-403.log`。
- 上述名称筛选跳过只发生在有意 RED 探针，完整 GREEN Web 无 skipped。最初测试夹具的查询选择和共享 inspection phase 断言修正不算产品 RED 证据。
- mounted CatalogPage 使用真实 HttpClient/Query/IdentityStore 边界：两个 API base、原生空格与 50 码点 ID、完整/部分/失败回执、刷新失败只 GET、未知结果重挂、真实 120 秒传输定时器（fake clock 不增加门槛）、重复 submit、排队换 owner/session、撤权恢复、旧 GET/403、跨标签替换及卸页取消。

## 浏览器验收

### 生产 RouteGate 临时身份校验（评论 4201134464）

`IdentityStore.refresh()` 会先发布 `loading`；网络校验失败发布 `error`，两者都会使实际 `RouteGate` 暂时卸载目录。此时身份尚未确认改变，已知逐行回执必须保留。目录卸载后的退休订阅继续等待确定身份：同一已验证 owner/session 保留原行；确定匿名、另一个 owner 或 session 后，才进入原回执 owner 的 Web Lock。锁内再读当前身份与实际持久 gate；排队期间再次进入校验则继续等待，同一会话回来则停止退休，原操作仍受保护或 gate 不可读时保留恢复证明。runtime dispose 撤销订阅，不能据此推断注销或释放门禁。

显式恢复旧会话回执时，存储与锁使用回执的原 owner，身份比较使用当前展示该回执的 owner/session，避免把旧归属当作本次登录已改变的证据。权限变化仍隐藏写入结果并保留回执，确认后续退出才检查是否可退休。

2026-10-09 新增实际 `IdentityStore`、真实 `HttpClient` 配合 synthetic current-user fetch 响应、原 `RouteGate`/memory router 的 pending/error→ 同会话恢复、pending/error→ 匿名/另用户/另 session，以及仍受保护的回执/gate 对照。临时恢复原 CatalogPage 源执行这 11 项时，**8 failed / 3 protected 对照 passed**，66 项仅因名称筛选跳过；失败均复现临时校验期间原逐行回执已被删除。`finally` 按字节恢复修复源后，完整受影响命令 `corepack pnpm --filter web exec vitest run src/pages/catalog/primary-batch-page.test.tsx src/pages/asin/asin-batch-receipt.test.ts src/pages/catalog/catalog-batch-receipt-retirement.test.ts --maxWorkers=1` **130 passed / 3 files / 0 skipped**（页面 77、存储 46、订阅生命周期 7）。生命周期回归覆盖 dispose、排队锁内再次 loading/error、同会话确认、确认注销重新排队、显式恢复旧会话的展示身份、排队期间新增原保护以及 Web Locks 不可用。

本轮 contracts build、Web strict `tsc -p tsconfig.json --noEmit --pretty false`（含 src 下测试）、完整 Web lint 零警告、URL 去重 3 项、changed-format 脚本 5 项、五个 P2 文件 Prettier 与 `git diff --check` 均通过。未重复 full Web/build，其重型基线由 root 后续串行执行；没有改测试等待门槛或超时。RED/GREEN 日志位于本机 Temp `neo-206-p2-verification/identity-receipt-{red,green}.log`，恢复后的 index SHA256 为 `1C32534BAE3B6D66BF59BBBB111A185562D47B2B5906EC91928D4345A065D360`。上述场景是 mounted 证据，实际浏览器验收仍沿用下文“尚未执行”。

### 生产 RouteGate 注销卸载回收（评论 4200823271）

`RouteGate` 在身份变为匿名时直接渲染 `Navigate`，目录页没有再次 render 的机会。本轮在目录卸载时读取最新 IdentityStore snapshot；只有 logout、owner 或 session 已与原回执归属不同才调用退休逻辑，普通导航和同会话重新挂载仍保留可查看的完成结果。身份变化 effect 与卸载共用同一回收方法，始终在原用户的 catalog Web Lock 内读取实际持久 gate；未知操作、仍绑定原 operation 或不可读的保护记录继续保留，不提交请求，不清除门禁。

- 使用实际 TanStack memory router、原 `RouteGate`/`Navigate` 和真实 CatalogPage/HttpClient。原 head 普通 logout、先撤写权限再 logout 和原 owner 锁排队三个场景 RED，保护中的原回执对照 GREEN；修复后四项 GREEN。
- 首次完整受影响检查发现无条件卸载退休会破坏五个原有同会话 remount 场景，已收窄为真实身份变化，而非删掉原测试。两个受影响文件随后 **111/111** 通过（页面 65、receipt 46）。又补实际 RouteGate 同会话 remount 对照，最新五个生产 gate 场景 **5/5** 通过，61 项仅因名称筛选跳过。
- 本轮 Web strict `tsc -p tsconfig.json --noEmit`、两个改动源/测试文件 ESLint、3 文件 Prettier、URL 去重 3 项、changed-format 5 项与 `git diff --check` 通过；仅轻量受影响检查，不重复完整 Web/build，重型窗口仍由 root 协调。mounted 证据不能替代真实浏览器验收。

### 本轮回执审查修复（评论 4200536701 / 4200536711）

完成结果仍打开时，owner/session 变化或退出会在原用户的 catalog Web Lock 内重新检查原共享门禁，精确移除不再受保护的原 operation 回执与 head；写权限先撤回而隐藏结果、随后退出也执行相同清理。仍引用原 operation、缺少 operation 绑定、损坏或不可读的门禁及不可访问存储均保留回执，清理流程不删除门禁、不提交请求。显式关闭结果或开始新批次会释放最后一个内存引用。

跨标签门禁由操作 A 变为 B 时，重读仅使用与 B operationId 一致的内存结果，再读取 B 的原 owner/operation 存储记录；未知 B 进入 GET-only 核实，B 的持久回执晚到也能继续恢复，不会被已完成 A 的结果或原会话授权标记误挡。

- 新增 6 个 mounted 场景在原源码执行时为 5 failed / 1 protected 对照通过；修复后全部 GREEN。最初 logout 夹具返回非缓存 snapshot 的夹具错误已修正后重新执行 RED，最终产品 RED 日志在 Temp `neo-206-ui-receipt-red.log`。
- 后续“撤权隐藏结果再 logout”实际 mounted 单场景先 1 failed，修复后 GREEN；加上原 owner 锁排队时再次出现原 gate 的保留场景，本轮共新增 8 个 mounted 场景及 9 个门禁/存储单元场景。
- 两个受影响完整文件实际 107 passed / 0 skipped（CatalogPage 61、receipt 46），保留原会话显式恢复、不可读回执、迟到身份/403、跨标签 gate 和 GET-only 回归。名称筛选的 RED/GREEN 探针有 skipped，未计为完整验收。
- Web strict `tsc -p tsconfig.json --noEmit`、4 个源码/测试文件的 ESLint、5 个本轮文件的 Prettier 与 `git diff --check` 通过；URL 兼容 3 项和格式脚本 5 项通过。
- 本轮只执行轻量受影响测试与静态检查，未重复完整 Web/build；完整重型窗口用于其它迁移门禁，最新 CI 和 Review 仍须由 PR 核验。真实浏览器结论沿用下述“尚未执行”，没有把 mounted 测试写成浏览器证据。

2026-10-07 本轮实际浏览器验收未能执行。子代理的可见 IAB 返回 `IAB visibility is not supported in a subagent thread`；隐藏 IAB 及根代理 IAB 均在等待 webview attach 时超时，根代理 Edge 连接也失败。未沿用历史截图或旧浏览器操作作为本轮证据。上面的 mounted 组件、实际 HttpClient 与 loopback 网络测试已通过，但不替代真实浏览器布局、键盘和像素验收。

当前源码的 `/asin` 预览和独立本地 HTTP fixture 已准备好，供恢复浏览器工具后或人工继续验收。HTTP 数据不是生产账号、数据库或 Amazon 实测；不得把夹具验收写成生产 15 页面已全部通过。

- Web 预览 `http://127.0.0.1:5178/asin`；独立 HTTP fixture 3001。fixture mode 只通过明确的 CLI 控制接口设置为 `partial`、`success`、`failure` 或 `unknown`，`/__fixture__/log` 保留实际 URL/payload/行变更收据；不调用裸 state URL。
- 默认源组 ID 为 `Gróup 批量`，站点 `amazon.com`、品牌 `Fixture 中文`，保留首尾空格；另一组 ID 为首尾空格加 48 emoji，共 50 码点。`unknown` 先实际修改 fixture 行，再返回 total 不相符回执，恢复后应核验重挂不会重复 POST。
- 尚待实际浏览器记录：桌面/窄屏宽度、键盘焦点/提交、部分结果和失败过滤、下一次全成功结果、未知结果 reload/显式检查、实际 wire 数量与截图路径。目前仅表示服务已就绪，未产生本轮 UI 验收截图。

## 范围、风险与回滚

本次仅一个主营批量创建闭环，包含输入解析、表单/结果/协调器、operation-bound 收据存储、Neo/Legacy 字面父组与事务容量保护、实际挂载和隔离 SQL 夹具及文档；文件数与变更行数超过警戒线。创建入口、两端容量与恢复、逐行回执保护必须作为同一次写入闭环验收，不能拆成缺少持久核验或会丢失部分成功结果的可发布入口。没有竞品批量、批量删除/检查、图表、数据库 schema 或生产切换。

回滚普通 PR 提交即可恢复既有单项入口，已创建数据不会自动删除。共享 claim 使用已有 schema，已尝试但未知的写入仍须在目录中显式核实；用户应在确认回执/目录后再决定是否另外添加失败项。风险集中在权限/身份切换和 POST 后读失败，实际挂载竞态测试及浏览器 wire 应共同核对。
