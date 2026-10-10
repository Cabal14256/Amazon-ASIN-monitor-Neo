# Neo 主营历史异常时长摘要与 CSV（#241）

`/monitor-history` 在应用 ASIN ID/代码或变体组 ID/名称及完整上海时间范围后，读取 `GET /api/v1/monitor-history/abnormal-duration-statistics`，固定 `includeSeries=0`。只展示服务端完整 `summary` 的八列，不从离散检查记录或 `data` 重算时长。竞品历史不读取此接口。

## 范围与传输

- 摘要按已应用的 ASIN ID/代码、变体组 ID/名称、ASIN 名称/类型、国家和起止时间计算。检查类型、异常状态及列表分页不参与；页面显示实际范围。未提交草稿、列表翻页和每页数量不修改摘要或 CSV 的范围。
- 摘要独立保留提交前的原始组/ASIN ID 和名称，列表原有 trim 行为继续保留。单个 ASIN 代码保留原值，多值按逗号或空白拆分。国家按既有页面规则转大写，ASIN 类型沿服务端规则 trim。
- 专用 service 用 `URLSearchParams` 发送重复 `asinIds[]` / `asinCodes[]`，避免逗号或首尾空格的字面 ID 被 CSV string 拆分。只有 abnormal API 入口适配这些键，常规 CSV string、既有数组、通用 query parser、URL 合并和数据库算法保持既有行为。请求仍走同一 HTTP 客户端及 `/api` 前缀归一化。
- 读取预算为 120 秒 / 32 MiB，响应使用已有 Neo 完整契约验证，最多接受 50,000 行；超限或畸形响应明确失败，不裁切、不回退成零、不导出旧范围数据。

## 显示与下载

- 摘要每页 20 行，在客户端访问全部返回行；CSV 导出全部已验证行。八列表仅在自身容器横向滚动，区域沿页面边缘以分隔线布局。
- CSV 保留 Legacy 八列、六国中文显示、两位小数小时、查询范围文件名，使用 UTF-8 BOM、CRLF 和 `text/csv;charset=utf-8;`。每格加引号并双写原引号，保留字段内换行；以公式字符开头的文本（含前置空白/控制字符）加单引号。下载成功或点击异常均移除临时锚点并回收 object URL。
- 401 走身份失效和路由守卫；403 与列表、统计、区间和详情共用撤权状态。恢复必须重新读取当前摘要；恢复失败继续隐藏旧数据。身份/会话变化、离页、深链接变更或应用新范围取消旧请求，迟到响应不能恢复旧摘要或下载权限。

## 验证与回滚

- 挂载回归使用真实 IdentityStore、RouteGate、QueryClient 和 typed HTTP，覆盖 27 个范围、完整分页/50,000 行 CSV、格式、撤权、会话、迟到响应、坏响应和字节上限场景。jsdom 仅补齐 `scrollTo`；竞品 fixture 包含既有必需 `parentAsin`，超限流在边界后保持打开以观测底层取消。
- Edge 隔离 HTTP fixture 在 1280×900 / 360×800 验证 21 行分页、实际 CSV 落盘、BOM/CRLF、空结果、500、畸形响应、零页面错误及零页面横向溢出。此证据不是生产账号、真实 PostgreSQL 或全阶段性能出口。
- API 原生 PostgreSQL 对照用例由 Integration CI 显式启用；本机没有 Docker，未冒充已执行数据库对照。完整命令和结果记录在 PR `验证`。
- 回滚本项 Web 和 abnormal 专用 wire 适配即可恢复先前历史页；没有数据库迁移。#233 的异步 records/statusChanges XLSX、任务下载与生产切换验收继续保留；本子项不关闭父验收或切换生产流量。
