# PostgreSQL 双库基线与迁移约定

## 事实源与适用范围

- [`migrations/0000_baseline.sql`](./migrations/0000_baseline.sql) 是空 PostgreSQL/TimescaleDB 双库的唯一建库基线；它通过 `psql` 的 `\connect` 依次初始化主营与竞品两个独立 database。
- [`src/schema`](./src/schema) 与 [`src/schema-competitor`](./src/schema-competitor) 是 Neo 查询代码使用的 Drizzle 事实源，已经按真实数据库反向结构人工校对。
- `server/database/init.sql`、`competitor-init.sql` 与 `server/database/migrations/*.sql` 只保留为 Legacy MySQL 历史参考。既有历史文件已冻结，不得改写或在 PG 上执行。
- 本基线保留三张普通聚合表和普通 `monitor_history`；随后由有序升级 [`migrations/0001_timescale_aggregates.sql`](./migrations/0001_timescale_aggregates.sql) 转为 hypertable 并创建持续聚合，再由 [`migrations/0002_timescale_storage_policies.sql`](./migrations/0002_timescale_storage_policies.sql) 完成索引终审、columnstore 和可选 retention。三个文件均是已部署的有序事实源，不得回写旧迁移。

## 执行方式

首次使用空 Compose 数据卷时，镜像初始化流程按顺序执行：

1. TimescaleDB 镜像自带初始化和调优；
2. `010-bootstrap-databases.sh` 创建竞品 database，并为两库安装扩展；
3. `020-apply-baseline.sh` 执行单一 PG baseline；
4. `030-apply-timescale-aggregates.sh` 在主营库执行 `0001` Timescale 升级；
5. `040-apply-timescale-storage-policies.sh` 在主营库执行 `0002` 索引与存储策略升级；retention 未配置时保持关闭。

```bash
cp .env.neo.example .env.neo
corepack pnpm db:up
corepack pnpm db:status
```

已有数据卷不会重新运行 `/docker-entrypoint-initdb.d`。已有库先应用 baseline（仅限仍为空且需要补基线的环境），再在维护窗口单独升级 Timescale：

```bash
corepack pnpm db:baseline
corepack pnpm db:upgrade:timescale
corepack pnpm db:upgrade:timescale-storage
corepack pnpm --filter db test:integration
```

不得对含业务数据的库重新执行 `db:baseline`；这类环境只依序执行经预演的两次 Timescale 升级。外部实例可用 `psql -X -v ON_ERROR_STOP=1 --file ...` 连接主营 database 执行同一组迁移。`0002` 精确要求 TimescaleDB 2.29.2，retention 默认关闭；明确审批后才把 `asin_monitor.monitor_history_retention_days` 会话 GUC 设为不小于 800 的整数。

对外部 PostgreSQL 16 + TimescaleDB 实例，先创建两个 database 并在两库启用扩展，再从可访问两库的管理连接执行：

```bash
psql -X -v ON_ERROR_STOP=1 \
  --dbname postgres \
  --set primary_database=amazon_asin_monitor \
  --set competitor_database=amazon_competitor_monitor \
  --file packages/db/migrations/0000_baseline.sql
```

database 名仅允许字母、数字和下划线；本地 bootstrap 会拒绝其他值。baseline 对空库可重复执行，CI 会连续执行两次并验证种子不重复。

## Timescale hypertable 与持续聚合

`0001_timescale_aggregates.sql` 在单个事务中执行，并先对 `public.monitor_history` 获取 `ACCESS EXCLUSIVE` 锁；锁等待上限为 30 秒，已有数据的 `migrate_data` 执行时间不设 statement timeout。因此上线前必须用同量级备份预演并预留完整维护窗口，不能在仍有 Legacy/Neo 写入或长查询时直接执行。

升级具有以下固定边界：

