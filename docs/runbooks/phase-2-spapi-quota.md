# P2：SP-API 原子配额与有界执行器

关联 Issue #69。`packages/sp-api` 现在提供 `SpApiQuotaExecutor`，可直接注入既有 `SpApiClient`。本次没有新增 HTTP 端点、数据库迁移或生产流量接线；PostgreSQL 配置加载、Nest provider、监控 Processor 与业务流水线继续按独立 Issue 迁移。

## 与 Legacy 对齐的额度

`resolveQuotaSettings(env)` 读取以下设置，并返回不可变快照：

| 配置 | 默认值 | 行为 |
| --- | --- | --- |
| `RATE_LIMITER_KEY_PREFIX` | `spapi:ratelimiter` | 与 Legacy 共用账户配额命名空间 |
| `SP_API_RATE_LIMIT_PER_MINUTE` | 45 | 每个 US/EU 区域独立的分钟上限 |
| `SP_API_RATE_LIMIT_PER_HOUR` | 2700 | 每个 US/EU 区域独立的小时上限 |
| `SP_API_RATE_LIMIT_SAFETY_FACTOR` | 0.75 | operation 速率、分钟/小时上限和默认 burst 的安全系数，最大 1 |
| `SP_API_RATE_LIMIT_BURST_CAP` | 未设置 | 显式设置时取原 burst 与 cap 较小值；最低 1 |

Catalog `getCatalogItem` / `searchCatalogItems` 的原始 rate/burst/minute/hour 为 `2 / 2 / 120 / 7200`；`default` 为 `0.5 / 1 / 30 / 500`。默认安全系数后，Catalog burst/minute/hour 为 `1 / 90 / 5400`，default 为 `1 / 22 / 375`。operation 分钟/小时容量同时受反馈速率和上述固定上限限制。区域保护上限不再乘安全系数。

测试直接加载 Legacy `rateLimiter.js` 比较合法配置和反馈限额。Neo 有意拒绝显式无效配置（例如 Infinity、非正值、超界值），不会沿用部分旧环境变量解析的静默默认；省略和空数值仍使用默认。计数上限为正整数，速率和安全系数允许有限正小数，输入数值最大 1,000,000。仅接受 US/EU 与三个固定 operation，避免无界动态标签。共享客户端会把未知 Amazon 操作识别为 `default`。

## 原子扣减与双跑

一次准入在一个 Lua 脚本中检查并扣减五个窗口：区域 minute/hour、operation second/minute/hour。所有窗口先检查，拒绝时不会只扣区域额度。ZSET 的 key、窗口、TTL 和成员格式与 Legacy 相同；Lua 采用 `ZADD NX`，重复回执不重复扣减，也不延长原成员时间。每个逻辑尝试有独立随机 ID，真正开始过的回调不会重入队列。

同一 Amazon 账户的 Legacy、Neo API 和 Neo Worker **必须使用相同 Redis 与 quota prefix**，否则会分别得到一套额度。它与必须隔离的 Bull/BullMQ 作业数据不同。当前为已有单 Redis 拓扑设计，多 key 未使用 Redis Cluster hash tag，不能直接用于分片 Cluster。节点时钟需要正常同步，保留 Legacy 的客户端时间窗口语义。

`x-amzn-ratelimit-limit` 只更新固定字段 `rate/burst/source/updatedAt`，不保存原响应、request ID 或凭据。Redis 元数据读入有大小、数值和日期校验；无效历史字段允许修复，较旧时间的反馈不会覆盖较新反馈。观察写入每组最多一个进行中写入和一个最新待写记录；失败在后续观察、准入或状态读取时重试，不阻塞 Amazon 响应，也不触发请求重放。

## 调度、容量及关闭

