# P3：Neo 数据分析工作台

关联 Issue #157。Neo `/analytics` 将 monitor analytics 的 14 个统计接口组织为趋势总览、ASIN 与周期、高峰与时长三个视图；Legacy 分析页面和接口继续保留。

## 使用范围与权限

- 页面路由与页面内部均要求已验证当前会话具有 `analytics:read`，并已完成强制密码修改。权限消失、验证状态变化时隐藏统计并取消活跃及排队请求。每个 React Query key 包含用户 ID 和 session ID，切换用户或会话会卸载旧图表，防止缓存及延迟响应跨会话显示。
- 趋势时间以 `Asia/Shanghai` 显示和提交；默认范围为最近 30 天。
- 国家、时间范围和分组粒度在用户点击查询后生效。一次查询最多跨 12 个自然月。国家筛选包含合并欧洲（EU），覆盖 UK/DE/FR/IT/ES；高峰标记区域在 EU 筛选时返回 UK 和 EU_OTHER 两组。高峰时段接口要求指定国家；选择全部国家时仅该接口以 US 为默认站点，月度拆分和异常时长统计仍查询全部国家。
- 指定国家后，顶部指标使用该国家且 `checkType=ASIN` 的根统计；根统计只提供监控 ASIN 数，页面不将其误标为受影响 ASIN。全球汇总有独立去重异常 ASIN 数时才显示受影响 ASIN。全球国家分布、全球时长摘要和全球区域摘要始终按全部国家统计。两个时长摘要各自提供独立的小时/天粒度选择，默认小时，不受页面趋势粒度影响。区域表的异常率取全时段异常时长占比，ASIN 平均异常率与全时段异常率均不是监控覆盖率。
- 周期摘要支持单独按站点和品牌筛选，并以独立的小时/天粒度分页加载，默认小时、不随趋势粒度改变；每页 20 组。点击某条摘要的“查看明细”后再以该行国家、站点、品牌和相同周期粒度读取时间槽。明细在客户端每页展示 50 个时间槽，可翻页查看全部返回行；切换页码、粒度或筛选范围后需重新选行。
- 拥有 `monitor:read` 时，ASIN 变体组排名和检查排行中的分组名称可打开该组的监控历史；仅有 `analytics:read` 时只显示文字。检查排行和时长排名展示接口返回的全部前 50 组。异常时长曲线先合并同一时间槽的全部 ASIN 时长，再完整展示返回的时间槽；异常 ASIN 摘要每页展示 50 行，可翻页查看全部返回行。月度拆分先限制在所选日期范围内，再完整展示。高峰时段明细每页展示 50 个区段，可翻页查看全部区段。
- 趋势、月度拆分、异常时长和排名使用按需加载的 NeoChart / ECharts。趋势缩放初始包含完整时间范围，排名缩放保留全部源数据；各图表独立切换时长（小时）或百分比，分页明细可读取全部精确数据。国家柱状图使用该国异常与正常时长堆叠，百分比分母为该国返回的正常加异常时长（与 Legacy 一致，避免独立四舍五入导致堆叠超过 100%）；国家饼图使用各国异常时长，百分比分母为当前筛选返回的全部国家异常时长之和。趋势与排行保留 API 在小时四舍五入前计算的 `ratioAllTime`，时长之间只允许四位小时精度的 0.0002 h 加浮点容差；明显矛盾或非法占比会局部显示图表错误。国家图表使用 `asin-by-country` 的实际时长，不将检查数量当作时长。所有异常值为零时饼图不绘制虚构等分扇区；柱状图颜色读取 Neo 正常/异常 CSS tokens。
- 高峰标记区域只对小时粒度有意义，趋势中可独立开关美国、英国、欧洲其他站点的背景区域；日/周/月聚合不会叠加分钟高峰，避免将整槽误标为高峰。时间轴把上海墙上时间显式转换为 `+08:00` instant，刻度按上海显示，高峰边界直接使用分钟时间戳并裁剪到绘制范围，稀疏小时数据不会延伸到下一个日期标签；高峰查询失败只显示该查询的错误，趋势仍可读取。月度拆分请求所选范围相交的每个自然月，首尾月传入相交的完整时间戳；默认与重置范围同样规范化为上海 SQL 时间。最多启动两个并发月份 worker，任一月失败立即取消兄弟请求，剩余月份不会提交到共享 REST 队列，随后按日期裁剪显示。异常时长曲线由 API 按时间范围自动选择粒度，与趋势粒度筛选独立。
- 查询响应受 32 MiB 页面边界和 API 结果大小限制。图表、周期明细与异常 ASIN 摘要保留完整返回行；完整统计仍由服务端完成。

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
- 新增 16 个 mounted 页面回归通过真实 HttpClient、REST Zod 契约和 React Query 驱动，覆盖完整趋势、国家柱饼/排名单位切换、权限门禁、权限撤回取消、owner/session 隔离、403 局部重试、跨月失败取消及首尾时间戳、高峰开关与全部区段翻页。此类测试只替换图表 init，保留 NeoChart 生命周期与最终 ECharts 配置。另有真实 ECharts SSR 回归，直接注册按需组件、绘出含高峰独有 fill 的 SVG，执行 dataZoom action，并绘制国家堆叠柱、饼图与全部 50 个排行源行；不替换真实引擎。图表数据回归覆盖 5000 时间槽、全部排名、百分比分母、四位小时舍入、非法占比、真实零值和稀疏小时的分钟高峰边界。新图表使用 ECharts 6.1 `outerBoundsMode/outerBoundsContain` 处理标签和坐标轴名称。
- 当前浏览器工具链不可用：同轮前端验收中 Codex IAB 附加超时，Edge/browser 网络请求失败。本分析页尚未执行实际浏览器验收；历史截图不是本轮证据，mounted 组件与 SSR 验证不能替代实际布局、缩放手感和视觉验收。
- 2026-10-07 实际执行：`corepack pnpm install --frozen-lockfile` 通过，root lock 未修改；内存恢复后采用 `NODE_OPTIONS=--max-old-space-size=1536` 和串行单 worker，`corepack pnpm --filter web test --maxWorkers=1 --no-file-parallelism` 为 827/827、64 文件通过、零 skipped（97.03 s）。`corepack pnpm --filter web exec tsc -p tsconfig.json --noEmit --pretty false`、`corepack pnpm --filter web lint`（零 warnings）、`corepack pnpm --filter web build` 通过。Vite 构建 14.31 s，入口 550.45 kB、按需 ECharts 611.27 kB，仍有大于 500 kB 的体积警告，未以此宣称性能出口 gate 已达标。
- `corepack pnpm --filter contracts test --maxWorkers=1 --no-file-parallelism` 为 168/168、14 文件通过；`corepack pnpm test:contracts` 为 40 项通过（含普通请求/导出/下载 URL 一致性 3 项）；`corepack pnpm exec tsc --noEmit --pretty false` 通过。完整 Web 套件同时覆盖重复 `/api` 前缀与 gateway base URL；新增 mounted 图表路径覆盖 `/api/`、`https://app.test/gateway/api/`。
- `npm run test:changed-format` 为 5/5 通过；另外显式执行仓库 Prettier `--check` 覆盖本次接续的全部 14 个文件，并执行 `git diff --check` 与 `git diff --cached --check`，均通过。
- 本次图表接续未重复 `npm --prefix server run test:unit`、`npm run build`、`corepack pnpm --filter config test`、`corepack pnpm --filter db test`、`corepack pnpm --filter api test`、`corepack pnpm --filter worker test`、`corepack pnpm build:api`、`corepack pnpm build:worker`、`corepack pnpm build:db`：接续修改仅为 Web/说明文档，未修改这些源模块；API 原 PR 的权限映射和 EU 峰区修复仍保留，完整 PR CI 与集成验证在最终合并前必须通过。
- Excel/CSV 导出等待 Issue #174 的 Neo 导出任务服务接入，PR #158 的对应 Review Thread 尚不能视为解决。
- 回滚 Neo 前端路由、service 与 API 授权映射即可；本功能不修改数据库 schema、聚合定义、Legacy 代码或生产代理流量。