- 只接受普通、没有继承子表的 `monitor_history`，或已经符合目标结构的 hypertable；未知分区/继承结构会稳定拒绝；
- 目标主键从 `id` 改为 `(check_time, id)`，满足 Timescale 唯一约束必须包含分区键；MySQL 源迁移仍以 `id` 做 keyset，不改变源端主键语义；
- `check_time` 是唯一时间维，chunk interval 为 7 天。它覆盖 hour policy 的 49 小时迟到刷新窗且不会让 32 天 day policy 落入过多小 chunk；最终大小与内存/查询指标仍由 P1-T4b 压测复核；
- 新增 asin、dimension、variant-group × hour/day/month 共 9 个 `materialized_only=true` CAGG。全部以 `WITH NO DATA` 创建，不依赖 real-time aggregate；
- 升级脚本在任何 Timescale 函数解析前把 `search_path` 固定为 `pg_catalog, public`；新建 CAGG 会写入带版本的精确定义指纹，重复升级会拒绝部分集合、无指纹旧定义或指纹与 catalog 定义不一致的 CAGG，并要求按 Runbook 受控重建；
- CAGG 的文本筛选、分组和变体名 `MAX` 会先用 `rtrim` 复现 MySQL `utf8mb4_unicode_ci` 的 PAD SPACE 尾随空格语义，再显式使用 ICU `und-u-ks-level1` 非确定性 collation 复现大小写/重音不敏感语义；升级会拒绝同名但定义不符的 collation；
- 变体组历史行没有名称快照时，刷新过程会把当时的 `variant_groups.name` fallback 一并物化；兼容视图不再实时关联当前名称，因此后续重命名或删除不会改写已经物化的历史标签；
- `monitor_history_agg_v2`、`monitor_history_agg_dim_v2`、`monitor_history_agg_variant_group_v2` 只是只读兼容投影，应用不得向它们或 CAGG 写入；
- 三张 Legacy agg 表、`analytics_refresh_watermark` 和 `monitor_history_status_interval` 均保留。状态区间不是聚合语义，不转为 CAGG。

自动刷新策略为：hour `[now-49h, now)` 每 10 分钟、day `[now-32d, now)` 每小时、month `[now-25mo, now)` 每天；`end_offset=0` 让 Timescale 在每次运行中纳入最新已完成 bucket，当前未完成 bucket 仍不会进入 materialized-only CAGG。调度 timezone 固定 `Asia/Shanghai`。边界之外的历史数据和已经物化 bucket 内的迟到数据必须通过显式窗口重刷。

### P1-T4b 索引、columnstore 与 retention

`0002` 使用 `timescaledb.transaction_per_chunk` 把 19 个 Legacy 原始历史索引收敛为 7 个经过真实查询验证的运维索引，并为 9 个 CAGG 显式创建 30 个 `(group_key, time_slot)` B-tree；加上每个背景 hypertable 的 Timescale 单 `time_slot` 索引，catalog 精确总数为 39。逐项取舍、BRIN 暂不采用的依据以及重评阈值见 [`INDEX_REVIEW.md`](./INDEX_REVIEW.md)。

原始历史按 `country,asin_id` 分段、`check_time DESC,id DESC` 排序，30 天后进入 columnstore；hour/day/month CAGG 分别在 3/40/800 天后进入 columnstore。全部使用 TimescaleDB 2.29.2 的 `enable_columnstore`、`add_columnstore_policy` 和 `convert_to_*store` API，不使用旧 compression API。固定调度起点与 timezone 使重复部署可精确校验 catalog。

Retention 是显式 opt-in：Compose 不把该变量传入新卷自动初始化；未设置 `TIMESCALE_RETENTION_DAYS` 时，迁移要求 catalog 中不存在 raw retention job。只有历史回填和正确性 Gate 完成后，才以显式 `db:upgrade:timescale-storage` 命令传入整数且不小于 800 天的值，并且重复执行必须与现有 job 完全一致。它不能早于 month CAGG 的 25 个月刷新/回填边界。部署、观测、暂停、晚到写入、恢复与不可逆删除后的 MySQL 回切见 [`../../docs/runbooks/phase-1-timescale-storage.md`](../../docs/runbooks/phase-1-timescale-storage.md)。受控逆迁移为 [`migrations/0002_timescale_storage_policies.rollback.sql`](./migrations/0002_timescale_storage_policies.rollback.sql)，但无法恢复已被 retention 删除的 chunk。