| 边界 | 默认与限制 |
| --- | --- |
| 优先级 | 手动 1、定时 2、批量 3；相同优先级 FIFO；不抢占已开始的准入/请求 |
| 等待及准入中的回调 | 总计最多 1000，可降低到 1 |
| 排队截止 | 默认 120 秒，可设 1 ms ～ 15 分钟；独立定时器不受系统时间回拨延长 |
| 实际运行并发 | 每区域 Catalog 各 2、default 1，总计最多 10；可统一降低为 1 |
| 调度重试 | 仅一个准入泵、一个唤醒定时器；同组拒绝会暂缓整组，不遍历队列向 Redis 发扣减请求 |
| Redis 操作截止 | 默认 2 秒，可设 10 ms ～ 10 秒；超时/取消后保留底层操作槽直到实际结束 |
| 进程内配额状态 | 两个区域、六个 operation 组，共 22 个固定窗口；不随请求数增长 |

回调成功或失败都只执行一次。排队取消立即拒绝并阻止延迟 GET 之后再发 EVAL。已开始的回调必须真正结束，执行器才释放名额及返回；`SpApiClient` 自身会及时向调用者返回取消，并继续保留未结束工作名额。配额排队截止不会中止已运行的回调，运行时限由客户端/原生 transport 控制。

宿主应为每个进程注册一个执行器和一个客户端。关闭时先 `client.close()` 中止请求，再关闭 transport、`executor.close()`，最后关闭宿主持有的 Redis 连接；执行器不会销毁外部 Redis 客户端。自定义 transport 必须兑现 AbortSignal，不能用无限等待替代真实 socket 关闭。

## Redis 故障与状态

宿主提供的 `QuotaRedisPort` 必须禁用离线命令队列，配置有限 command/connect timeout 与有限重试；不要复用 BullMQ consumer 所需的无限重试连接。库只消费已配置的连接，不自行读取环境变量或连接服务。

Redis 不可用、命令失败或超时后，回退为 Legacy 同类的连续补充令牌桶。正常 Redis 请求同样扣减本地影子额度，故障和恢复不会重置已用额度。恢复时同时满足 Redis 和本地影子额度才能开始请求。健康操作仍占用槽时的 `busy` 不会直接触发绕过 Redis；底层超时后最多保留一笔准入操作，不会堆积失效命令。

内存回退只能协调本进程，**Redis 故障期间不能保证跨实例的账户总上限**；重启进程也不能恢复内存债务。这是兼容 Legacy 的可用性选择。生产切流前需按实际账户容量决定故障期是否暂停批量任务，并验证多实例负载；本次没有替生产环境改变该策略。

`snapshot(region, operation?, signal?)` 返回已有 rateLimiterSnapshot 契约形态。区域仅 minute/hour，operation 增加 second；额度取共享 Redis 与本地记录中更保守的值。`mode/redisAvailable` 描述此次状态读取来源，`lastMode` 描述最近实际开始的请求。`limitSource/limitUpdatedAt` 来自有效反馈；失败时返回内存状态，取消/关闭则返回固定错误。状态读取不恢复已消费额度。

日志只通过注入的项目 `logger`。降级转变记录一次 warn，实际分布式扣减恢复记录 info；上下文只有固定原因，不记录配置、Redis 错误原文、Amazon payload 或用户标识。

## 验证与回滚

从仓库根执行：

```powershell
corepack pnpm --filter @asin-monitor/sp-api test
corepack pnpm --filter @asin-monitor/sp-api typecheck
corepack pnpm --filter @asin-monitor/sp-api build
```

普通测试不连接服务。真实 Redis 测试需要显式 `RUN_INTEGRATION_TESTS=true` 和隔离 `REDIS_URL`，由 Integration CI 的 Redis 7 服务执行 `pnpm --filter @asin-monitor/sp-api exec vitest run test/quota.integration.test.ts`。每例只清理随机 `spapi:quota69:<uuid>` prefix 下的自有 key，不清空数据库；测试覆盖 Legacy Lua 共用配额、多实例、重复回执、反馈竞态、真实客户端 429 重试，以及断连/恢复。

没有调用 Amazon 或读取真实凭据。CI 通过不能替代授权 sandbox、影子对拍与生产切流 gate。当前回滚提交即可移除库扩展，不影响 Legacy 生产路径；后续宿主接线必须补流量开关和关闭验证。无需删除共用的 Legacy 配额 key。
