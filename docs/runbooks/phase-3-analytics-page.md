# P3：Neo 数据分析工作台

关联 Issue #157。Neo `/analytics` 将 monitor analytics 的 14 个统计接口组织为趋势总览、ASIN 与周期、高峰与时长三个视图；Legacy 分析页面和接口继续保留。

## 使用范围与权限

- 页面路由要求当前会话具有 `analytics:read`。
- 趋势时间以 `Asia/Shanghai` 显示和提交；默认范围为最近 30 天。
- 国家、时间范围和分组粒度在用户点击查询后生效。一次查询最多跨 12 个自然月。国家筛选包含合并欧洲（EU），覆盖 UK/DE/FR/IT/ES；高峰标记区域在 EU 筛选时返回 UK 和 EU_OTHER 两组。高峰时段接口要求指定国家；选择全部国家时仅该接口以 US 为默认站点，月度拆分和异常时长统计仍查询全部国家。
- 指定国家后，顶部指标使用该国家且 `checkType=ASIN` 的根统计；根统计只提供监控 ASIN 数，页面不将其误标为受影响 ASIN。全球汇总有独立去重异常 ASIN 数时才显示受影响 ASIN。全球国家分布、全球时长摘要和全球区域摘要始终按全部国家统计，仅随时间范围变化。区域表的异常率取全时段异常时长占比，ASIN 平均异常率与全时段异常率均不是监控覆盖率。
- 周期摘要支持单独按站点和品牌筛选，并按所选粒度分页加载，每页 20 组；点击某条摘要的“查看明细”后再以该行国家、站点、品牌和相同粒度读取时间槽。明细在客户端每页展示 50 个时间槽，可翻页查看全部返回行；切换页码或筛选范围后需重新选行。
- 异常时长曲线先合并同一时间槽的全部 ASIN 时长，再显示最近 14 个时间槽。月度拆分先限制在所选日期范围内，再显示最近 14 天。高峰标记区域展示最近 8 个区段的起止时间，调整时间范围可查看更早区段。
- 高峰标记区域只对小时粒度有意义。月度拆分请求所选范围相交的每个自然月并按日期裁剪。异常时长曲线由 API 按时间范围自动选择粒度，与趋势粒度筛选独立。
- 查询响应受 32 MiB 页面边界和 API 结果大小限制。图表仅展示最近 14 个时间槽；周期明细分页可查看完整返回行，完整统计仍由服务端完成。

## 接口与容量

- 视图涵盖 `/monitor-history/statistics`、by-time、by-country、by-variant-group、peak-hours、analytics-monthly-breakdown、peak-mark-areas、all-countries-summary、region-summary、period-summary、period-summary/details、asin-by-country、asin-by-variant-group，以及 `/monitor-history/abnormal-duration-statistics`。
- API 每个进程同时接纳两个分析请求。Web service 对分析请求使用 FIFO 双并发队列，等待中的 React Query 请求在筛选变化或页面卸载时可取消。
- 普通分析接口要求 `analytics:read`；根统计、高峰时段和异常时长端点兼容 `monitor:read` 或 `analytics:read`。所有接口在读取/缓存前重新核验当前会话权限。
- `Cache-Control: no-store` 约束 HTTP 缓存；服务端可通过 Neo 分析 Redis 缓存和 Timescale 聚合提供结果。

## 排障

- 403：确认用户当前角色具有 `analytics:read`；不要依赖页面导航隐藏来判断 API 权限。
- 413 或页面响应过大：缩短时间范围，服务端不会返回截断的部分统计。
- 429：页面 service 会排队控制本地并发；持续出现时检查同 API 进程的其他分析请求和服务端 admission 指标。
- 503：当前 PostgreSQL 权威鉴权数据源尚未启用时，Neo 分析 API 会拒绝服务；生产切换依照 Issue #48 阶段门执行。
- 数据与 Legacy 不一致时，先用同一国家、上海本地时间范围、分组和过滤条件对照；不要在该页面问题中更改生产数据或切换流量。

## 验证与回滚

- Web transport 测试覆盖 14 个 endpoint 映射、Zod 响应校验、重复 `/api` 归一化、数组参数编码和双并发上限；数据测试覆盖上海时间、EU 国家筛选、ASIN 检查类型、监控与受影响 ASIN 区别、周期筛选与明细翻页、时间槽合并及跨月范围裁剪。
- Web 页面通过路由授权和导航测试；API monitor analytics 单测覆盖 14 个 HTTP route、当前权限和响应契约。
- 回滚 Neo 前端路由、service 与 API 授权映射即可；本功能不修改数据库 schema、聚合定义、Legacy 代码或生产代理流量。
