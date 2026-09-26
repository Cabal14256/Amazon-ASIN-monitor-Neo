# Neo ASIN 父体查询

## 关联 Issue

Issue #153。

## 范围

Neo `/asin-parent-query` 接入已迁移的 `POST /api/v1/variant-check/batch-query-parent-asin`，支持 ASIN 批量输入、国家选择、同步/异步任务结果、任务进度与取消、结果展示和 CSV 下载。查询使用现有任务 WebSocket/轮询边界，结果仍受 32 MiB HTTP 读取限制。

导出暂使用浏览器生成 UTF-8 CSV；Neo `POST /tasks/export` 与导出 Worker 尚未迁移，不在本批伪造一个不可用的导出入口。CSV 单元格会转义引号并阻止外部文本被表格软件当作公式执行。

## 回滚

回滚本 PR 会恢复 `/asin-parent-query` 占位页和隐藏导航，不涉及数据库、Legacy API、生产代理或生产数据。

## 验证

- `corepack pnpm --filter web test`：406 tests passed。
- `corepack pnpm --filter web typecheck`：通过。
- `corepack pnpm --filter web lint`、`corepack pnpm --filter web build`：合并前执行。

生产数据迁移、流量切换和旧前端退役不属于本批范围。
