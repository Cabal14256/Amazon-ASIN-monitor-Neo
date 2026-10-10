# Neo 目录手动检查验收（Issue #214）

本任务增补主营所选变体组批量检查、竞品单组和单 ASIN 检查。主营已上线的单项入口保留；两类目录沿用 Legacy 和 Neo API 的 `asin:read` 权限，不增加写权限要求。

当前 PR #216 保持 Draft，存在未解决的跨版本 P1：[旧 bundle 可通过原 reconcileCreate 清除 active check](https://github.com/Cabal14256/Amazon-ASIN-monitor-Neo/pull/216#discussion_r4237204983)。代码合并与部署依赖 [Issue #224](https://github.com/Cabal14256/Amazon-ASIN-monitor-Neo/issues/224) / [PR #229](https://github.com/Cabal14256/Amazon-ASIN-monitor-Neo/pull/229) 的持久后端保护正式进入 `main`，随后同步主线并验证旧恢复后的实际写请求被拒绝。仅 #229 分支已有验收或本轮 Web 检查通过，均不能解除此阻塞；生产切换仍暂停。

## 接口范围与迁移边界

| 操作 | 已有 Neo 接口 | 异步任务类型 / 子类型 |
| --- | --- | --- |
| 主营所选组检查 | `POST /api/v1/variant-groups/batch-check` | `batch-check` / `variant-group` |
| 竞品单组检查 | `POST /api/v1/competitor/variant-groups/:groupId/check` | `variant-check` / `competitor-variant-group-check` |
| 竞品单 ASIN 检查 | `POST /api/v1/competitor/asins/:asinId/check` | `variant-check` / `competitor-asin-check` |

新入口明确传 `useAsync: true` 和当前确认的 `forceRefresh`。竞品 Neo 服务默认保持 Legacy 同步行为，因此该参数必须显式提供。异步 ACK 的 `taskType` 是子类型；前端校验任务 ID、pending / unknown 状态和相应子类型，批量 ACK 若携带总数，必须匹配目标数量。

Legacy 竞品批量检查菜单和契约登记已有，但 Neo 没有对应 controller / worker bulk 实现。本任务不展示竞品批量检查按钮、不伪造请求，也不修改 API、数据库或生产切换门禁。父 ASIN 批量查询、定时检查、导出、批量删除分别由独立任务负责。

## 操作与恢复

- 主营桌面表格与窄屏卡片使用同一多选状态。筛选、页码、每页数量或身份范围变化后选择失效；不会对筛选外、未勾选的组执行操作。检查前展示数量、每一个原始 ID 与强制刷新选项，取消确认不发送 POST。
- JSON 批量 ID 保留原始大小写、Unicode、普通空格和分隔符；不 trim / uppercase / 自动合并不同字符串。单项路由使用编码后的原始 ID，仍拒绝路径边界不安全的值。选择上限与 API 一致为 1000 个组。
- 服务端验证身份的 owner、sessionId、运行时 session revision、`asin:read` 或强制改密状态变化，会卸载当前目录操作并中止请求。等待 Web Lock 的旧提交再次检查身份；旧请求的迟到结果仅保留原 owner 的恢复记录，不进入新账号界面或缓存。
- 提交前写入 `neo:catalog-check:<domain>:<owner>`，兼容原主营单项记录；同时记录同 owner / domain 的 `neo:catalog-write-safety`，使用该共享 Web Lock。共享存储使用 `{ phase: 'inspection', operationId, check }` 外壳，新版读取为逻辑 `check`，旧 main parser 读取时保留原 key。旧 writer 重写丢失 check 字段时，新版仍可用独立回执恢复目标和任务编号，并要求原 operationId 与独立回执匹配才允许更新或核实清除。这些保护适用于新版处理路径；旧 bundle 的原 create-recovery 仍能在一次目录 GET 后移除 inspection，故不能宣称已完成跨版本 CRUD / 检查互斥。后端 #224 的 owner / domain 持久槽是该边界的正式依赖。
- 网络断开、超时、取消、非法 ACK 与服务端 500 unknown 回执均保留提交时间和目标。已取得任务 ID 时恢复任务查询；无 ID 时引导按时间和目标到任务中心核实。重载页面不会解除防重。损坏的异步恢复记录阻止新提交。
- pending / processing 任务不能解锁。终态任务先重读当前目录和已打开详情，成功后按 operationId / taskId 清除原记录；重读失败、身份变化或另一标签替换记录时继续保留门禁。无 ID 或已过保留期的任务必须人工确认原任务不会继续执行，再成功重读目录。
- 筛选 A→B→A 会实际清空原选择和确认，而非仅暂时隐藏。其他标签核实并清除检查后，本页必须成功 GET 当前目录才解除缓存门禁；GET 失败明确提示操作仍暂停，并提供“重新读取检查后的目录”，重试只发 GET。离页、账号、权限或强制改密变化会中止重读，迟到结果和新的 peer 门禁不能被旧读取覆盖。
- 检查后的目录重读绑定单调递增的筛选 / 展开版本；即使筛选 A→B→A 返回同一个 query key，早先 A 的迟到读取也不能清除门禁。有效 ACK 在 localStorage 和 sessionStorage 同时无法保存时，会保留同 owner / session / revision 的运行时回执，身份 loading 或可恢复 error 卸载目录后，只有独立持久化预约仍匹配才恢复任务 ID。更换 owner / session、退出和另一标签替换预约均不能复活旧回执。
- 任务读取 403 通过真实身份重验证处理。同一身份连续两次拒绝后暂停自动跟踪，保留原目标和任务编号，提供人工重试；重试只恢复原任务查询，不发第二次检查 POST。身份最终确认变化时清除旧运行时回执，独立持久化预约保留给原账号核实。

