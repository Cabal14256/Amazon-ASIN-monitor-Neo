# P3：竞品 CSV / XLSX 导入页面与恢复

关联 Issue #210、重构总览 #48。Neo `/competitor-asin` 增加竞品导入入口，复用主营导入的任务结算与安全门禁。只读参考提交 `59e0449` 的 domain 化思路，逐处改造当前主线；没有覆盖整份旧文件或恢复其导出入口。Legacy 页面、API、Worker、生产数据与流量保持现有阶段安排。

## 操作与接口

- 已验证的 ACTIVE 用户具有 `asin:write` 且无强制改密要求时显示入口。读取任务还要求 `asin:read`；服务端对上传与任务查询分别鉴权。撤回写权限会卸载导入组件、清除文件选择并中断在途上传或任务读取；正在等待 Web Lock 的上传也会再次检查权限与组件归属。
- 上传一个非空、最多 10 MiB 的 CSV / XLSX 文件，统一 HttpClient 提交 multipart `file` 与 `useAsync=true`。竞品端点为 `POST /api/v1/competitor/variant-groups/import-excel`；主营端点与既有 `submitAsinImport(http, file, signal)` 签名保持兼容。两者使用同一 URL 归一化层，`/api/` 基址只出现一次 `/api`。
- 竞品 CSV 模板为 UTF-8 BOM、CRLF：变体组名称、国家、品牌、ASIN、ASIN 类型、可选 ASIN 名称。竞品不要求站点列，主营模板继续保留站点。ASIN 类型填 1（主链）或 2（副评）；完整解析与行验证由既有 `packages/import` 的 competitor mode 决定。
- CSV / XLSX MIME 按扩展名规范化，不手工设置 multipart Content-Type，浏览器提供 boundary；服务端仍检查文件内容。页面不解析 XLSX、不记录文件内容到存储。
- API 返回任务编号表示受理。页面通过现有 TaskApi、轮询和 WS 失效提示读取权威任务快照；任务完成后仅刷新竞品目录。逐行成功、失败、报告下载与服务端任务取消继续在任务中心核对。

## 门禁与回执

- 主营保持原始 `neo:asin-import:<encoded owner>` local/session key 与 Web Lock 名称；竞品使用独立 `neo:competitor-import:<encoded owner>`。锁按 domain 和用户分区，两类上传能够各自处理，在途主营任务不会占用竞品锁。变体组和 ASIN 的原始迁移 ID、大小写、空格及编码规则未修改。
- `sending` 中断后恢复为 `uncertain`；网络失败、取消本地上传、无法确认的受理回复不会自动重传。HTTP 500 若携带合法 unknown 任务编号，会保留编号并只读取该任务；未携带编号时按提交时间、文件及任务中心人工核实。
- 回执落盘失败时保留当前编号，并尝试同标签页 session fallback。刷新只恢复与该 domain、该用户及原提交时间匹配的 fallback，不读取另一个导入域的编号。
- 已知任务为 pending / processing / cancelling 时不允许人工解锁；等待锁后再次检查，避免旧 UI 解锁正在执行的任务。completed 会清除该域 local/session 门禁；failed / cancelled 可能已经写入部分行，保存 settled 状态，核对后显式解锁。终态写入或 Web Lock 暂时失败时保留门禁并允许重试保存。
- 当前用户、session 或 domain 改变时创建独立组件状态，旧请求和任务观察者取消；新页面不会显示旧文件或旧任务快照。同一用户的新会话可恢复已持久化的同域任务，不自动创建第二个任务。跨标签 storage event 仅处理当前 domain 和 owner 的 local key。
- 明确 400 / 403 / 413 / 429 等拒绝可清除该域门禁；403 会刷新服务端权限。缺少本地存储或 Web Locks 时不开始上传。跨浏览器设备的重复提交仍由操作员和任务中心核实，浏览器锁不替代服务端授权与结果核对。

## 本轮验证

- frozen install：12 个 workspace、1753 个缓存包成功，根锁文件没有修改。
- 先行 focused：四个文件 56/56 通过，包括主营原有 26 项结算与存储故障回归；其后补充的等待锁撤权与无读权限场景纳入完整 Web 套件。
- 完整 Web test：60 个文件、784/784 通过、零跳过；单 worker 串行运行 131.56 秒，含主营原有 26 项与新增竞品 17 项 mounted 回归。后续只补齐 strict fixture 的默认字段与类型注解，不重复完整套件。
- 最终 Web strict/typecheck、lint（零问题）、9 个文件 Prettier check、changed-format（5/5）与 git diff --check 全部通过。完整 Web 中的 API URL 20 项及真实网络 3 项回归也通过，竞品 multipart 明确断言没有重复 `/api/api`。
- Web build 成功：3252 个模块、Vite 46.93 秒。入口 550.26 kB、ECharts chunk 565.53 kB 仍触发既有 500 kB 提示；它不是构建失败，本次不宣称已通过性能 gate。
- 新 mounted 用例使用实际 Catalog、TanStack Query、TaskApi、HttpClient 和 Zod；只替换 AppShell 布局及隔离网络响应。覆盖 multipart、XLSX MIME、双域并行锁、模板、未知回执刷新无重放、本地取消、session fallback、cancelled 后结算、owner/session 切换、权限撤回、403 与 storage event。主营既有 26 项继续覆盖终态写入失败、替换门禁与运行任务解锁保护。
- 当前 IAB / Edge 浏览器自动化链路先前返回 attach timeout / fetch failure，本轮未完成实际浏览器点击、视觉验收或截图；mounted DOM 与 transport 结果不作为真实浏览器截图或性能 gate 的替代证据。没有沿用历史截图。
- 没有修改 API / DB / Worker / config / Legacy runtime；相关全量基线留给当前 CI / Integration 统一执行，独立 Web 变更不在本地重复这些模块的重型构建。服务端竞品导入既有能力参见 `phase-2-asin-import.md`。
- 此 PR 保持 Draft，最新提交 Review、CI / Integration 与真实浏览器验收完成前不得宣称阶段 gate 完成，不切换生产。

## 回归与回滚

1. 以授权用户分别上传主营 CSV 与竞品 XLSX，确认模板列、端点、任务编号和刷新域各自正确；核对任务中心报告。
2. 上传时取消本地请求、刷新、切换用户或撤权，确认文件选择被清除、旧任务不显示、未知回执不自动重放。
3. 临时禁止 localStorage 的回执写入，确认 session fallback 恢复正确；任务 failed / cancelled 后先核对部分写入，再显式解锁。
4. 在两个标签页分别提交同域与异域，确认同域阻止重复、异域互不串门禁；存储恢复后重试保存终态。

回滚此 Web 提交可移除竞品导入入口并还原共享组件；服务器已受理任务和部分成功的行需要继续在任务中心核对，回滚前端不会撤销服务端写入。