Integration 先完成 schema 与 MySQL→PG 数据迁移测试，再在同一一次性目标上运行破坏性性能套件，避免 72 万行 fixture 干扰迁移测试的超时和 catalog 对抗用例。性能套件使用 60 天且同一 ASIN 周期性重复检查的确定性 fixture：7 个原始表运维索引和 hour/day/month 下 country/site/brand 共 9 个 CAGG 维度索引，都必须由真实 `EXPLAIN (ANALYZE, BUFFERS)` 计划命中；asin/dim/variant_group 三个 CAGG 家族的冷热 × hour/day/month × 有无家族筛选共 36 组 raw/CAGG 结果摘要必须一致且每组 P95 至少 3 倍，另验证 columnstore 查询、晚到写入、重整和开放写事务期间的 CAGG 读取。CAGG 查询直接比较已经在视图定义中规范化的维度列，避免查询侧函数包裹使普通 B-tree 失效。性能套件会拒绝普通本地库，运行者必须以 `TIMESCALE_PERFORMANCE_DISPOSABLE_DATABASE` 精确声明名称含 `_ci` 的一次性目标库；脱敏报告作为 CI artifact 输出到 `artifacts/timescale-performance/integration-report.json`。

### 有界历史回填与正确性 Gate

先把同一冻结 MySQL 快照迁入 PG，让三张 Legacy agg 表成为对照源；数据迁移会在同一目标事务内清空 21 张业务表以及九个 CAGG 的内部物化 hypertable，因此复用预演库不会保留上一次回填。再配置覆盖本次全部迁移历史的完整月边界半开区间并运行：

```bash
corepack pnpm db:migrate:data
corepack pnpm db:timescale:aggregate:gate
```

Gate 使用 `DATABASE_URL`，并从根目录依次读取 `.env.migration`、`.env.neo`、`.env`。变量如下：

| 变量 | 说明 |
| --- | --- |
| `TIMESCALE_AGG_WINDOW_START` | 必填，本地业务时间月初；必须不晚于合格原始历史及三张 Legacy agg 表的最早 bucket |
| `TIMESCALE_AGG_WINDOW_END` | 必填，排他月初边界；必须晚于 start，跨度不超过 120 个月 |
| `TIMESCALE_AGG_REFRESH` | 是否先手工刷新全部 9 个 CAGG，默认 `true`；设为 `false` 仅生成诊断报告，始终非零退出且不能成为放量证据 |
| `TIMESCALE_AGG_PAGE_SIZE` | 服务端游标每批读取行数，100–5000，默认 1000 |
| `TIMESCALE_AGG_REPORT_PATH` | JSON 报告，默认 `artifacts/timescale-aggregate/report.json` |

月初边界确保 hour/day/month bucket 均完整。刷新使用 `[start,end)` 同一窗口并传入 `force=true`，使已物化 bucket 和只由变体表变化影响的 fallback 也会重算。Gate 固定会话 `search_path`，先复核 9 个 CAGG 的 migration-owned 定义指纹、v2 marker 和完整 refresh job 参数，再在一个 `REPEATABLE READ READ ONLY` 快照中通过服务端游标单次顺序扫描 9 组 Legacy/CAGG；文本键先按 PAD SPACE 去除尾随空格，再按 Legacy collation 配对并比较分组集合和全部业务值摘要，覆盖 ASIN fallback、空 site/brand、变体名 fallback、broken/peak 及 first/last check time。成功报告必须由本次运行刷新、包含九组完全一致证据且窗口至少有一组 Legacy 数据；同一快照中还会计数窗口外的所有合格原始历史和三张 Legacy agg 行，只有 `coverage.rowsOutsideWindow=0` 才可通过。未刷新、全空窗口、覆盖不全、任一差异或运行错误均返回非零。报告只含行数和 SHA-256 摘要，不含原始业务行或连接串。

手工回填可重复运行。迟到数据落入已物化 bucket 后，必须以包含完整 bucket 的相同或更小月边界窗口重新运行 `TIMESCALE_AGG_REFRESH=true` 的 Gate，再以新报告作为放量证据。不得用 `refresh=false` 的旧结果通过切换审批。

