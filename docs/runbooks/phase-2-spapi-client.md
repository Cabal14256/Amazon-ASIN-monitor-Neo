# P2-T3：共享 SP-API 客户端

关联 Issue #33。本阶段只迁移 API/Worker 共用的客户端，不切换生产流量，不修改 Legacy `server/`。

## 已实现与兼容行为

- `packages/sp-api` 提供 `@asin-monitor/sp-api`，避免 API/Worker 互相导入或复制客户端。没有新运行时依赖；使用 Node HTTP/HTTPS/crypto。
- `resolveConfig(env, database)` 的凭据字段保留 DB 区域值 → DB 全局值 → ENV 区域值 → ENV 全局值的覆盖顺序。签名开关遵循 Legacy 的独立规则：DB 明确为空或 false 仍禁用，只有 DB 缺失/null 才回退 ENV。DB 参数是配置键值快照，不会自行连接数据库。配置来源必须实现可取消的 `get(signal)` / `reload(signal)`；重载须更新来源自身缓存。
- 固定 NA/EU Amazon HTTPS 域名，映射 US/UK/DE/FR/IT/ES marketplace。Catalog 2022 数组编码为 CSV，已有 query 不重复拼接。请求没有本系统 `/api` 前缀，也不接受调用者提供的外部域名。
- LWA form POST、每进程每区域单次刷新、令牌过期前 60 秒刷新、配置变化使对应缓存失效；401 或 400 `invalid_client`/`invalid_grant` 只重载配置重试一次。取消一个订阅者不会中止其他订阅者共享的刷新。无效/超大 token 不入缓存。
- SP-API 只有 HTTP 429 或明确 `QuotaExceeded`/`TooManyRequests` 自动重试；默认最多 5 次重试，即最多 6 次尝试。指数退避从 2 秒起，普通退避封顶 30 秒；合法 Retry-After 数字/日期封顶 120 秒。
- 每次尝试（含重试）都经过调用方配额执行器；每个实际 SP-API HTTP 响应只观察一次限额元数据，包括 429。只接收有限正数速率和有界 request ID，不保存原始错误体。
- 商品不存在必须同时有 HTTP 404 和 `NOT_FOUND` 代码；网关 HTML 404 或消息中出现 NOT_FOUND 不算商品终态。
- 可选 AWS SigV4，含区域、独立 canonical URI/query、日期和临时 session token；默认只用 LWA。保留可选签名功能，但修正 Legacy 将 query 混进 canonical URI 的实现错误。此处不实现 STS AssumeRole。

行为测试先于实现建立，404 fixtures 与原 `server/src/utils/spApiError.js` 直接对照。并非所有 Legacy 监控/配额/通知测试都已迁移：它们属于后续调度和业务流水线。

## 有意收紧的边界

- 不支持的国家直接拒绝，不再静默路由到 US。只在六国业务范围内使用；新增国家必须补映射/契约/行为测试。
- 固定目的地且不跟随重定向；拒绝外域 URL、控制字符、无效编码、超长请求。操作标签按规范化后的真实路由识别，未知操作归 `default`，不把 ASIN/客户标识放进限流标签或日志。
- 失败只抛固定 `SpApiError`、状态码与允许的 Amazon 错误代码；没有原始 token、密钥、请求体、完整 URL 或上游错误体。调用方提供项目 `logger`（INFO 默认、生产不打开 debug），不要给凭据快照或返回数据做额外日志。

## 超时、容量及关闭

| 边界 | 默认与限制 |
| --- | --- |
| 一次调用（含排队、取令牌、退避） | 默认 15 分钟，可设 1 ms ～ 15 分钟 |
| LWA 刷新（含一次配置重载） | 独立 10 秒；不由单个订阅者取消 |
| 原生单次 HTTP I/O | 默认 30 秒，可设 1 ms ～ 60 秒；硬截止销毁实际请求 |
| 调用准入 | 每客户端最多 64 个未结束调用，超限 CAPACITY |
| 原生请求准入 | 默认 64，最多 128；按实际 request close 释放 |
| LWA 刷新 | 每进程客户端每区域最多 1 个实际刷新；US/EU 分开 |
| HTTP 大小 | 请求体 ≤1 MiB；响应默认 ≤8 MiB，可设最大 32 MiB |

配置源、配额执行器、transport 是受信的内部实现，不是用户自定义脚本。必须兑现取消及实际工作完成约定。若注入依赖忽略取消，调用方仍收到截止错误，但未完成工作的准入槽不会提前释放；不得用 Promise.race 把仍在运行的工作算作已结束。原生 transport 会真正销毁 socket；mock/custom transport 也必须执行取消。

`client.close()` 停止接纳并取消调用/令牌刷新，不拥有注入的 transport；宿主须另调用 `transport.close()` 关闭池，并停止配置/配额资源。HTTP 仅在显式 `allowLocalHttp: true` 下允许 127.0.0.1/IPv6 loopback 测试服务器，生产不要开启此选项。

超时、断连或取消不能撤销 Amazon 已接收的操作；本客户端不会自动重试普通网络错误。写入 API 的结果不确定性与幂等性由具体业务调用方负责。

## 尚未实现的接入门槛

当前没有将这个包挂进 `apps/api` 或 `apps/worker` 的生产请求路径，也没有默认无限流适配器。`SpApiClient` 强制要求 `QuotaExecutor`，构造时缺失就报错。

后续独立 Issue 必须补齐：

1. PostgreSQL 系统配置仓储、可取消的配置加载/刷新、Nest 生命周期及受权限保护的管理端点。
2. Redis 按 operation + region 的原子多层配额扣减、0.75 安全系数、反馈限额、手动/定时/批量优先级调度与取消；适配器每次只调用 task 一次且等待实际 task 结束。
3. 真实 BullMQ Processor/调度与监控 pipeline 接线，HTML fallback、风险判断和通知对拍。
4. 使用授权的 sandbox/灰度凭据完成集成验证，达到原始计划的影子对拍与生产切流 gate。

本地/CI 测试只用虚构凭据和本地 loopback，不调用 Amazon，不读取生产配置。不把这些通过结果当作实网联调、配额系统或整个 P2 完成。

## 验证及回滚

根目录执行 `corepack pnpm --filter @asin-monitor/sp-api test`、`typecheck`、`build`，CI 已加入同样检查。测试包含真实本地 socket 的超时、截断、超大响应、取消、容量恢复和重定向，以及签名、并发缓存和重试计数。

本 PR 无 DDL、数据迁移或生产接线；回滚该提交即可移除新包及 CI 检查，不影响 Legacy。将来接线后须由接线 PR 给出流量开关及回滚方法。

参考：[Amazon 连接与 LWA](https://developer-docs.amazon.com/sp-api/docs/connecting-to-the-selling-partner-api)、[Amazon 区域端点](https://developer-docs.amazon.com/sp-api/docs/sp-api-endpoints)、[AWS SigV4](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html)。通用 SigV4 对已编码 URI 再编码、排除 User-Agent 等易变签名头的规则按 [AWS botocore 实现](https://github.com/boto/botocore/blob/develop/botocore/auth.py) 校验，不采用 S3 的特殊原始路径规则。
