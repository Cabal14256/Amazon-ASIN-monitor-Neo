# P2：共享 SP-API 错误统计与风险指标

关联 Issue #75。`@asin-monitor/sp-api` 新增 `SpApiErrorStatistics`、`classifySpApiError` 和 `SpApiRiskController`，提供 API/Worker 共用实现。实例数据属于当前进程，不跨 Worker 汇总、不持久化；模块导入和实例构造均不启动定时器。

## 错误统计

九个类别延续 Legacy：RATE_LIMIT、AUTH_ERROR、FORBIDDEN、NOT_FOUND、INVALID_INPUT、SERVER_ERROR、NETWORK_ERROR、TIMEOUT、UNKNOWN。支持 `SpApiError` 的有限安全元数据；明确限流代码优先于普通状态，之后优先使用结构化 HTTP 状态和错误代码。Legacy 消息只取最多 4096 字符用于兜底分类，缺消息或异常 getter 不导致崩溃，也不调用任意 code 对象的 toString。

记录和快照不保存原始消息、URL、请求/响应体、ASIN 或凭据；`message` 仅为固定 `SP-API <类别>`，状态仅保留 100 ～ 599 的合法整数或三位数字字符串。相对 Legacy，明确状态不会被消息中无关数字覆盖，全部 5xx 归 SERVER_ERROR。

| 数据 | 上限与语义 |
| --- | --- |
| 全局与 US/EU 分类总数 | 固定九类，累计计数到 `Number.MAX_SAFE_INTEGER` 后饱和 |
| 每类 recentWindow | 最近 100 个时间戳 |
| 内部 timeSeries | 最近 1000 个错误事件 |
| 快照 timeSeries | 按小时/区域/类别共同过滤后最近 100 项 |
| 查询 hours | 默认 1，有限正数且最多 168 小时 |
| 快照 recent.count | 保留的最近 1000 条中匹配时间窗口及过滤条件的数量；不是超出保留范围的全量小时总数 |

`getErrorStats` 延续 total/recent/byType/byRegion/timeSeries 形态及 ISO 时间；补齐 Legacy 留空的 recent.byType/byRegion，修正过滤结果不一致。累计 byType/byRegion 仍分别表达全局类别总数和区域类别总数，不因 hours 改变累计值。快照是独立对象，修改返回数据不会修改内部计数。`resetStats()` 清空实例并通过项目 logger 记录固定事件。

`getErrorRate(windowSize=50)` 只保留 Legacy 的“最近错误条数 ÷ 指定窗口大小”诊断值，窗口限制 1 ～ 1000。它没有成功检查样本，不能当作监控成功率或风控输入；实际检查错误率使用下述风险实例。

## 风险指标与并发建议

`recordCheck` 只接收有限布尔标记及 0 ～ 86400 秒的响应时间，复制数值后丢弃输入对象；不保存业务标识。保留最近 100 次检查，默认以最近 50 次计算错误率；`!success || isRateLimit || isSpApiError` 视为错误。平均响应时间仅使用大于零的值，保留最近 1000 个，默认取最近 50 个。累计成功要求 success 且无两类错误标记。

| 决策 | 条件/边界 |
| --- | --- |
| 降低并发 | 错误率严格大于 0.3，或最近小时限流严格多于 5 次 |
| 提高并发 | 错误率严格小于 0.1、小时限流为零、平均响应小于 2 秒，且已有检查样本 |
| 步长 | 每次 1 |
| 并发范围 | 最小 1，默认最大 10；宿主可配置整数 1 ～ 1000 的最大值 |
| 冷却 | 实际调整后 5 分钟；到达上下限但没有变化不重置冷却 |
| 无检查记录 | 保持并发，不因空窗口自动增加 |

`calculateOptimalConcurrency(current)` 返回建议值并保存本实例当前值；可通过 `setCurrentConcurrency` 显式设置。统计服务不修改 BullMQ、配额执行器或数据库。返回建议值后由宿主在明确业务边界应用，仍必须服从 API/Worker 总并发和共享配额上限。

小时限流使用两个固定长度 3601 的秒桶数组，突发事件只累计计数，不为每次事件追加小时队列。读取也检查时间，空闲期间过期事件不会永久滞留。包含截止点所在的整个秒桶以避免提前忘记限流事件，因此最多保守保留不足一秒；不会为了限制内存悄悄截掉小时事件计数。累计总数仍精确到安全整数饱和上限。所有时间读取单调化，系统时钟回拨不会提前过期或绕过冷却。

## 验证与明确范围

行为对拍直接 VM 加载实际 Legacy errorStatsService/riskControlService，替换 logger 和 timer，验证分类、1000/100/50 窗口、阈值、步长、冷却和默认最大值。额外用例覆盖十万次突发计数、固定内存、空闲过期、秒桶边界、时钟回拨、无样本、输入/返回隔离、异常输入及原始消息不留存。

根目录执行：

```sh
corepack pnpm --filter sp-api test
corepack pnpm --filter sp-api typecheck
corepack pnpm --filter sp-api build
```

本阶段仅提供共享统计逻辑，未添加 REST 端点、周期任务或生产调用。后续客户端/业务管线必须明确统计单位（一次上游尝试、一次最终调用或一次变体组检查），避免将重试重复计成多个业务检查；跨进程聚合另行设计。旧 errorStatsService 的记录函数尚未接入生产调用，不能把原来的空统计当作真实零错误验收。

Legacy 风控会在 import 时启动五分钟定时器，并通过替换限流器调整区域帽；其最小 30/min、500/hour 在原配置更低时会反向抬高上限。此行为不复制到本包。后续动态配额若启用，必须保留已有消费债务、遵守人工上限和共享 Redis 语义，独立验证后接线。

## 回滚

无 DDL、无新依赖、无生产配置或流量切换。回滚提交即可移除新共享模块与文档；Legacy 不变。若后续宿主使用这些实例，重启会清空进程内统计，不能用于需要持久审计的账目。
