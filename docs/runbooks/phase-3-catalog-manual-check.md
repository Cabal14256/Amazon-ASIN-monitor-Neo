# Neo 目录手动检查验收（Issue #214）

本任务增补主营所选变体组批量检查、竞品单组和单 ASIN 检查。主营已上线的单项入口保留；两类目录沿用 Legacy 和 Neo API 的 `asin:read` 权限，不增加写权限要求。

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
- 提交前写入 `neo:catalog-check:<domain>:<owner>`，兼容原主营单项记录；同时记录同 owner / domain 的 `neo:catalog-write-safety`，使用该共享 Web Lock。目录 CRUD、单项检查与批量检查在一个目录范围内互斥；后续批量删除应复用该门禁和同一多选状态。
- 网络断开、超时、取消、非法 ACK 与服务端 500 unknown 回执均保留提交时间和目标。已取得任务 ID 时恢复任务查询；无 ID 时引导按时间和目标到任务中心核实。重载页面不会解除防重。损坏的异步恢复记录阻止新提交。
- pending / processing 任务不能解锁。终态任务先重读当前目录和已打开详情，成功后按 operationId / taskId 清除原记录；重读失败、身份变化或另一标签替换记录时继续保留门禁。无 ID 或已过保留期的任务必须人工确认原任务不会继续执行，再成功重读目录。

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

## 人工验收

1. 仅具有 `asin:read` 的有效账号勾选主营多组，调整强制刷新并确认；检查只发送一次批量 POST，显示任务编号与任务中心入口。取消、切页或筛选后不使用旧选择。
2. 同权限账号在竞品详情分别检查单组、单 ASIN；确认目标名称和原始 ID 正确，不出现竞品批量按钮。
3. 在提交前撤销读权限、更换账号/会话或触发强制改密；旧目标和确认应消失，排队请求不提交。提交后断网、重载、另开标签，重复检查和 CRUD 均应被同 owner / domain 的恢复门禁阻止。
4. 完成、失败、取消任务后模拟目录读取失败，门禁应保留；恢复读取并核实后解除。processing、任务身份不一致或被另一标签替换的记录不能解锁。

## 回滚

回滚此任务提交可撤回新按钮和 typed transport，不涉及数据迁移。回滚前先确认所有在途批量/竞品检查任务，并保留或人工核实浏览器恢复记录；旧版本仅理解旧主营单项记录，不能承担新共享异步门禁的恢复。生产切换仍按总体迁移方案另行执行。
