# P3：批量删除与导入恢复复审

关联 Issue #211 / PR #215。2026-10-07 本轮仅修复评论 4200217544、4200217550、4200217557 的三个 UI P2；旧客户端能够人工解除本地桥的两个 P1 继续阻塞合并，由 Issue #224 的持久服务端排他能力处理。本地 parser 兼容不等于服务端并发排他。

## 本轮行为

- 双锁内写入旧 import 桥后，如较大的 catalog envelope 因配额失败且尚未派发任何 POST，精确回滚原桥与 session receipt。回滚被存储拒绝时，同一 owner/domain 的 session-only receipt 保留原 operation、ownerScope、原始 IDs 和提交时间；重新挂载可显示恢复面板，先 GET 核实再解除，不重发删除。不会清除替换的操作回执。
- 导入人工核实在两个锁内等待真实目录 GET 成功，之后再次验证 owner、session revision、operation 和三份原始保护记录才清理。真实目录页面提供当前 filter/status/pageSize/current 查询及 generation 的刷新回调；独立 ImportPanel 使用一次有界 typed GET，并丢弃旧目录缓存。GET 失败、查询改变、session 改变或清理失败时，刷新或新标签页仍保留原保护。完成任务也先持久化 settled 再真实读取目录，成功才清除；失败/取消仍需人工核实。
- 删除终态核实在 GET 前捕获查询 generation，在每个 await 后复核。A→B 或 A→B→A 均不能由 A 的旧 GET 清除当前保护；原结果不写入 B 的缓存，页面保留 GET-only 重读入口。

## 实际验证与剩余门禁

- 主营/竞品真实 CatalogPage + ImportPanel + typed HTTP transport：三类场景共 6 项先 RED、修复后 GREEN。额外覆盖两域 session-only 未发送 claim 在桥回滚失败后恢复原回执且不派发 POST。
- 单 worker 四个受影响 focused 文件 113/113 通过。原有两项测试改为断言清理 session 失败时持久保护仍保留，而不是先移除持久保护；独立 panel 端口增加正确的真实目录响应形状，GET 不伪装成提交 ACK。
- 完整 Web/build 尚未执行：本轮按重型窗口协调仅跑 focused 与严格类型、文件 ESLint、Prettier/diff。测试使用 mounted 组件与网络端口，本轮实际浏览器未执行。
- PR 保持 Draft，相关 Review Thread 不提前解决；#224 服务端 P1、全量验收、最新 CI 与复审仍是正式合并条件。

回滚本轮 UI 提交会恢复三个已知问题，不能作为消除旧客户端并发写入的方案；没有数据库变化或生产切换。
