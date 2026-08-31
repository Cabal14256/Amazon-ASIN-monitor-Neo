# MySQL 8 → PostgreSQL 16 双库数据迁移与对拍

## 适用范围与策略

P1-T3 采用“周期性全量预演 + 切换窗口写冻结后的最终全量同步”。当前数据规模不默认引入 Debezium、binlog CDC 或应用双写；如果后续实测停机窗口不能满足目标，再另立 Issue 评估增量链路。P1-T4a 之后，正式 PG 目标必须先应用 baseline 和 `0001_timescale_aggregates.sql`，数据同步完成后再运行九组持续聚合对拍 Gate。

迁移同时覆盖主营 21 张表和竞品 4 张表。MySQL 始终作为只读源，每个源 database 使用独立的 `REPEATABLE READ` 一致性快照；PostgreSQL 两个目标 database 分别在事务中重置、导入并校验。最终同步必须先冻结两个 MySQL database 的写入，避免两个独立快照之间产生跨库时间差。

### pgloader 评估

pgloader 适合快速验证 MySQL→PG 的基础类型兼容性，但不作为本项目的正式迁移执行器，原因如下：

- 需要同时约束 21 + 4 张表的精确 schema、FK 安全顺序和两个独立 database；
- MySQL `TINYINT(1)`、JSON 文本、D8 `DATETIME`、PG generated columns 与 `GENERATED ALWAYS AS IDENTITY` 需要确定性转换；
- 必须跳过目标生成列、保留 identity 值并在导入后修正 sequence；
- 阶段 gate 要求统一产出行数、确定性字段样本和关键业务查询的机器可校验报告。

因此正式路径使用仓库内的 Node/TypeScript ETL。pgloader 只可在隔离环境辅助预估吞吐或发现源数据类型异常，其输出不能替代本工具的对拍报告。

## 安全边界

迁移会对两个 PG 目标库的全部 21 + 4 张业务表执行一次显式的 `TRUNCATE ... RESTART IDENTITY`，并在同一主营库事务中清空精确注册的 9 个 CAGG 内部物化 hypertable；不会使用 `CASCADE` 清空注册表之外的跨 schema 引用表。若存在这类外部引用，重置会安全失败，必须先确认归属并解除引用，不能临时扩大清空范围。以下条件缺一不可：

1. 两个目标库已应用 [`migrations/0000_baseline.sql`](./migrations/0000_baseline.sql)，主营库已应用 [`migrations/0001_timescale_aggregates.sql`](./migrations/0001_timescale_aggregates.sql)，且都不是当前生产写库；
2. 已完成可恢复备份，并记录恢复命令和负责人；
3. `.env.migration` 显式设置 `MIGRATION_ALLOW_TARGET_RESET=true`；
4. MySQL 账号仅对两个源库拥有 `SELECT` 权限；
5. 两个源库的 25 张表均使用 InnoDB；最终同步时，Legacy API、调度器和 Worker 已停止产生数据库写入，旧 Bull 队列已 drain。

未显式授权重置或运行时配置越界时，工具在建立数据库连接之前失败，不会修改目标库。开始目标重置前，工具还会校验源表/列集合，以及目标表、精确列类型与可空性、保留字符串字面量的默认值指纹、identity/生成表达式、identity sequence 类型/步长/边界/cache/cycle、主外键（包括被引用的 `public` schema）、唯一/CHECK 约束定义、索引方法/列或表达式/谓词，以及更新时间函数和触发器必须与迁移注册表完全一致。目标事务还会把 `search_path` 固定为 `public, pg_catalog`，因此角色或 URL 的自定义 schema 不会截获迁移 DML。源库只额外容许两个现有维护脚本按固定时间戳格式生成的 `mh*_bak_YYYYMMDD_HHMMSS` 和 `monitor_history_*_bak_YYYYMMDD_HHMMSS` 持久化备份表；其他未知表仍会触发 schema mismatch，备份表本身不会迁移。

