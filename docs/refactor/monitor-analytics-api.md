# 监控统计与分析 API

关联 #109；14 个读取入口在 Neo `/api/v1/monitor-history` 下提供，Legacy 入口继续保留。此文描述分支实现，部署和端点完成计数以合入记录为准。

## 权限和数据源

`statistics` 与 `statistics/peak-hours` 接受 `monitor:read` 或 `analytics:read` 中任意一个权限；`abnormal-duration-statistics` 要求 `monitor:read`；其他统计入口要求 `analytics:read`。

每次读取都在 PostgreSQL `READ COMMITTED` 事务取得共享管理锁，再检查当前账户、密码状态、会话和权限。缓存命中也执行这些检查。Neo 统计入口要求 `AUTH_DATA_AUTHORITY=postgresql`；权威源尚未切换时返回固定 503。

鉴权完成后，查询事务将数据阶段的 `search_path` 局部设为 `pg_catalog, public`，与统计表和持续聚合的发布位置一致，使聚合定义指纹不受连接默认搜索路径影响。不会放宽定义校验；鉴权锁仍保留，事务结束后恢复原搜索路径。

统计计数、时长、峰谷、分页和状态区间查询位于 `packages/db`。持续聚合只有在同一 SQL 快照内证明定义、完整覆盖和新鲜度后才使用；否则读取原始历史。`ANALYTICS_AGG_ENABLED=false` 关闭聚合读取，`ANALYTICS_STATUS_INTERVAL_ENABLED=false` 关闭状态区间读取和对应维护消费者。月度明细固定使用每日源分桶。时间规则统一为 UTC+8。

状态区间的升级、维护和回滚参见 [监控状态区间维护](monitor-status-interval-maintenance.md)。

### 摘要的 raw 数值协议（#226）

`all-countries-summary` 和 `region-summary` 的正式聚合读取按冻结 Legacy **raw** 算法生成结果。维度持续聚合保留 time/country/site/brand/ASIN 分桶；SQL 使用未舍入的浮点时长、异常比率和独立正常时长累加，只返回有界的汇总及每 ASIN 比率和。JS 复用 raw finalizer，在所有累加完成后保留四位；全局比率使用展示时长作分母，每 ASIN 平均使用其未舍入时长。同一 ASIN 跨国家去重以及不同大小写的原始键仍按 Legacy JS Map 语义处理。

ASIN 键在贡献 CTE 中仅计算一次 JS trim 等价的规范化列，再按该列分组。不能将含绑定参数的 trim 表达式分别嵌入 SELECT 与 GROUP BY：即使参数值相同，PostgreSQL 仍将不同参数编号视为不同表达式并拒绝执行。原始键仍用于桶累加排序，规范化键使用二进制排序规则，保留跨维度 trim 去重及大小写身份。

桶时长先在 SQL numeric 中得到整数毫秒，再转换浮点数除以 `3600000`，对应 Legacy 的 Date 毫秒差值。不能先转浮点秒再除以 `3600`：180 毫秒和 540 毫秒的结果分别会从 Legacy 的 `0.0001` 变成 `0` 和 `0.0002`，影响时长及后续比率。真实 oracle 分别验证两个短窗口的完整国家与区域结果，并要求实际读取 CAGG。

每个 ASIN 比率也按首次贡献顺序累加，对应 Legacy 的 Map 插入顺序。贡献行在 SQL 内编号，每个规范化键保留首次编号，最终比率和据此排序；编号不跨越响应边界。按 ASIN 名称排序会改变 binary64 累加及最终四位结果：三个小时首次出现 A、C、B，分别为 `1/128`、`2/128`、`6/15625`，Legacy 为 `0.7940`，按 A、B、C 则为 `0.7941`。真实双库 15881 检查的对照验证两种摘要及全部字段，没有排序平局依赖。

只有起止时间同时存在才裁剪桶，保留毫秒；边缘桶存在查询时间以外的检查时，不能由整个桶重建 raw 检查数和异常比率，因此在同一覆盖快照中拒绝聚合并回退原始数据。来源仍准确标记实际读取的 `agg` 或 `raw`。默认内部 `legacy-aggregate` 叶查询及周期、自适应、普通统计路径继续保持原有 MySQL DECIMAL 中间舍入协议。

旧摘要先把每个不足一小时的末桶舍入到四位：`3599 / 3600` 变成 `0.9997`。24 个 ASIN 的损失累计约 `0.000533333` 小时，展示时相差 `0.0005`；每国家四个 ASIN 相差 `0.0001`。月份正常/峰谷时长还受到异常比率和独立累加顺序影响，不能通过固定补偿修复。

回归使用实际冻结 Legacy 算法及私有 MySQL/Timescale 数据，覆盖 24 个 ASIN、hour/native day/month、毫秒边缘、拆分维度、跨国家与大小写键、正常/峰谷及全部比率/计数字段。轻量算术与接线测试不能替代真实 SQL 或 72 万行 HTTP 性能验收。修复前隔离报告已有 12 个摘要精确比较失败、24 个 P95 通过；修复后的全字段等价及原 3 倍门槛需在正式新 head 上重新验收，当前不声明通过 #218/#190。部署/回滚时清除两个摘要缓存族或等待原 TTL 过期，防止复用先前数值；生产切换及 Legacy 退役门槛不变。

隔离 SQL 夹具对完整指定窗口执行 `force => true, options => '{"buckets_per_batch":0}'` 刷新，并用生产覆盖查询确认空九月的 hour/day/month 维度投影均已刷新，再执行精确来源与完整 payload 对照。Timescale 2.29.2 默认批处理可能跳过无 chunk 空窗，留下其初始 invalidation；此调整仅用于显式可销毁测试库，不修改生产刷新策略或覆盖保护。回退失败包含原因、操作、目标与源粒度及固定测试时间范围。

