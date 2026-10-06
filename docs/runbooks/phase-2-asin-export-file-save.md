# ASIN XLSX：浏览器文件流保存

关联 Issue #166 / PR #172，处理评论 4200387938。任务中心列表和真实任务详情都使用原任务已验证的 artifact、文件名及精确大小。需要当前 owner/session、`asin:read` 和已完成密码策略；API 仍负责当前身份及文件真实性复核。

## 保存方式

支持 File System Access 的安全上下文中，点击下载立即在用户 gesture 内调用 `showSaveFilePicker`，在任何 await 或 GET 前取得原生保存对话框。随后创建临时 writable，认证 GET 每读取一块就等待该块写盘，再读取下一块；消费者只持有一个最多 8 MiB 的数据块和 4 字节 ZIP 前缀，不累计整份 XLSX，也不创建 Blob URL。

流传输保持 30 分钟截止和 256 MiB artifact 上限，MIME、Content-Length（如有）、ZIP 开头及实际总字节数必须与原回执一致。实际大小恰好匹配后才等待最终 `close()` 完成；等待 close 时页面仍显示正在下载。Cookie、Legacy Bearer 和请求/下载 URL `/api` 去重沿用同一 HttpClient。

没有该浏览器能力时，仅允许不超过 **32 MiB** 的 Blob 回退，实际读取上限进一步缩小到原回执字节数。更大文件在 GET 前提示使用支持选择保存位置的 Chrome/Edge、HTTPS 或本机可信地址，或缩小导出范围重新生成；没有提高原 Blob 限额。其他任务 JSON 下载保留原 125 秒默认。

用户取消原生对话框、主动取消下载、撤权、改密要求、owner/session 或同 owner 会话 revision 改变、离开页面时，不发起迟到 GET，不显示业务失败，不关闭未完成文件。超时、网络、磁盘或完整性错误中止临时文件并呈现错误。磁盘若不响应 abort，页面的失败结果仍按截止返回；底层工作在真正结束前继续占用 HTTP 有界名额。`close()` 已完成的磁盘提交不能由后续 UI 取消撤销。

## 本轮实际验证

- 新增 4 个实际 TaskCenter/FSA 场景先 RED，接线后 GREEN；真实任务列表和内部 TaskDetails 组件完整 mounted 文件 24/24 通过。
- TaskApi 与新增流测试两个文件共 64/64 通过，使用真实 HttpClient、ReadableStream 和可控磁盘端口。覆盖背压、慢传超过 125 秒、30 分钟截止、最终 close/abort 不响应、跨 JS realm 字节块、大小/MIME/ZIP 矛盾、401/403/404、晚 writable、当前身份变化及更小 Blob cap。
- 256 MiB 验证由同一个 8 MiB 数据块生成 32 次并写入不保留块的计数端口；没有分配整个文件或 Blob。它验证客户端大小边界与写入顺序，不是可打开的真实 256 MiB Excel 工作簿。
- `corepack pnpm --filter @asin-monitor/web test --maxWorkers=1 --no-file-parallelism`：62 文件、846 项全部通过；Web lint、Web typecheck 和根 `tsc --noEmit --pretty false` 通过。
- `corepack pnpm --filter @asin-monitor/web build` 通过，保留既有主包/ECharts 超过 500 kB 的构建提示；Legacy `npm run build` 通过。根 `test:contracts` 43 项、Legacy server `test:unit` 55 项、`test:changed-format` 5 项通过；8 个本轮文件的 Prettier 检查及 `git diff --check` 通过。
- 真实浏览器 File System Access、真实磁盘原文件取消语义及大 XLSX 生产传输尚未执行；现有浏览器链路之前连接失败，mounted/流端口不能当作本轮浏览器证据。最新 CI 和 Review 仍由 PR 门禁核验。

浏览器能力依据 [Chrome File System Access 文档](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access) 和 [MDN createWritable 文档](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable)。正式验收需复核用户激活、可信上下文、原生取消、实际磁盘背压与临时文件、完整 Excel 可打开性以及撤权中断。

## 回滚

可回滚本轮 Web 文件保存提交；保留 API/Worker 导出、Date 单元格与两种 Legacy layout 的其他修复。回滚不删除或恢复已经生成的 artifact，也不改变生产切换与 Legacy 退役门禁。
