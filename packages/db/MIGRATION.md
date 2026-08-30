# PostgreSQL 双库基线与迁移约定

## 事实源与适用范围

- [`migrations/0000_baseline.sql`](./migrations/0000_baseline.sql) 是空 PostgreSQL/TimescaleDB 双库的唯一建库基线；它通过 `psql` 的 `\connect` 依次初始化主营与竞品两个独立 database。
- [`src/schema`](./src/schema) 与 [`src/schema-competitor`](./src/schema-competitor) 是 Neo 查询代码使用的 Drizzle 事实源，已经按真实数据库反向结构人工校对。
- `server/database/init.sql`、`competitor-init.sql` 与 `server/database/migrations/*.sql` 只保留为 Legacy MySQL 历史参考。既有历史文件已冻结，不得改写或在 PG 上执行。
- 本基线保留三张普通聚合表和普通 `monitor_history`；随后由有序升级 [`migrations/0001_timescale_aggregates.sql`](./migrations/0001_timescale_aggregates.sql) 转为 hypertable 并创建持续聚合。索引删改、columnstore/压缩和 retention 属于 P1-T4b，不在 `0001` 提前实现。

## 执行方式

首次使用空 Compose 数据卷时，镜像初始化流程按顺序执行：

1. TimescaleDB 镜像自带初始化和调优；
2. `010-bootstrap-databases.sh` 创建竞品 database，并为两库安装扩展；
3. `020-apply-baseline.sh` 执行单一 PG baseline；
4. `030-apply-timescale-aggregates.sh` 在主营库执行 `0001` Timescale 升级。

```bash
cp .env.neo.example .env.neo
corepack pnpm db:up
corepack pnpm db:status
```

已有数据卷不会重新运行 `/docker-entrypoint-initdb.d`。已有库先应用 baseline（仅限仍为空且需要补基线的环境），再在维护窗口单独升级 Timescale：

```bash
corepack pnpm db:baseline
corepack pnpm db:upgrade:timescale
corepack pnpm --filter db test:integration
```

不得对含业务数据的库重新执行 `db:baseline`；这类环境只执行经预演的 `db:upgrade:timescale`。外部实例可用 `psql -X -v ON_ERROR_STOP=1 --file packages/db/migrations/0001_timescale_aggregates.sql` 连接主营 database 执行同一升级。

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
- `monitor_history_agg_v2`、`monitor_history_agg_dim_v2`、`monitor_history_agg_variant_group_v2` 只是只读兼容投影，应用不得向它们或 CAGG 写入；
- 三张 Legacy agg 表、`analytics_refresh_watermark` 和 `monitor_history_status_interval` 均保留。状态区间不是聚合语义，不转为 CAGG。

自动刷新策略为：hour `[now-49h, now-1h)` 每 10 分钟、day `[now-32d, now-1d)` 每小时、month `[now-25mo, now-1mo)` 每天；调度 timezone 固定 `Asia/Shanghai`。边界之外的历史数据和已经物化 bucket 内的迟到数据必须通过显式窗口重刷。

### 有界历史回填与正确性 Gate

先把同一冻结 MySQL 快照迁入 PG，让三张 Legacy agg 表成为对照源；再配置完整月边界的半开区间并运行：

```bash
corepack pnpm db:migrate:data
corepack pnpm db:timescale:aggregate:gate
```

Gate 使用 `DATABASE_URL`，并从根目录依次读取 `.env.migration`、`.env.neo`、`.env`。变量如下：

| 变量 | 说明 |
| --- | --- |
| `TIMESCALE_AGG_WINDOW_START` | 必填，本地业务时间月初，如 `2026-01-01 00:00:00` |
| `TIMESCALE_AGG_WINDOW_END` | 必填，排他月初边界；必须晚于 start，跨度不超过 120 个月 |
| `TIMESCALE_AGG_REFRESH` | 是否先手工刷新全部 9 个 CAGG，默认 `true`；只检查既有物化结果时才设 `false` |
| `TIMESCALE_AGG_PAGE_SIZE` | 摘要扫描页大小，100–5000，默认 1000 |
| `TIMESCALE_AGG_REPORT_PATH` | JSON 报告，默认 `artifacts/timescale-aggregate/report.json` |

月初边界确保 hour/day/month bucket 均完整。刷新使用 `[start,end)` 同一窗口；Timescale 只刷新完整落在窗口内的 bucket。Gate 在一个 `REPEATABLE READ READ ONLY` 快照内比较 9 组 Legacy/CAGG 的有序分组集合和全部业务值摘要，覆盖 ASIN fallback、空 site/brand、变体名 fallback、broken/peak 及 first/last check time。成功报告必须包含九组完全一致证据；任一差异或运行错误均返回非零。报告只含行数和 SHA-256 摘要，不含原始业务行或连接串。

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

MySQL 索引名只需在单表内唯一，PG 索引名在同一 schema 内必须唯一，因此通用的 `idx_country` 等名称统一加表名前缀；索引列序与排序方向保持不变。Legacy 中已经存在的重复索引仍在 P1-T2 原样表达，P1-T4 的索引策略评审再决定是否删除。

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
