# P3：批量删除与导入恢复复审

关联 Issue #211 / PR #215。2026-10-07 修复评论 4200217544、4200217550、4200217557 的三个 UI P2；2026-10-09 继续补齐真实身份重验下的已知删除回执。旧客户端能够人工解除本地桥的两个 P1 继续阻塞合并，须等待 Issue #224 / PR #229 的持久服务端排他能力正式合入 main。本地 parser 兼容不等于服务端并发排他。

## 本轮行为

- 双锁内写入旧 import 桥后，如较大的 catalog envelope 因配额失败且尚未派发任何 POST，精确回滚原桥与 session receipt。回滚被存储拒绝时，同一 owner/domain 的 session-only receipt 保留原 operation、ownerScope、原始 IDs 和提交时间；重新挂载可显示恢复面板，先 GET 核实再解除，不重发删除。不会清除替换的操作回执。
- 导入人工核实在两个锁内等待真实目录 GET 成功，之后再次验证 owner、session revision、operation 和三份原始保护记录才清理。真实目录页面提供当前 filter/status/pageSize/current 查询及 generation 的刷新回调；独立 ImportPanel 使用一次有界 typed GET，并丢弃旧目录缓存。GET 失败、查询改变、session 改变或清理失败时，刷新或新标签页仍保留原保护。完成任务也先持久化 settled 再真实读取目录，成功才清除；失败/取消仍需人工核实。
- 删除终态核实在 GET 前捕获查询 generation，在每个 await 后复核。A→B 或 A→B→A 均不能由 A 的旧 GET 清除当前保护；原结果不写入 B 的缓存，页面保留 GET-only 重读入口。

## 实际验证与剩余门禁

- 主营/竞品真实 CatalogPage + ImportPanel + typed HTTP transport：三类场景共 6 项先 RED、修复后 GREEN。额外覆盖两域 session-only 未发送 claim 在桥回滚失败后恢复原回执且不派发 POST。
- 单 worker 四个受影响 focused 文件 113/113 通过。原有两项测试改为断言清理 session 失败时持久保护仍保留，而不是先移除持久保护；独立 panel 端口增加正确的真实目录响应形状，GET 不伪装成提交 ACK。
- 2026-10-07 该阶段完整 Web/build 尚未执行：当时按重型窗口协调仅跑 focused 与严格类型、文件 ESLint、Prettier/diff。测试使用 mounted 组件与网络端口，实际浏览器未执行；后续最终本地结果见下文。
- PR 保持 Draft，相关 Review Thread 不提前解决；#224 服务端 P1、全量验收、最新 CI 与复审仍是正式合并条件。

回滚本轮 UI 提交会恢复三个已知问题，不能作为消除旧客户端并发写入的方案；没有数据库变化或生产切换。

## 2026-10-09：真实身份重验与已知 ACK

原生产基线 `2e2f4de` 固定到六个 source blob/SHA：2 个健康存储对照先通过，8 个合法 ACK 加双回执存储更新失败的场景先 RED，失败均在同身份验证恢复后找不到原任务 ID，前置 schema、实际 ACK、权限、session/revision 断言已通过。重挂载时 CatalogPage 与批删 hook 都会用持久旧 unknown 覆盖 runtime 已知 ACK；ACK 在 loading 期间返回时，mounted 判断还会丢弃内存回执。初次修复又通过真实 peer 竞争和持续配额故障复现了提前旧任务 GET、operationId-only 迟到发布和恢复失败回退 unknown 的缺口，保留失败记录并补齐保护。

最终仅在原 owner/domain/session/revision 保存合法任务 ACK。原 unknown 与 known 的 operation、ordered IDs、提交时刻、ownerScope 全部匹配且无未知字段才保留已知回执；peer 替换或更完整任务状态优先。目录水合完成后才 GET 任务，身份待验证或 error 不展示旧数据。任务面板在身份验证与目录水合后可自动 GET 原任务状态。锁内显式恢复补保存失败时保留已知 ID，本次恢复不额外发送任务 GET；存储修复后继续 GET-only 核实，不重发 POST。切换真实身份/session/revision 后旧内存回执退休，回到原身份也不复活。

- 新页面测试 54/54，通过原 10 项、36 项 peer 绑定/时序、6 项身份退休、2 项持续存储故障的业务断言。
- catalog 与 asin 16 个完整文件 313/313；Web strict、完整 Web lint（零警告）、Prettier/diff 均通过，Vitest 使用单 worker、关闭文件并行，`NODE_OPTIONS=--max-old-space-size=1536`。
- 原 RED、初次类型窄化错误、修复中 peer/配额 RED 与所有重跑结果均保存在本机 `%TEMP%/neo-211-verification`，未删失败记录。六份原 source hash、逐条结果/日志 SHA 和最终 source hash 均可复核。
- 该阶段没有连接真实数据库/API/Worker，未做浏览器 gate、完整 Web/build、18 项仓库基线或最新远端 CI/Review。两个依赖 #229 正式 main 的 P1 保持阻塞；本轮补丁不能据此标为 Ready 或解决这两个线程。

## 2026-10-09：字面 ID 与破坏性确认表示

正式 main 已通过 #223 / #212 接受 Neo 字面 ID，但 UI guard 与 typed service 仍有旧 trim 拒绝政策，并遗漏 C1 与未配对 surrogate。保全原 12 文件、旧 service 和 mounted padded 反向用例后，新真实 IdentityStore/RouteGate/typed fetch 测试原源 16/28 RED、12 健康对照通过。合法 padded/NBSP/非空纯空白请求被拒绝，非法 C1/surrogate 则到达 transport。修复只复用 main 的 isNeoBatchDeleteId 与 Neo request schema，不修改 Legacy、contracts 或 URL merge。原两域 padded 拒绝 case 更新为区分 padded 和 trimmed 邻居并逐字提交，负例改为控制字符；原 case 数量与其余边界保留。

随后新增 6 条真实挂载确认用例，覆盖两域 padded/trimmed 邻居、连续/纯空白、quote/backslash/Unicode。首次运行是 4 条产品表示失败和 2 条测试库 accessible-name 空白归一化错误；保留记录，只将新增 case 的选择证明改为校验实际 aria-label 后，6 条均在确认 LI 原样无引号的表示断言 RED，原 28 条仍通过。确认 LI 改为与回执相同的 JSON.stringify 表示并保留连续空白。旧 28 条 helper 只更新确认 textContent 的显示表示，原始 HTTP payload、身份、回执和业务控制不变。

最终串行验证，原生产基线仍为 main `3df5a2a` 的正常合并 HEAD `2e2f4de`，未提交 patch：

- 字面 ID / 确认 34 项通过；相关 18 文件 362 项通过，已包含上述 34、原身份 54 与 typed service 15，不重复计数。
- 完整 Web 1038 项 / 69 文件 / 零跳过；Web typecheck（含 contracts build）、完整 lint（零警告）、生产 build、URL 回归 3 项均通过。保留 Vite 大 chunk 提示。
- 每次检查的源码前后 SHA 相同。最终文档在运行检查后更新，由最终格式与 diff 检查覆盖；原运行源码、测试、失败/成功日志和逐条 SHA 存于本机两个 neo-211 验证目录。
- 实际浏览器、真实 PostgreSQL/Redis/API/Worker、完整仓库基线及最新发布 head 的 CI/Review 未执行。测试库 textContent、class 标记与编译 CSS 仅证明对应边界，不能当浏览器验收。两个上游 P1 仍等 #229 正式 main，PR 保持 Draft。
