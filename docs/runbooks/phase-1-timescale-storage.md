# Phase 1 Timescale 索引、列存与保留策略 Runbook

## 适用范围与不可逆边界

本手册只处理 P1-T4b：`monitor_history` 索引收敛、9 个 CAGG 的索引、TimescaleDB 2.29.2 Hypercore columnstore policy，以及可选的原始历史 retention。它不授权删除 Legacy MySQL；Phase 1 全程保留冻结的 MySQL 只读库作为回切和已删除历史恢复来源。

Retention 默认关闭，Compose 新卷初始化也不会把 `TIMESCALE_RETENTION_DAYS` 转发给 `040` 脚本。只有业务已经给出保留上限、完整备份已验证可恢复、CAGG 历史 Gate 已通过时，才允许通过显式升级命令设置该变量；值不得小于 800 天，因此始终晚于 25 个月 month CAGG 刷新/回填窗口。Retention 一旦实际删除 chunk，PG 内回滚脚本无法恢复数据，只能从备份或只读 MySQL 重建。

## 上线前 Gate

1. 使用与生产相同的 PostgreSQL 16、精确 TimescaleDB `2.29.2` 和同量级脱敏快照预演。
2. 先完成 `0000` baseline、`0001` CAGG 升级、完整历史刷新与九组聚合正确性 Gate。
3. 记录 `timescaledb_information.jobs`、`timescaledb_information.chunks`、数据库总大小、最大 chunk、写入 P95 和分析 P95 基线。
4. 执行完整 Integration；下载 `timescale-performance-<run_id>` artifact，确认 7 份执行计划、9 个 CAGG 的 fixture chunk 均已转入 columnstore、12 组摘要一致、每组 CAGG P95 至少快 3 倍、列存晚到写入与 10 批共 2500 行持续写入期间的分析读取通过。
5. 检查没有长事务或 DDL，确认 30 秒锁等待失败会被监控捕获。`transaction_per_chunk` 降低索引构建的长事务风险，但每个 chunk 仍会短时持锁。CAGG catalog 必须是 30 个受管复合索引加 9 个 Timescale 单时间索引，不能以总数相同掩盖集合漂移。

```bash
corepack pnpm test:contracts
corepack pnpm --filter db test
corepack pnpm --filter db test:integration
```

## 部署

本地 Compose 或使用同一挂载结构的实例：

```bash
corepack pnpm db:upgrade:timescale-storage
```

外部实例默认不配置 retention：

```bash
PGOPTIONS="-casin_monitor.monitor_history_retention_days=" \
  psql -X -v ON_ERROR_STOP=1 \
  --dbname "$DATABASE_URL" \
  --file packages/db/migrations/0002_timescale_storage_policies.sql
```

明确审批 800 天或更长 retention 后，首次和后续重复执行都必须传入相同值：

```bash
TIMESCALE_RETENTION_DAYS=800 corepack pnpm db:upgrade:timescale-storage
```

脚本会拒绝版本不符、9 个 CAGG 不完整、已存在策略参数不一致、非法 retention、索引集合异常以及 postflight 不精确的环境。不要修改已部署迁移绕过检查；修复 catalog 漂移应新增迁移或先按本手册恢复到受管状态。

## 上线后验证与观测

```sql
SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'monitor_history'
ORDER BY indexname;

SELECT job_id, application_name, proc_name, schedule_interval,
       scheduled, last_run_status, next_start, config
FROM timescaledb_information.jobs
WHERE proc_name IN (
  'policy_refresh_continuous_aggregate',
  'policy_compression',
  'policy_retention'
)
ORDER BY proc_name, application_name;

SELECT hypertable_name, COUNT(*) AS chunks,
       COUNT(*) FILTER (WHERE is_compressed) AS columnstore_chunks
FROM timescaledb_information.chunks
GROUP BY hypertable_name
ORDER BY hypertable_name;
```

连续观察至少一个 hour、day 调度周期：job 不得出现失败/重试堆积；监控原始写入和分析查询 P50/P90/P95、shared read、磁盘增长、WAL、autovacuum、chunk 数和 columnstore 转换时长。生产计划器必须用默认参数复跑关键 `EXPLAIN (ANALYZE, BUFFERS)`；CI 的 `enable_seqscan=off` 只证明索引可用。

## 暂停、恢复与手工处理

事故处置先暂停具体 job，不删除策略：

```sql
SELECT alter_job(<job_id>, scheduled => false);
SELECT alter_job(<job_id>, scheduled => true);
```

手工把单个 chunk 移入/移出 columnstore：

```sql
CALL convert_to_columnstore('_timescaledb_internal.<chunk_name>'::regclass);
CALL convert_to_rowstore('_timescaledb_internal.<chunk_name>'::regclass);
```

columnstore chunk 接收迟到写入后，可在低峰重排合并：

```sql
CALL convert_to_columnstore(
  '_timescaledb_internal.<chunk_name>'::regclass,
  recompress => true
);
```

任何手工刷新都使用完整 bucket 半开窗口；刷新成功、九组正确性 Gate 和性能 Gate 重新通过后，才能恢复策略或放量。

## 回滚

### Retention 尚未删除数据

1. 冻结 Neo 写入，保留 MySQL 只读，暂停受影响 jobs。
2. 创建 PG 备份和 catalog 快照。
3. 在维护窗口执行 [`0002_timescale_storage_policies.rollback.sql`](../../packages/db/migrations/0002_timescale_storage_policies.rollback.sql)。它移除 retention/columnstore policy，把已转换 chunk 还原 rowstore，恢复 18 个 Legacy 索引，并删除 P1-T4b 新索引；9 个 CAGG、原始表和业务数据不会被删除。
4. 复跑 Legacy 查询、写入和聚合对拍，再回切应用版本。

### Retention 已删除数据或 PG 不可用

不要声称 SQL 回滚能找回 chunk。将写流量切回已保留的 Legacy MySQL，恢复迁移前 PG 备份或创建新 PG，重新运行 P1-T2/P1-T3 数据迁移与完整历史/CAGG Gate。核对缺失时间窗为零后才允许重新切换。

若只需要紧急停止删除而不改索引/列存：

```sql
SELECT remove_retention_policy(
  'public.monitor_history'::regclass,
  if_exists => true
);
```

回滚和重新部署都必须保留执行时间、操作者、备份标识、策略 catalog、验证命令与结果，附到对应 Issue/PR 或事故记录。