## 本轮验证记录

2026-10-07，`NODE_OPTIONS=--max-old-space-size=1536`，测试使用真实 HttpClient、Zod 响应解析、TaskApi / Query 更新及挂载目录组件，仅替换外壳、路由链接和网络响应。

- `corepack pnpm install --frozen-lockfile --ignore-scripts`：12 个 workspace，全部依赖复用，锁文件未变。
- `corepack pnpm --filter contracts build`：通过（供真实传输与 Web strict 使用的共享类型构建）。
- `corepack pnpm --filter web exec vitest run <8 个 catalog / transport 专项文件> --maxWorkers=1 --minWorkers=1`：123 个独立测试全部通过；首次发现并修正竞品函数同步抛错的 Promise 包装，以及旧测试对账号切换复用展开详情 / 竞品缺少检查按钮的预期，针对相关文件重跑 28/28 通过。
- 最终新增接口验证：`corepack pnpm --filter web exec vitest run src/services/catalog-check.test.ts src/pages/catalog/catalog-manual-check-page.test.tsx --maxWorkers=1 --minWorkers=1`：28/28，通过（13 个传输、15 个挂载页面场景；7.93s）。
- `corepack pnpm --filter web exec tsc -p tsconfig.json --noEmit --pretty false`、`corepack pnpm --filter web lint`：最终均通过，0 错误。
- 全部 15 个变更文件 `prettier --check`、`npm run test:changed-format`（5/5）、`git diff --check`：通过。
- `corepack pnpm --filter web exec vitest run --maxWorkers=1 --minWorkers=1`：main `6079990` 基线，799/799、61 文件全通过，0 skip，74.75s。
- 正常合入 #213 / main `197925d` 后，同时保留竞品导入和检查描述；7 个导入 / 目录受影响文件重跑 114/114（34.41s）。检查回执提交时间明确使用北京时间，并以 UTC instant → UTC+08 显示回归验证，和任务中心一致。
- 最新 `corepack pnpm --filter web build`：通过（含 contracts build、Web strict 与 Vite；3255 模块，Vite 16.79s）。入口包 550.26 kB、ECharts 懒加载包 565.53 kB，保留现有 >500 kB 构建提示；本任务未宣称性能阶段门禁通过。
- 本轮实际浏览器交互尚未执行：IAB / Edge 控制链路此前连接失败，不将历史截图或其他任务浏览器结果视为 #214 的证据。挂载组件测试不能替代移动端、键盘和实际跨标签交互验收。

2026-10-07，PR #216 `d4137c3` 后审查修复：