两个 PG database 无法共享普通本地事务：工具先完成两库导入与对拍，再逐库提交。极端情况下第一个目标提交后、第二个目标提交失败，报告会返回 `TARGET_COMMIT_PARTIAL`；若已发送 `COMMIT` 但连接在确认响应前断开，则返回 `TARGET_COMMIT_INDETERMINATE`。两种情况都不得假设事务已回滚或直接放量，应先核验、恢复或再次重置两个目标，再从仍冻结的 MySQL 重新执行。

## 配置

从仓库根创建仅供本机使用的配置文件：

```bash
cp .env.migration.example .env.migration
```

PowerShell：

```powershell
Copy-Item .env.migration.example .env.migration
```

关键变量：

| 变量 | 说明 |
| --- | --- |
| `MIGRATION_MYSQL_HOST/PORT/USER/PASSWORD` | MySQL 8 只读源连接 |
| `MIGRATION_MYSQL_PRIMARY_DATABASE` | 主营源库，默认 `amazon_asin_monitor` |
| `MIGRATION_MYSQL_COMPETITOR_DATABASE` | 竞品源库，默认 `amazon_competitor_monitor` |
| `DATABASE_URL` | PG 主营目标连接串 |
| `COMPETITOR_DATABASE_URL` | PG 竞品目标连接串；必须与主营目标的主机、端口、库名组合不同，同名库可位于不同主机 |
| `MIGRATION_ALLOW_TARGET_RESET` | 破坏性目标重置授权；仅在本次运行确认后设为 `true` |
| `MIGRATION_BATCH_SIZE` | keyset 批次，1–1000，默认 500 |
| `MIGRATION_SAMPLE_SIZE` | 每表确定性样本数，0–100，默认 20 |
| `MIGRATION_REPORT_PATH` | JSON 报告路径，默认 `artifacts/data-migration/report.json` |
| `LOG_LEVEL` | 开发可用 `DEBUG/INFO`，生产演练建议 `INFO`；日志始终脱敏 |

`.env.migration` 与 `artifacts/` 已被 Git 忽略。不要把密码、Token、Cookie、连接串或真实业务行粘贴到 Issue、PR、日志和报告中。

## 执行与报告

