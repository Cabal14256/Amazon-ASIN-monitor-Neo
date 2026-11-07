# Neo API 双 PostgreSQL 指标（Issue #258）

API 的原生 `pg.Client` 构建边界记录标准 text/config query；两库共用现有 `amazon_asin_monitor_db_queries_total` 和 `amazon_asin_monitor_db_query_duration_seconds`。`Pool.query`、借出 client 和 Drizzle 使用同一边界，避免重复计数。不改变连接池容量、超时、事务和 release 所有权。

## 指标含义

- counter 标签保持 `table,operation,status`。`table` 固定 `unknown`；operation 仅 `SELECT|INSERT|UPDATE|DELETE|OTHER`，只识别 SQL 前 64 字符内的首 token。注释、CTE 和其它语句归 OTHER；status 为 success/error。
- 每次实际 driver invocation 最终成功或失败时计一次；一批多语句仍是一次。未获得连接且没有调用 client query 的失败不计 SQL error。
- histogram 保持 success-only 与原桶 `[0.001,0.01,0.1,0.5,1,2,5]`。单调时钟耗时包括 client 排队，不含 pool acquisition，不代表服务器执行时间。
- `amazon_asin_monitor_db_pool_{total_connections,idle_connections,active_connections,waiting_requests,connection_limit}` 的唯一标签为 `database=database|competitor_database`。每次 `/metrics` collect 读取原池公共属性，无 SQL、health probe 或定时轮询。
- active 是 `max(0,total-idle)`，含空闲事务，不能解释为正在运行 SQL 的连接数。

SQL、values、prepared name、连接串、用户标识和异常消息不进入标签或 observer 日志。指标故障不改变查询结果或错误；诊断仅固定 reason，每个 observer/池快照绑定最多警告一次。API shutdown 保持 drain/flush/pool.end 顺序，结束后解除池快照引用。

## 验证与边界

`test/database-metrics.test.ts` 通过真实 Nest DatabaseModule/MetricsModule、原生 Pool/Client 和根 `/metrics`，仅替换 client transport。正式 main `1966bd24` 上原版健康对照两项通过，指标两项因实际缺失而失败；初始 oracle SHA-256 为 `8fdae0c698eb90ccc4f5b66c614cbca5f7ae99a0e50add5bf72a53453bffcd90`，原版构建与 RED 日志保存在本工作树 `.cache/evidence/258-original-*`。

真实 PG suite 由现有 Integration 已执行的 `test/health.test.ts` 注册，在创建资源前要求明确 disposable loopback 双库。仅创建 session-local 临时对象，覆盖 success/error 精确 delta、success-only histogram、config/rowMode/types/query_timeout、callback、事务提交/回滚、多语句、池满 scrape 与真实 release(true)。运行 `corepack pnpm --filter api exec tsc -p tsconfig.metrics.test.json --pretty false` 验证 fixture 类型。

Submittable/QueryStream 原对象透传，首版不观测。`unknown` 表标签、两库合并查询及未覆盖流式 query 的边界不作为数据库可观测性全阶段完成声明。本机未启用真实 PG 的 skip 不计通过，正式 native 证据必须来自本 PR 最新 head Integration。

回滚本 PR 的 API observer、gauge 和模块接线即可；无 schema、数据、生产配置或 Worker Registry 变化。