- 实际执行 `main 197925d` 原共享门禁 parser / writer fixture，验证两域新 inspection/check 外壳在 parser 读取时保留旧门禁，旧 writer 丢失 payload 后新版独立回执仍可恢复、禁止新版第二次 POST，并限制新版核实清除。该 fixture 未调用旧 reconcileCreate，不能证明旧人工恢复安全；最新 P1 专门记录此缺口。未知其他 inspection 外壳与损坏 check 保留原始存储，不被新版读操作删除。
- `corepack pnpm --filter web exec vitest run src/pages/catalog/catalog-check-recovery.test.ts src/pages/catalog/catalog-manual-check-page.test.tsx src/pages/catalog/catalog-safety-gate.test.ts --maxWorkers=1 --minWorkers=1`：74/74，3 文件通过（22 个挂载页面、48 个恢复单元、4 个共享门禁单元；10.63s）。新增两域 peer GET 失败重试、替换门禁及离页 / owner / 撤权 / 强制改密 Abort 回归。
- 最后清理 effect cleanup 的 ref lint 提示后，挂载页面重跑 22/22（12.04s）；Web strict、lint 均通过，0 错误 / 0 警告；7 个本轮文件 `prettier --check`、`npm run test:api-url`（3/3）、`npm run test:changed-format`（5/5）和 `git diff --check` 通过。旧 parser / writer fixture 与 `git show 197925d:apps/web/src/pages/catalog/catalog-safety-gate.ts` 完全相同（仅增加来源注释和统一换行）。
- 本次全 Web 与 build 尚未重跑：团队 #215 正占用串行重型验收窗口；本次先执行单 worker 专项、strict、lint 和格式 / URL 轻量检查，完整验收与最新 head CI 另行记录，不沿用旧 head 的全量结果。

2026-10-10，继续 PR #216 的身份 / ACK / 目录重读边界：

- 保全原 `catalog-check-lifecycle.test.tsx`，SHA256 为 `1B747787215D5474756E5F3F011B0C8898CE25B9B340C842E6D961E75BF8624A`；29 项业务 oracle 全程未改。在仅撤回本轮产品变动的原 HEAD `18c63d3` 上，实际 RED 为 18 fail / 11 pass，日志保留在本地忽略目录 `artifacts/pr-216-verification/lifecycle-head-red.log`。恢复产品实现后 lifecycle / manual-check / recovery / safety 四个专项文件 103/103 通过。
- 单 worker 完整 Web 验证：`corepack pnpm --filter web exec vitest run --maxWorkers=1 --minWorkers=1`，66 文件、929/929，通过（122.87s，0 skip）。Web strict 与 lint 通过；strict 首次识别 accepted 回执的 nullable 窄化问题后，明确要求 durable 和 accepted gate 均存在才合并，两者缺失继续使用原 durable 结果。
- `corepack pnpm --filter web build` 对应 package script（contracts → strict → Vite）通过，Vite 18.21s；保留入口 553.57 kB、ECharts 565.53 kB 的现有构建提示。环境 fallback `pnpm` 首次触发自动安装并因 no TTY 中止，未改依赖；使用同一 bundled pnpm CLI 重新执行成功。
- 在独立的 `127.0.0.1:5191` fixture，通过 bundled Playwright 的真实 `msedge` 浏览器运行正式 Router、IdentityStore、CatalogPage、HttpClient 和 Zod。两个同 identity / scope 的标签同时点击确认，最终 POST 仅 1 次，两个标签均显示同一任务编号；浏览器 `isSecureContext`、`navigator.locks.request` 和原生 `Storage.prototype.setItem` 均核实存在。
- 两域均填满真实 localStorage 与 sessionStorage 配额，触发原生 `QuotaExceededError`，有效 ACK 的任务 ID 在两处均未落盘；保留无 ID 的原预约。释放测试填充后，仅做同身份重验证，仍显示原任务并继续 GET，POST 保持 1 次。
- 终态任务的旧 A 目录 GET 被延迟，切换 A→ 异常 B→A，同时让当前读取失败；旧响应返回后，原两个持久化门禁完全不变，新检查仍禁用。独立浏览器 JSON、五张截图和脚本保存在 `artifacts/pr-216-verification/`，最终无 page error。网络和 WS 为合成 fixture，这些证据仅证明真实浏览器 storage / Web Locks 与前端行为，不是原生 Neo API / PostgreSQL / Redis 验收。
- 本轮只修改两处目录产品代码、保留新增 oracle 并补充本 runbook，不涉及 API URL、数据库迁移、Legacy 行为或生产切换。历史 review 的三项已提交修复继续由本轮 103 项专项和全量 Web 覆盖；最新提交的 CI 与 review 状态须在推送后独立记录。

2026-10-10，`eb3a7e2ddc22ca176f60af0295b9c0594513dcfd` 远端检查与跨版本阻塞复核：

