# 主营目录 canonical ID 传输

关联 Issue：#191。记录 ID 与 Amazon ASIN 编码是不同的字段，迁移保留的数据库 ID 不应按 ASIN 编码进行大写或去空格。

## 当前边界

- API 的 `parseAsinGroupId` 与 `parseAsinWriteId` 保留原始字符串，要求去空白后非空、最多 50 个 Unicode codepoint、无 C0 控制字符或 DEL。前端对记录 ID 保持同样的空格、大小写、重音和非 ASCII 原值。
- 现有前端路由边界继续拒绝斜杠、反斜杠、问号、井号，以及完整 `.` / `..` 路径段；这不改变服务端身份匹配或数据库规则。
- `segment` 只用 `trim()` 判断空值，不用其结果替换 ID；编码始终是原值的 `encodeURIComponent`。50 个 codepoint 与 UTF-16 单元数不同：含 48 个 emoji 和首尾两个空格的 ID 是 50 个 codepoint。
- 移动表单使用列表选择得到的原始目标 ID 作比较及请求体；创建 ASIN 的 `parentId`、移动的 `targetGroupId` 原值提交。共享合同对这些请求体字段没有去空格转换。
- 搜索关键词、表单展示名、人工操作原因和 Amazon ASIN 编码的已有规范化行为保持不变；本任务只处理记录 ID。

## 覆盖的既有服务

| 主营操作 | ID 位置 |
| --- | --- |
| 变体组详情、修改、删除 | `/variant-groups/:id` |
| ASIN 创建 | JSON `parentId` |
| ASIN 修改、删除、移动 | `/asins/:id` 与 `/asins/:id/move` |
| 移动目标 | JSON `targetGroupId` |
| 组 / ASIN 飞书通知与人工状态 | 对应记录路径下的 `/feishu-notify` / `/manual-broken` |
| 组 / ASIN 即时检查 | 对应记录路径下的 `/check` |

导入是固定 `/variant-groups/import-excel` 路径，没有记录 ID 路径参数，不为本任务重复实现或新增冗余入口。主线已有 #182 即时检查服务与界面；本任务对其既有 `segment` 调用补实际 HttpClient 与原生 HTTP 回归，不新增重复业务入口。

共享持久化保护的 `detailId` 上限也按 50 个 codepoint 判断，否则合法 emoji ID 会在页面重新挂载时被当作非法记录删除。普通目录刷新失败 / 未确认写入的保护、操作身份比较及显式核验流程保持不变。控制字符 ID 仍由服务在发出详情请求之前拒绝，并保留未确认操作的保护。

## 验证方法与前置依赖

- 使用实际 HttpClient，覆盖 `/api/` 与 `https://app.test/gateway/api/` 两种 base；核对既有 11 个请求的完整编码路径、`parentId` / `targetGroupId` 和唯一 `/api` 前缀。
- 一次性 loopback HTTP 服务与原生 fetch 核对接收到的 wire URL 和 JSON，分别覆盖同源与 gateway 部署。该 fixture 验证传输字节，不替代生产业务或真实数据库验收。
- 实际 mounted 主营创建 / 移动表单核对源组、子项和目标的原始 ID；真实 CatalogPage 在两种 base 下读取 localStorage 中的 50-codepoint 保护、卸载 / 重挂载、显式 GET 核验再解锁。恶意控制字符详情 ID 在网络层之前拒绝，旧保护保留，且不重发 POST。
- 红绿证据：在同步主线后，临时恢复原 `segment` 校验，4 个合法即时检查实际 HttpClient / native HTTP 用例失败，非法输入用例通过（4 failed / 1 passed）；finally 还原新源文件后全部转绿。旧保护源码对实际页面的两个 50-codepoint 挂载用例失败（2 failed / 3 名称过滤 skipped），正确复现保护被删除和写入口提前出现；一码点边界修复后通过。过滤 skipped 不属于最终完整套件跳过。
- 先保留原六文件 stash，再正常快进到 #167 合入后的 `main` `0334ac808b1a6c31f1b9f8d0b343b58c56c553e2`；使用根锁执行 frozen offline install，退出 0。保留主线完整共享动作、检查恢复、claim / CAS、编码空格 transport 与目标快照。主线已保留移动目标原值，因此本 PR 不重复修改 `catalog-actions.tsx`。
- 最终专项 5 文件 37 passed / 0 skipped；完整 `corepack pnpm --filter web test --maxWorkers=1` 57 文件 733 passed / 0 skipped（64.53 秒）。Web lint 无警告，声明 Web typecheck（包含测试文件）与根 tsc 通过；根契约 40 项（含请求 / 导出 / 下载 URL 3 项）及格式脚本 5 项通过。最后构建、文件格式与浏览器证据记录在 PR。

## 浏览器验证边界

真实 IAB 中，隔离的 loopback HTTP fixture 使用虚构 canonical 源组、目标组和 50-codepoint 组，配合实际开发界面验证 encoded URL、原值 JSON 和持久化保护：

- 向源组添加 `B000000191`，JSON `parentId` 保留 `Gróup 主营`，详情从 1 项刷新为 2 项；将原 `Child α` 移至 `Cible 目标` 后源 / 目标各 1 项，真实详情和保存提示均核验。
- 向 50point（48 emoji 加首尾空格）组添加 `B000000192`，夹具已保存但返回不合法响应；实际 INVALID_RESPONSE 隐藏旧目录。页面重载后仍锁写，显式重读原长 ID 并核对新 ASIN，再确认后恢复写入口。
- 本地 wire 收据 `C:/Users/Admin/AppData/Local/Temp/neo-191-browser-wire.json` 验证恰好 3 次 POST（创建 / 移动 / 未确认创建各一次）、原值 JSON、encoded native 路径、长 ID 重读和无 `/api/api`；核验流程没有自动重发。
- 稳定截图：`C:/Users/Admin/.codex/visualizations/2026/10/02/01a0fcfb-30a4-7fd3-9f52-b687920a7b97/primary-canonical-move.png` 与同目录 `primary-canonical-reconcile.png`。首次 unknown-reload 截图存在首次 CSS 渲染 / 截图瞬间的狭窄显示，保留原图但不用于版式通过结论；重载保护语义另有实际操作及 wire 证据。

该夹具及其操作日志只放在本地 Temp，不提交业务假数据或二进制截图。部署子路径另由原生 HTTP 自动化验证；此验收不等同于生产数据库或全部 15 页生产浏览器验收。源码没有新增界面或样式；生产构建退出 0（Vite 7.62 秒），保留既有 548.81 kB 入口超过 500 kB 的警告，不调整阈值。验收结束后关闭浏览器并停止临时服务。

本任务不涉及 API、DB、权限、数据迁移、依赖或 Legacy 源码变化；未重跑的后台基线及其原因写在 PR `验证` 区。回滚恢复前端 `segment` 与保护 ID 长度边界，不改变数据库 ID。
