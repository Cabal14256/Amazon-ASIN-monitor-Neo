# Neo 首页变体组工作台验收

关联 Issue：#228。本轮仅验收工作台查询、展示与三项恢复/边界修复；完整 Home 详情和实际浏览器门禁仍待 #242。本 PR 按仓库 Policy 使用 `Closes #228`，保持 Draft、未合并，原 Issue 继续 OPEN；只有完整验收通过后才能 Ready/merge 并触发关闭。该工作台增加 Neo 只读接口，不替换 Legacy 首页或生产数据路径。

## 行为与数据来源

- 首页保留国家状态图、异常与活动区域，新增当前变体组列表、国家/站点/品牌筛选树和目录入口。
- 组编号、站点、品牌均保留原始值。点击品牌树的空品牌发送显式 `brand=`，与省略品牌筛选不同；筛选表单留空仍表示全部品牌。带空格品牌和其邻近品牌分别匹配。只有本接口用 `URLSearchParams` 保存这一差别，统一 HTTP 与请求/导出 URL 合并实现没有改变。
- 列表每页最多 20 组，页码最多 1000、起始 offset 最多 10000。品牌页每页最多 200 个分组并读取一个 lookahead，最多 51 页；达到边界时引导缩小筛选范围。
- 七日趋势使用上海日期的实际 `GROUP` 历史记录。已知结果的异常率为 broken / (checks - unknown)；没有检查或只有 unknown 的日期为空缺。ASIN 历史不能冒充组检查，也不从当前状态生成趋势。
- API 在读取事务内重新检查当前账号、会话和 `asin:read`，只有当前 `monitor:read` 或 `analytics:read` 才读取历史；没有历史权限时趋势为 null。沿用既有读取截止时间、池容量和 512 KiB 响应上限。

## 身份与恢复

- 普通网络/500 错误可以保留同一授权范围上次成功读取的数据，并允许重试。
- 401/403 不展示旧列表或趋势。403 拒绝绑定实际 IdentityStore 已验证的 authenticated snapshot，切换筛选、缓存、国家或离开后返回页面均不能清除拒绝。
- 重试先运行真实身份验证。loading/error 状态退休页面并取消旧请求、清除旧 scope 缓存；只有新 authenticated snapshot 下成功的 fresh GET 才能重新显示数据。身份验证失败不得触发工作台 GET，旧请求不能覆盖新身份。

## 回归与证据

