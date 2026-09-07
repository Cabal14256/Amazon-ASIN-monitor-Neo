# P2：API SP-API 单例与状态接口

关联 Issue #81。`SpApiRuntimeModule` 在 API 中注册 `ApplicationSpApiRuntime`，供后续业务服务通过 Nest 注入使用。标准、Legacy、HTML、配额、错误统计和风险实例在当前 API 进程内复用；构造不会发起 Amazon 请求，业务调用仍须显式执行。Worker 业务处理器和完整变体管线尚未接入，不宣称本提交已完成 SP-API 生产迁移。

## 实例与配置

标准客户端使用现有 `ApplicationSpApiConfigSource`，每次获取当前 PostgreSQL 配置，拒绝在数据库故障时使用旧凭据。Legacy 与 HTML 开关分别从当前 `ENABLE_LEGACY_CLIENT_FALLBACK`、`ENABLE_HTML_SCRAPER_FALLBACK` 读取：DB null/缺失才回退受限环境快照，空串显式关闭，仅 true/`true`/`1` 允许。两种备用仍默认关闭；设置开关只允许调用，不会自动发起检查或执行主 → 备用 →HTML 回退流程。

标准与 Legacy 共用同一个配额执行器和 8MiB/64 活动请求/30 秒原生传输；HTML 使用独立的 2MiB/2 活动请求/15 秒传输，不扣 SP-API 配额。标准和备用的总调用期限、配置读取、LWA 缓存、重试及取消语义见各自运行说明。`AUTH_DATA_AUTHORITY` 非 postgresql 时，新状态服务和内部调用明确关闭。

宿主仅在环境初始化后读取下列五项 quota 配置并校验：`RATE_LIMITER_KEY_PREFIX`、`SP_API_RATE_LIMIT_PER_MINUTE`、`SP_API_RATE_LIMIT_PER_HOUR`、`SP_API_RATE_LIMIT_SAFETY_FACTOR`、`SP_API_RATE_LIMIT_BURST_CAP`。默认维持共享包中的 Legacy 数值与键前缀；这些是进程启动配置，不是配置管理页面中的动态字段。调整后按部署流程重启实例；不能通过重建执行器来清空当前消费状态。

## Redis 与停止顺序

复用 API 的 `ApplicationRedisClient`。初始化时以及真正使用配额/查询状态前，检查连接状态；wait/end 时通过宿主 ping 建立或恢复连接，避免 lazy client 永久停在内存模式。一次只有一个实际探测，可见等待最多 500ms；底层忽略期限时仍保留该探测，后续调用复用已结束的可见等待，不累积新连接或永不结束的等待链。

探测失败后配额按既有规则暂用有界进程内影子额度，日志只记录固定原因。连接由本模块或其它 API 功能恢复后重置故障日志状态，后续新故障仍能报告。恢复继续使用原配额实例，因此不丢弃未补充的内存消费；真实 Redis 窗口和影子额度合并取更保守值。Redis 故障期间的内存模式不能协调多个进程，状态响应会明确表示 mode。

Runtime 在 OnModuleDestroy 中停止三个客户端、配额和连接探测，并取消活动调用；两个原生 HTTP provider 在 OnApplicationShutdown 中关闭实际套接字。Redis 和 PostgreSQL 仍由应用现有 owner 关闭，Runtime 不重复关闭外部资源。

## 两个状态接口

| 接口 | 查询与返回 |
| --- | --- |
| `GET /api/v1/rate-limiter/status` | region 可选 US/EU，缺省两区；operation 可选 getCatalogItem/searchCatalogItems，缺省区域窗口；响应仍为按区域索引的既有快照 |
| `GET /api/v1/error-stats` | hours 默认 1，有限正数且最多 168；返回现有 total/recent/byType/byRegion/timeSeries |

两者要求 AuthenticationGuard、`settings:read`，并在有界 PostgreSQL 管理事务内复核当前账户、密码策略、会话和权限；Redis 缓存中的旧授权不能替代这次检查。相较 Legacy 路由层未单独挂认证，这是明确的安全收紧。每个状态服务最多 8 个活动查询，超出 429；查询值中的数组/对象、未知地区/operation 和非法小时数返回 400。响应使用既有信封，错误不暴露 SQL/Redis/原始异常，并设置 no-store。

配额快照来自上述实际执行器，Redis 正常时读取账号共享窗口；内存模式中的 used 是当前未补充消费量，不能当累计请求次数。状态查询自身不扣 Amazon 请求额度。授权事务受现有 2 秒数据库期限约束，Redis 就绪和快照分别最多 500ms，两区快照并行，避免持有管理锁无限等待外部依赖。

## 错误和风险计数单位

错误统计只记录当前 API 进程对两个固定 SP-API HTTPS origin 的实际传输尝试：HTTP 非 2xx、200 但 JSON 无法解析、活动传输错误或期限。一次 429 后重试成功只留下该 429 的一条失败记录；LWA、HTML、配额等待、关闭备用、凭据/开关读取失败、主动取消、关闭以及传输在发起前返回的容量/输入/配置拒绝均不计入。

`X-SP-API-Statistics-Scope: api-process` 和 `X-SP-API-Statistics-Unit: upstream-attempt` 标明范围。它不是跨 API/Worker 聚合，不持久化，重启清空；只返回当前已接入该实例的调用，不能把零值解释为全系统无错误。消息只有固定分类文本，无 URL、ASIN、token、HTML 或上游原始异常。

`runtime.risk` 单独提供业务检查窗口，当前不按传输尝试自动 recordCheck。后续完整变体管线必须在一次逻辑检查完成后明确记录，避免把 429 重试计成多个业务检查；本提交也不会自动应用并发建议或修改人工配额上限。

## 验证与回滚

单元和 HTTP 测试覆盖实际 Legacy 查询对拍、实例组合、两种开关、计数单位、权限缓存后的即时撤权、会话/密码状态、容量、no-store、固定错误和停止顺序。完整 AppModule 的既有依赖与关闭测试继续执行。

真实集成沿用随机 PostgreSQL 私有 schema，无 public search_path 回退；Redis 仅使用随机 `spapi:runtime81:<uuid>` 配额前缀与自有用户缓存，结束时验证归属并清理。六项用例验证实际 PG/Redis 状态、请求配额/错误计数、当前开关、SQL 锁超时、真实 RBAC 锁等待后的撤权、真实 Redis 连接恢复及消费保留。Amazon 始终用虚构传输替代，不访问生产账号。

执行完整 17 项基线、API 测试类型检查和共享 SP-API 测试/类型/构建；CI 显式执行 `test/sp-api-runtime.integration.test.ts`。没有 DDL、生产流量或旧路径切换；回滚提交即可移除新状态路由和实例接入，既有配置管理及 Legacy 继续保留。
