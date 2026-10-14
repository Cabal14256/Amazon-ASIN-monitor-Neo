# Worker 手动监控指标

关联 Issue：#253。此切片提供 Worker 进程自己的 Prometheus Registry 与抓取端口，记录主营和竞品手动监控。API 的 Registry 属于另一个进程，不能用于读取这些 Worker 计数。

## 配置与部署

默认 `WORKER_METRICS_ENABLED=false`，不开端口，不创建 Registry。显式启用时，默认监听 `127.0.0.1:3101`：

```dotenv
WORKER_METRICS_ENABLED=true
WORKER_METRICS_HOST=127.0.0.1
WORKER_METRICS_PORT=3101
```

Prometheus 应抓取每一个 Worker 的独立地址。容器需要显式设置 `WORKER_METRICS_HOST=0.0.0.0` 并配置私网访问；当前 `compose.neo.yml` 只定义数据库，需要部署方另行配置 Worker、Redis 和抓取目标。多个本机 Worker 应配置不同端口；端口冲突会在创建消费者之前令启动失败。

只支持 `GET /metrics`。`HEAD /metrics` 与其他方法返回 405；查询字符串、`/api/metrics` 和未知路径返回固定 404；收集失败返回固定 503，不回显异常、请求路径或凭据。该端点没有用户登录流程，默认回环绑定；跨主机访问应限制在部署私网。

```yaml
scrape_configs:
  - job_name: neo-worker
    static_configs:
      - targets: ['127.0.0.1:3101']
```

启用端口不会改变 `WORKER_ENABLED_QUEUES`、`AUTH_DATA_AUTHORITY` 或调度开关。空闲 Worker 可抓取进程指标，同时继续跳过 Redis 连接与看门狗。启动后续阶段失败时关闭已绑定端口；空闲停止和活跃 Worker 的原有 10 秒关停预算都关闭该监听器。

## 指标语义

保留 Legacy 指标名称、标签与桶，固定前缀 `amazon_asin_monitor_`。主营与竞品共享组指标；不会增加业务域、用户、任务或 owner 标签。`region` 只接受 `US`、`UK`、`DE`、`FR`、`IT`、`ES`。

| 指标（省略固定前缀） | 标签 | 记录时点 / 桶 |
| --- | --- | --- |
| `variant_group_checks_total` | `region,result` | 真实 `checkGroup` 正常返回后；`result=broken\|ok` |
| `variant_group_check_duration_seconds` | `region` | 同一次正常返回的调用耗时；桶 `0.1,0.5,1,2,5,10` 秒 |
| `scheduler_runs_total` | `type` | 通过任务解析的 processor 尝试在 `finally` 中记录，包括成功、失败、取消和重放 |
| `scheduler_run_duration_seconds` | `type` | 同一次 processor 尝试耗时；桶 `1,5,10,30,60,120` 秒 |

`type` 仅为 `monitor_task` 与 `competitor_monitor_task`。手动监控不依赖 `SCHEDULER_ENABLED`，也记录这两个 Legacy 调度类型。无法解析的任务不计数；在正常组返回之前取消或抛错，不生成组结果或组耗时样本。上游失败被管道转换为正常返回的断链结果时，记录 `broken`。

这里的组计数是正常调用返回次数，包含缓存与 receipt 返回；重试可能重复记录已经返回的组。完整竞品任务完成后的短路重放只增加执行尝试，未调用组检查就不增加组计数。因此不能将这些指标解释为唯一提交数、唯一任务数或 SP-API 请求数。

指标存储在当前进程内，进程重启时重置。Prometheus 以实例分别抓取并处理 Counter 重置；没有借用 Redis Pub/Sub 或 API Registry 聚合计数。观察器异常只记录脱敏 warning，不影响业务结果或清理。默认 Node 进程指标同样使用 Legacy 前缀与 GC 桶 `0.001,0.01,0.1,1,2,5` 秒。

## 验证边界

测试覆盖真实 HTTP socket 的名称、标签、桶、计数、有限路由、绑定冲突及关闭；processor 测试覆盖正常返回、失败、取消、重试和异常观察器。集成入口复用真实编译 Worker、BullMQ、PostgreSQL 和 Redis fixture，抓取组 Counter 与同 region 的 Histogram，检查手动执行类型与失败/取消后计数、进程退出后端口关闭。

原生测试只在 Linux 且显式 `RUN_INTEGRATION_TESTS=true` 时运行；创建任何端口、连接、schema 或队列前，要求 `INTEGRATION_ALLOW_DROP_DATABASES=true`、`TIMESCALE_PERFORMANCE_DISPOSABLE_DATABASE=amazon_asin_monitor_ci`、精确回环 PostgreSQL 5432 双 CI 数据库，以及回环 Redis 6379 DB 15。现有 Integration workflow 满足这些目标条件；不允许拿生产地址绕过 guard。

本切片尚未接入真正的定时 `us` / `eu` / analytics 调度指标，也未实现数据库查询指标或备份指标。当前 Legacy 数据库指标定义没有真实 caller，不能用占位声明代替完成证据。SP-API 的 `risk.recordCheck` 仍是风险窗口计数，不能视为 Prometheus 组指标。

回滚时关闭 `WORKER_METRICS_ENABLED` 即可恢复不开监听器的默认模式；无数据库升级或迁移。