- 精确 head 的 [CI 38040662275](https://github.com/Cabal14256/Amazon-ASIN-monitor-Neo/actions/runs/38040662275)、[Integration 38040662304](https://github.com/Cabal14256/Amazon-ASIN-monitor-Neo/actions/runs/38040662304) 和最新 [Policy 38041883195](https://github.com/Cabal14256/Amazon-ASIN-monitor-Neo/actions/runs/38041883195) 均成功。2026-10-10T09:40:58Z 的 Codex Review 覆盖同一 head，但新增 P1 4237204983 尚未解决；成功检查不代表可转 Ready 或合并。
- 原 `197925d` 的 parser 只接受 inspection / refresh。inspection 忽略附加 check 字段；原 reconcileCreate 在同一 Web Lock 内成功 GET 后以 parser 返回值做比较，再调用原 setSafety(null, safety) / writer.removeItem。refresh 路径也会在 GET 后清除，或转为 inspection 后清除；未知 phase 则被旧 parser 删除。仅改存储 shape 无法形成旧客户端可读且不可由旧恢复清除的记录。
- 原 index / parser、新版 writer 与四个原闭包的完整来源、SHA 和 TypeScript 签名擦除清单保全于忽略目录 `artifacts/pr-216-verification/mixed-version-original-reconcile/`。独立 oracle 执行原 setSafety / runWithCatalogLock / reconcileCreate / beginWrite，两域均保留独立任务回执并固定 processing，仅注入成功目录 GET、内存 Storage / Web Lock / query ports；它不冒称真实 HTTP、浏览器或原生数据库。实际运行 `node artifacts/pr-216-verification/mixed-version-original-reconcile/original-reconcile-oracle.mjs`，exit 1、2 fail / 0 pass：两域各一次目录 GET 后共享 key 为 null，独立回执原值不变，原 beginWrite 准入 CRUD。`original-reconcile-red.log` 与 `source-manifest.json` 保留原失败；本轮没有产品修复，不能称 GREEN。
- 29 项原 lifecycle oracle 的 SHA256 仍为 `1B747787215D5474756E5F3F011B0C8898CE25B9B340C842E6D961E75BF8624A`，未修改原断言或期限。本轮只增补阻塞记录，不复跑已通过的 929 项 Web 结果。
- 正式 `origin/main` 为 `3df5a2a`，尚无 `ApplicationCatalogOperations` / `PgCatalogOperationRepository` / `0017_catalog_operation_fence`。#229 的 `74ba4ad` 已有这些代码与独立真实 Integration 证据：API 按同 owner / domain 保留 PG slot，认证 check 在 Redis EVAL 前绑定原任务；实际事务持 pin 至物理 COMMIT / ROLLBACK，无法由浏览器 key、任务 TTL、metadata terminal 或 queue 缺失解除。#211 是批量删除 Web；#188 的 group admission 为单 Worker 进程内执行并发；#222 为定时不可变集合 / 收据，均不能替代 #224 的后端写保护。
- 解除阻塞须在 #229 正式合入后普通同步 `main`，保持本 PR target 为 `main`，不合并 feature branch 作为 PR base；原旧恢复 oracle 须继续保留其前端清除事实，并由实际 API / PG / Redis / 编译 Worker 验证同 owner / domain 的旧 CRUD / 检查仍返回 409、无第二业务动作。未知 ACK、pending / uncertain pin、active cancellation、旧代次与任务 metadata 过期保持 fail closed。anonymous-check、其他 owner 和内部 scheduled-system 不在该 owner fence 范围内，不宣称全局互斥。

## 人工验收

1. 仅具有 `asin:read` 的有效账号勾选主营多组，调整强制刷新并确认；检查只发送一次批量 POST，显示任务编号与任务中心入口。取消、切页或筛选后不使用旧选择。
2. 同权限账号在竞品详情分别检查单组、单 ASIN；确认目标名称和原始 ID 正确，不出现竞品批量按钮。
3. 在提交前撤销读权限、更换账号/会话或触发强制改密；旧目标和确认应消失，排队请求不提交。提交后断网、重载、另开新版标签，重复检查和 CRUD 应被恢复门禁阻止；旧 bundle 人工恢复后的实际拒绝须在 #224 正式主线后端上另验。
4. 完成、失败、取消任务后模拟目录读取失败，门禁应保留；恢复读取并核实后解除。processing、任务身份不一致或被另一标签替换的记录不能解锁。

## 回滚

回滚此任务提交可撤回新按钮和 typed transport，不涉及数据迁移。新旧 bundle 混用不能依赖浏览器 inspection 门禁保证安全；在 #224 持久后端保护正式部署前，不启用本轮新功能。后端保护部署及回滚须停止相关 Neo 生产者 / 消费者，核验原任务和物理事务并保留未知代次，按 #224 升级 / 回滚门禁执行；不得以删除 localStorage 或成功 GET 目录作为业务停止证明。生产切换仍按总体迁移方案另行执行。