## 缓存

缓存独立存放在 `${BULL_PREFIX}:neo:analytics:v1:<sha256>`，键包含完整规范化查询及数据源开关。隐式月份先解析成具体月份，避免跨月复用。不同时间范围不会共用结果；切换聚合或区间开关后也不会读取原配置的缓存。

- 沿用六个 `ANALYTICS_*_TTL_MS` 名称，单位为毫秒，默认 300000，上限 3600000；0 关闭对应缓存族。
- by-time、月度明细、全部国家、区域、周期及明细、按国家/变体组的 ASIN 时长可以缓存；其他入口每次查询。
- 只有全部国家、区域和周期汇总支持 `x-analytics-cache-bypass: 1`，且必须配置 `ANALYTICS_BENCHMARK_CACHE_BYPASS_ENABLED=true`。
- Redis 命令预算 500 毫秒，最多四个未结束的缓存命令。不可用、过期或内容校验失败时读取数据库，不返回不同查询的旧结果。
- 缓存上限 2 MiB。Redis 在同一 Lua 命令内先检查 `STRLEN` 再读取，过大内容不传回 API。缓存载荷还校验键、版本、期限、来源及完整结果契约。
- 大于缓存限制的有效结果仍完整返回。原有顶层 `meta` 字段及 `cache+raw` / `cache+agg` 来源格式保留；命中保留原生成时间。限流和超时返回固定失败响应，`busyFallback` 不伪装为成功的其他时间范围数据。

### 缓存指标

`/metrics` 的 `amazon_asin_monitor_cache_hits_total` 与 `amazon_asin_monitor_cache_misses_total` 接入实际分析缓存读取，沿用 `cache_key_prefix` 标签。通过全部载荷校验才计命中；已启用缓存的空值、过期、损坏、超限、Redis 异常、500 毫秒超时及四命令容量保护都恰好计一次未命中。写入不计访问，迟到的 Redis 结果不重复计数。未启用缓存、明确绕过缓存和鉴权拒绝均不产生缓存访问指标。

| 分析入口                             | 固定缓存族标签               |
| ------------------------------------ | ---------------------------- |
| by-time、analytics-monthly-breakdown | statisticsByTime             |
| all-countries-summary                | allCountriesSummary          |
| region-summary                       | regionSummary                |
| period-summary                       | periodSummary                |
| period-summary/details               | periodSummaryDetails         |
| asin-by-country                      | asinStatisticsByCountry      |
| asin-by-variant-group                | asinStatisticsByVariantGroup |

标签使用 Legacy 统计缓存类型名称；不包含物理 Redis 前缀/键/摘要、用户、ASIN、国家或筛选值。指标表示此 API 进程的缓存访问，不能据此推断数据库查询次数或 Worker 全局运行状态。未命中率包含依赖降级：Redis 异常、500 毫秒超时和四命令容量保护均发出固定原因码 `analytics_cache_unavailable` 的 warn；JSON 解析、结构、版本、键、来源或期限元数据无效均使用 `analytics_cache_invalid`。普通冷缓存或元数据有效的过期值不发这些降级告警；已过期但元数据无效的值仍告警。日志不包含原始缓存键、载荷或查询数据。

## 资源边界和错误

API 每进程最多同时接纳两次统计查询，在鉴权开始前占用名额，鉴权、数据读取和响应共享同一名额。即使客户端断开，也要等未结束的鉴权或数据库操作完成才释放；慢客户端 60 秒后断开。会话活跃时间仍由原鉴权流程更新，超过并发限制的请求直接返回 429，不会先等待会话写锁。数据库仓库另限制四个事务，排队获取连接也计入限额；整个查询事务 10 秒，数据语句 5 秒、锁等待 1.5 秒。

完整响应上限 32 MiB，先检查 JSON 字节数、深度和节点数，再校验契约及序列化；不会截断成功数据。日期、ID 列表、分页、源行状态和输出行数也由查询层限制。

无效参数返回 400，当前账户/会话/权限失效返回 403，结果过大返回 413，并发达到上限返回 429，超时返回 504，其他查询失败返回固定 500。返回值和日志不包含 SQL、连接字符串或原始驱动异常。响应均使用 `Cache-Control: no-store`。

## 验证与切换

本地测试覆盖全部路由、任一权限语义、缓存后的撤权、期限/载荷损坏、资源边界及固定失败响应。真实集成测试使用显式可销毁的 MySQL、PostgreSQL/Timescale 和 Redis，执行实际 Legacy 控制器、模型及视图服务，逐字段比较 14 个 HTTP 结果；另外验证锁等待后的撤权、实际 SQL 超时和 Redis 命中。

持续聚合和状态区间另有真实 SQL 差异测试，覆盖迟到历史、修正、删除、缺口、同秒切换及保留策略删块。测试数据不能代替生产数据校验或两份方案要求的规模、P95、灰度与退役门槛；这些门槛未通过前不移除 Legacy。

冻结的 Legacy 月分组 SQL 在 MySQL `ONLY_FULL_GROUP_BY` 下会报错，已有 SQL 对照及 HTTP 测试均明确断言该缺陷。仅在测试的私有 MySQL 会话中临时调整这一模式，以执行未经改写的旧 SQL 并比较月度指标，随后恢复。生产 Legacy 配置不变；Neo 使用明确的月份分组列，无需放宽 PostgreSQL 查询规则。