- 原 25 文件在正式 main `3df5a2a` 上逐字保全，初始 SHA 清单和原件位于本机 `Temp/neo-228-red-preparation`；原 7 个 mounted 调用链用例的完整字节 SHA 为 `40BADC4F2BC99F07B5A825C80B50B9263C81ADA9EA4CA7A637685ECE4DE63FD2`。
- 原源码实际运行 7 个用例：3 个产品 RED、4 个健康对照。RED 分别是空品牌未进入 GET、第 1000 页仍能继续、403 后切回成功 ALL cache 再次显示旧数据。
- 分页仍逐页执行全部 1000 次用户点击、真实 typed GET 和生产 table 中的链接检查。优化 DOM 查询后，原 home 源实际运行 1 个分页 RED 和 1 个普通分页健康对照；保留 60 秒期限、最终 role 断言和完整 1..1000 GET 序列，finally 精确恢复修后产品字节。
- 保留原 7 个用例，新增同一 verified snapshot 的真实路由卸载/恢复与缓存失效保护、身份验证失败不启动 GET、普通 500 可恢复三个对照。工作台 mounted、typed service 和趋势测试最终定向 24/24 通过；这是组件/HTTP seam 验证，不代表浏览器验收。
- 首轮修后定向检查中的另两次失败分开保留：千次 DOM 扫描耗时超过原 60 秒，以及旧体积上限测试期待不存在的 `RESPONSE_TOO_LARGE` enum。后者仅校正为既有 `INVALID_RESPONSE`、真实消息和 HTTP 200，超限 512 KiB 原字节与上限未改变；均不计产品 RED。一次误传 `pnpm test --` 启动的非定向运行已停止，不计通过。
- 已完成 Legacy 单测 55、Contracts 236、Config 41、DB 906（另 231 opt-in skip）、API 1728（另 549 opt-in skip）、Worker 250（另 41 opt-in skip）和完整 Web 875 个通过用例。Legacy、Web、API、Worker、DB build 以及 Web lint、root tsc、Contracts/DB expanded strict 均通过；本机 opt-in skip 不计原生通过。
- 保留首次 Web build 的 4 个旧 fetch mock tuple 类型诊断；仅增加 `vi.fn<typeof fetch>` 类型标注后 Web build 通过。root tsc 首次缺少 ignored Umi 生成声明，执行既有 `npm run setup` 后通过，未修改产品或锁文件。
- URL 检查包括既有 `npm run test:api-url` 的 3 个用例、Web request/export URL 与 HTTP 的 57 个用例；相对及绝对 `/api/` base 下空品牌服务用例保持单个 `/api` 前缀。`npm run test:changed-format` 的 5 个脚本用例、全部 29 变更文件的实际 Prettier check 及 `git diff --check` 通过；API expanded strict 覆盖全部生产源码、HTTP 单测、新 native 及导入 helper 后通过。全部命令、退出码、日志 SHA 和产品前后 SHA 保留于本机 `Temp/neo-228-verification`。
- 真实 PostgreSQL/Redis HTTP 隔离用例通过专用 Integration step 执行。新文件本机 `RUN_INTEGRATION_TESTS=false` 收集 5 个用例全部 skip，退出码 0；只能证明类型和收集路径，不是原生通过，未连接本机未知服务。当前尚未运行新 head 的隔离 CI。
- 实际浏览器视觉、布局与交互验收尚未执行。

## 详情读取尚未通过的门禁

- [Issue #242](https://github.com/Cabal14256/Amazon-ASIN-monitor-Neo/issues/242) 跟踪合法字面组编号进入详情时的 Neo 读取协议边界；本 Issue 不修改统一 HTTP 路径 guard 或正式 main 的详情读取协议。
- 独立实际 Home → 链接 → Router `/asin` → RouteGate → LinkedGroupPanel → typed `getVariantGroup`/HTTP 调用链共 8 个用例：普通及 padded 编号 2 个健康对照通过；纯空白、`.`、`..`、含 `/`、`?`、`#` 的合法编号 6 个详情读取 RED。列表契约、原始 URL search 和路由值均通过；详情请求在既有服务路径 guard 被拒绝。失败用例单独保留于本机 `Temp/neo-228-verification`，未混入工作台 24/24 或完整 Web 875 个 GREEN。
- 实际 RED 前使用保存的原 LinkedGroupPanel 字节，finally 恢复当前产品 SHA 并移除临时 repo 测试文件；服务及通用 HTTP 文件前后 SHA 未变。此证据不放宽原有路径保护，也不代表用户已通过浏览器或完整 Home 详情验收；完整门禁仍待 #242。

## 隔离回归与回滚

- 隔离数据库验证空品牌、原始空格品牌/邻近品牌、实际 GROUP/ASIN/unknown 七日历史、当前历史权限及撤权、非法查询。只使用明确 disposable 数据库、独立用户/角色/会话与 fixture 前缀，并清理自己创建的数据。
- 手工验证品牌筛选与目录跳转、普通分页与浏览上限、七日空缺、只读权限、403 后切换筛选和重试身份。生产切换另行验收，当前记录不能替代该门。
- 不涉及迁移或数据写入产品接口。回滚本 Issue 的 Neo 工作台注册、页面、契约与只读查询即可恢复此前首页；Legacy 路径继续保留。

## PR 粒度

原 25 个实现文件与新增验收文件同属一个首页工作台任务。新契约、数据库只读查询、API 当前授权和页面调用必须一起交付，否则页面会依赖尚不存在的接口或类型；隔离 CI 用于验证这条完整调用链。超过 15 文件和三个模块的警戒线，不能拆成相互依赖、目标不为 main 的堆叠 PR。
