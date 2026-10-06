# 隔离 Legacy / Neo HTTP 分析性能门禁

关联 #218，作为 #190 完整验收的一部分。`Analytics Performance / analytics-performance` 使用独立 GitHub job 的 MySQL 8、TimescaleDB 2.29.2 / PostgreSQL 16、Redis 7 服务。它与 Integration 不共享服务或数据。本机不得伪造 GitHub 环境变量运行 launcher，也不得传入生产数据库、Redis 或现有服务；本机仅运行纯单元测试与静态检查。

`scripts/run-isolated-analytics-performance.js` 创建带 run ID / attempt 的四个数据库和仅授权该 MySQL namespace 的临时用户。普通 CREATE 遇到同名对象即失败；清理仅针对本次成功创建的对象，不覆盖或删除已有数据库。实际 Legacy 初始化 SQL 使用既有 SQL oracle 的 utf8mb4_unicode_ci 和非 ONLY_FULL_GROUP_BY 算术语义；Neo 使用该 revision 的 baseline 与已明确分类的真实升级 SQL。新迁移未分类时先拒绝运行，不猜测逻辑库。

同一有界批次分别写入实际 MySQL / PG monitor_history，默认 720,000 行。`manifest.json` 记录合成 seed、确定性公式、14 列、输入序列 SHA-256、持久化行数、12 组 / 24 ASIN / 6 国家 / 3 site / 4 brand、60 天范围与精确筛选值。输入 digest 不是数据库整表读回 checksum；响应语义由真实 HTTP 成对比较证明。时间为上海 wall-clock timestamp。2040 年 1 月和 2 月分别沿用现脚本 cold/hot 名称，两者都完成 warmup，不宣称清除了 OS 或数据库物理缓存。

刷新九个真实 CAGG 后，启动完整 `server/src/index.js` Express 应用和编译的 `apps/api/dist/main.js` Nest/Fastify AppModule。Legacy 使用真实 MySQL 鉴权，Neo 使用真实 PostgreSQL 鉴权；合成用户与 session 预置，实际 JWT 验证、session 查询/更新及权限检查均保留。登录与 seed/startup 耗时不计入请求性能。无 token 请求必须返回 401；健康检查通过后再测量。

两个 API 使用真实 Redis，明确开启现有 benchmark cache bypass、关闭调度器和限流；Legacy 使用 raw、Neo 使用 CAGG，连接池上限均为 10。只启动 API 角色，测量无并发写入。这证明隔离静态数据的实际 HTTP 分析路径；高写入期间读隔离和完整导出任务链 RSS 仍需 #190 后续验收。

复用 `scripts/benchmark-analytics.js` 原 28 case 矩阵：24 个聚合场景每次响应须证明 cacheHit=false、Legacy source=raw、Neo source=agg，非空且语义相同；4 个 adaptive 场景保留原正确性检查和信息性时延，不套用聚合 3 倍目标。每 target/case warmup 2 次、测量 20 次，成对交替请求顺序，使用原 percentile 算法与完整 HTTP 响应体耗时。每个聚合场景必须 Legacy P95 / Neo P95 >= 3，不允许平均值遮蔽单项失败。请求超时 30 秒，整体 benchmark 30 分钟，workflow 45 分钟；超时算失败。首次运行 37523405165 在仍正常测量时触发原 15 分钟总截止，只生成 manifest/启动诊断，没有完整报告；延长的是完成既定样本的总预算，逐请求截止、样本数量和 3 倍门槛保持不变。

报告包含每次样本、response digest / shape、所有比较门禁和 P50/P90/P95、逐场景 speedup 及汇总。未达到 3 倍、缓存命中、raw fallback、空响应、语义差异或请求失败均使 job 失败；workflow 在失败时仍上传已生成的证据。启动或 deadline 失败只有 manifest/脱敏启动诊断时，不得将缺失测量宣称为通过。

启动日志按完整行脱敏后再限制大小，跨 child stream chunk 的凭据不会作为截断片段落盘；超长和未完成行直接省略。token 仅进入隔离 benchmark 进程的环境，不进入命令行、manifest 或日志。关闭子进程后清理本次创建的数据库/用户；失败清理使用固定原因码 warn，保留 CI job 销毁隔离服务的最终边界。

本地轻量验证：

```powershell
node --test tests/analytics-performance-fixture.test.js tests/analytics-performance-runtime.test.js
node --test tests/benchmark-analytics.test.js tests/api-url.test.js
node --check scripts/run-isolated-analytics-performance.js
git diff --check
```

首次真正性能结论以最新 head 的独立 CI artifact 为准。准备代码与纯单元测试通过不代表数据库/HTTP 性能已通过；若失败，先按 request/source/correctness/performance 区分根因，再引用逐 case 样本定位，保留原 3 倍门槛。