先安装根 lockfile 中的依赖，完成 PG baseline，并在维护窗口把主营 `monitor_history` 升级为 hypertable，再运行：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm db:upgrade:timescale
corepack pnpm db:migrate:data
```

命令会构建 `config`、`contracts` 与 `db`，随后执行迁移。即使 pnpm lifecycle 把进程工作目录切到 `packages/db`，CLI 也会向上解析含 `pnpm-workspace.yaml` 的仓库根目录，并从根目录读取环境文件和写入默认报告。每张表使用主键 keyset 分页，不使用随数据量退化的 `OFFSET`；三张聚合表的 `granularity` keyset 与对拍查询显式使用 MySQL ENUM 声明顺序 `hour → day → month`，避免字符串排序在跨粒度批次漏行。源数据转换规则包括：

- `TINYINT(1)` → `boolean`；
- JSON 文本 → 由任意精度数值解析器无损转换的 `jsonb`，空文本 → `NULL`；包括超出 JavaScript 安全整数范围的 JSON 数值也不会先经过 `number`；
- `DATETIME` 以 D8 `Asia/Shanghai` 的无时区文本传递；
- bigint 全程以十进制字符串传递，避免 JavaScript 精度丢失；
- PG generated columns 不写入，由目标表达式生成；
- identity 保留源值，导入后用事务化 `ALTER SEQUENCE ... RESTART WITH` 把下一值调整为 MySQL `AUTO_INCREMENT` 元数据中的实际下一值；即使高 ID 已删除或计数器被显式推进也不会复用旧编号，提交前普通失败也会随目标事务一起恢复原 sequence 状态。

`monitor_history` 是一个特殊但显式验证的目标：MySQL 源端仍以唯一 `id` 做 keyset，PG 端则验证 `(check_time,id)` 复合主键和唯一 Timescale 时间维。目标重置、计数、抽样和业务查询会覆盖 catalog 中属于该 hypertable 的全部 chunk；未知继承子表、伪造 chunk 或 schema 漂移均在重置前拒绝。其余普通表仍使用 `ONLY` 边界，不能借继承结构把额外数据混入迁移证据。

成功报告符合 `packages/contracts` 的 `dataMigrationReportSchema`，仅包含：

- 两库及每表的源/目标行数；
- 基于主键哈希排名的确定性字段样本数量和 SHA-256 摘要；通过报告必须包含 `min(源行数, MIGRATION_SAMPLE_SIZE)` 个样本；
- 7 组关键业务查询的行数和 SHA-256 摘要；
- 批次、耗时、运行 ID 与最终状态。

报告不包含原始字段、账号、连接串或异常 payload。失败报告只记录稳定的错误 `code` 与 `scope`。成功契约要求两库均为 `passed`，并且包含唯一且完整的 25 张表与 7 组业务查询证据；所有行数、样本摘要和业务摘要必须一致。工具会在建立数据库连接前探测报告目录是否可写；若双库已经提交后最终成功报告仍写入失败，退出日志和尽力写入的失败报告使用 `POST_COMMIT_REPORT_WRITE_FAILED` / `report.write`，表示必须先核验两个目标，不能把它当作普通导入失败而直接重跑。

## 预演、最终同步与回滚

每次预演使用从生产备份恢复出的隔离 MySQL 源和可丢弃的 PG 目标：

1. 记录源快照时间、两库大小、命令版本和报告路径；
2. 执行一次迁移，保留脱敏 JSON 报告；
3. 立即再执行一次，确认重置与导入可重复，行数和摘要证据不变；
4. 记录总耗时，并按最近完整预演耗时预留切换窗口；
5. 在同一个冻结快照结果上执行持续聚合有界刷新与正确性 Gate，保存九组脱敏摘要报告；
6. P1-T4b 再叠加索引/columnstore/retention 与 ≥3× 性能 gate。

持续聚合 Gate 的完整变量和报告语义见 [`MIGRATION.md`](./MIGRATION.md#有界历史回填与正确性-gate)。典型顺序为：

```bash
corepack pnpm db:migrate:data
corepack pnpm db:timescale:aggregate:gate
```

两条命令都必须返回 0，且 `artifacts/data-migration/report.json` 和 `artifacts/timescale-aggregate/report.json` 均通过各自 contracts schema。聚合 Gate 的完整月边界窗口必须覆盖全部已迁移的合格原始历史和三张 Legacy agg 表；它会先复核 9 个 CAGG 的声明指纹、marker 和 refresh job，再以 `force=true` 刷新全部 materialized-only CAGG，并在只读一致性快照中按 PAD SPACE + Legacy collation 比较三张 Legacy agg 表并要求 `coverage.rowsOutsideWindow=0`。`refresh=false` 仅用于诊断且必定非零；差异、全空或覆盖不全的报告也不可被人工豁免为“近似一致”，而应修复语义或刷新边界后整体重跑。

最终同步按以下顺序执行：公告维护窗口 → 停止调度器和写入 Worker → drain 旧 Bull 队列 → 冻结 Legacy 写流量 → 确认 MySQL 无新增写入 → 备份 PG → 运行数据迁移 → 刷新并对拍 9 个 CAGG → 审核两份报告 → 执行应用 smoke test。两份报告通过前不切流；切流后 MySQL 按阶段 1 回滚 runbook 保持只读、可回切且至少保留一个观察周期，不得归档下线。

若迁移或 smoke test 失败：

- 不切换流量，保持或恢复 Legacy 对 MySQL 的连接；
- 普通失败会回滚尚未提交的 PG 事务，可修复根因后从头重跑；
- `TARGET_COMMIT_PARTIAL` 或 `TARGET_COMMIT_INDETERMINATE` 必须先核验两个 PG 目标，再恢复/重置后整体重跑；
- 若已尝试放量，先停止 Neo 写入，再按切换前备份恢复 PG，并把应用路由切回 MySQL；
- 保存脱敏报告和时间线，另立 Issue 处理，不在现场修改冻结的 Legacy migration SQL。

阶段 1 的判定矩阵、CAGG 重建及恢复普通 PG 表边界见 [`../../docs/runbooks/phase-1-database-rollback.md`](../../docs/runbooks/phase-1-database-rollback.md)。