升级、CAGG 重建和恢复普通表的操作边界见 [`../../docs/runbooks/phase-1-database-rollback.md`](../../docs/runbooks/phase-1-database-rollback.md)。

## MySQL → PostgreSQL 翻译决策

| Legacy 语义 | PG16/Drizzle 基线 | 说明 |
| --- | --- | --- |
| `TINYINT(1)` | `boolean` | 保留原默认值与可空性 |
| 5 处 `ENUM` | `varchar` + 命名 `CHECK` | 三个 granularity、users.status、sessions.status |
| `AUTO_INCREMENT` | `GENERATED ALWAYS AS IDENTITY` | Drizzle 统一使用 identity builder |
| `DATETIME` | `timestamp without time zone` | 决策 D8；两库默认 timezone 固定为 Asia/Shanghai，应用层按同一时区转换 |
| `hour_ts/day_ts/month_ts` | `date_trunc` stored generated column | 避免 `timestamptz` 生成表达式非 immutable |
| `ON UPDATE CURRENT_TIMESTAMP` | `set_updated_timestamp_column()` + 行级 trigger | 一个通用函数按 trigger 参数更新目标列 |
| JSON 文本 | `jsonb` | `monitor_history.check_result`、竞品同名列、`audit_logs.request_data` |
| `ON DUPLICATE KEY UPDATE ... VALUES()` | `ON CONFLICT ... EXCLUDED.*` | roles、permissions 与关联种子幂等 |
| 历史表外键 | 不创建 | 保留 030 迁移后的快照数据与批量删除语义 |
| 反引号、`USE`、`ENGINE` | 移除 | database 切换只使用 psql `\connect` |

MySQL 索引名只需在单表内唯一，PG 索引名在同一 schema 内必须唯一，因此通用的 `idx_country` 等名称统一加表名前缀；索引列序与排序方向保持不变。Legacy 中的重复索引在 P1-T2 原样表达，再由 P1-T4b 的有序迁移按 [`INDEX_REVIEW.md`](./INDEX_REVIEW.md) 和性能 Gate 收敛。

### 排序规则

PG 数据库使用 UTF-8，覆盖 MySQL `utf8mb4` 的字符集合。没有全局套用 nondeterministic ICU collation：PG16 对这类 collation 的模式匹配与部分索引操作有限制，而现有页面大量依赖 `LIKE` 搜索。

为保留 `utf8mb4_unicode_ci` / `utf8mb4_0900_ai_ci` 在关键唯一键上的大小写不敏感语义，基线为以下字段增加 `lower(...)` 唯一索引，同时保留普通 `varchar`：

- 主营与竞品 `(asin, country)`；
- 主营与竞品飞书配置 `country`；
- `users.username`、`roles.code`、`permissions.code`、`sp_api_config.config_key`。

ASIN、国家、权限代码和内部 ID 仍应在应用入口规范化；Legacy 的大小写不敏感搜索在 Neo 查询层必须显式使用 `ILIKE` 或 `lower(...)`。重音折叠不作为当前业务标识符语义，不能依赖数据库隐式处理。

## 校验与回滚

```bash
corepack pnpm --filter db test
corepack pnpm build:db
corepack pnpm --filter db test:integration
```

Integration 验证两库表集合（21 + 4）、全部列、显式索引、identity、生成列、CHECK、外键、触发器及四类种子。数据库 baseline 只能用于空 PG 双库；MySQL 数据导入、行数/字段/业务查询对拍和切换演练见 [`DATA_MIGRATION.md`](./DATA_MIGRATION.md)。

回滚时：

- 本地空验证库可在确认无数据后停止容器并删除 Neo 命名卷，再回到上一个 Git 提交重建；
- 含数据环境不得直接删除表或卷，应恢复执行前备份并把应用连接切回仍保持只读兜底的 MySQL；
- 任何后续 PG schema 变化都新增有序迁移，不修改 `0000_baseline.sql` 已经部署过的副本。生产同步使用 P1-T3 固化的自定义 ETL、契约化对拍报告与写冻结/回滚流程。
