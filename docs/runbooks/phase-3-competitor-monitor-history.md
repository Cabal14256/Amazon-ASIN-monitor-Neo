# P3：Neo 竞品监控历史

关联 Issue #143。Neo `/competitor-monitor-history` 通过受 `monitor:read` 保护的 `GET /api/v1/competitor/monitor-history` 与 `GET /api/v1/competitor/monitor-history/:id` 提供只读列表及详情。页面与主营监控历史共用列表、分页、详情、错误和响应式界面；Legacy 页面与生产入口继续保留。

## 行为与边界

- 服务器执行变体组 ID、ASIN ID、单个 ASIN、国家、检查类型、异常状态和时间筛选。竞品 ASIN 保留单个 SQL LIKE 模式，`%` 和 `_` 是通配符，最多 200 字符；不按主营历史的多值 ASIN 规则拆分。检查类型最多 20 字符。表单时间按上海墙钟发送。
- Legacy 目录的 `/competitor-monitor-history?type=group|asin&id=...` 链接会将组或 ASIN ID 写入首屏表单及查询；同一路由切换链接时更新范围，清空筛选可取消范围。
- 默认每页 10 条，可选 20/50。`total: null` 显示“总量未统计”，满页时允许查看下一页；最大偏移受 API 限制。切换筛选、页码或每页数量时收起旧详情。
- 宽屏表格与窄屏卡片展示父 ASIN、状态、检查时间、名称快照、类型、国家和通知状态；详情额外展示父 ASIN，检查结果预览最多 4000 字符。
- 列表与详情响应上限均为 64 MiB，与数据库查询预算一致。400/403/404/413/429/503、空结果、响应过大及刷新失败使用共用反馈，撤权时不显示旧缓存。
- 导出与竞品监控触发依赖后续 Neo API/Worker 任务；本页只提供历史浏览。状态区间甘特条等待独立区间 API。

## 验证与回滚

- Web 测试覆盖竞品接口的 URL 去重、单个 ASIN LIKE 参数、父 ASIN 契约、`total: null`、分页与详情标识校验、权限路由和导航；共用历史测试覆盖 Legacy 深链接、上海时间、未知状态和结果预览。执行 Web test/lint/typecheck/build 与仓库基线。
- 隔离环境联调建议检查真实竞品 PostgreSQL 数据、会话失效与撤权、宽窄屏、超大结果和跳页。若本机浏览器连接限制仍在，在 PR 中记录视觉验收未执行原因。
- 回滚此 PR 可恢复 `/competitor-monitor-history` 占位页及导航状态；不涉及数据库、Legacy 或生产代理。
