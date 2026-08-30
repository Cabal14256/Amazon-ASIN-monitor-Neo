# 阶段 1 数据库升级与回滚 Runbook

## 适用范围与不变量

本 Runbook 只覆盖 P1-T3/P1-T4 的 MySQL → PostgreSQL/TimescaleDB 数据迁移、`monitor_history` hypertable 升级、持续聚合回填与阶段 1 切换。索引、columnstore、retention 和 Neo 业务域切换由各自 Issue 的 runbook 补充。

任何时候都必须满足：

- 切流前，Legacy MySQL 是唯一权威写库；PG 是可重建的候选库。
- 最终同步开始后冻结 MySQL 写入，停止 Legacy/Neo 调度器和 Worker，并 drain 队列。
- 两份机器报告和 smoke test 通过前不把 Neo PG 路径开放为生产写路径。
- 切流后，MySQL 保持只读、禁止后台任务写入，并至少保留一个完整观察周期。观察期内不得删除、归档或覆盖它。
- 不允许同时把 MySQL 和 PG 都恢复为可写；这会产生无法由本 Runbook 自动合并的分叉。
- 报告、日志和备份标签不得包含密码、Token、Cookie、连接串或原始业务行。

## 变更前准备

负责人应在变更记录中填写：维护窗口、执行人、回滚决策人、MySQL 冻结时间、源快照标识、PG 备份标识、Git commit、Timescale 镜像版本、两个报告路径和应用路由恢复方式。

开始前完成：

1. 使用组织批准且已做恢复演练的 PostgreSQL/TimescaleDB 备份方案，对主营和竞品 PG database 取一致、可恢复的变更前备份。不要把 `pg_dump` 文件存在容器临时文件系统。
2. 从生产备份恢复出隔离环境，以同一 Git commit、固定 `timescale/timescaledb:2.29.2-pg16` 完整执行至少两次。
3. 确认最近一次同量级预演的迁移、hypertable 转换、9 个 CAGG 刷新与 Gate 总耗时小于维护窗口。
4. 确认 `.env.migration` 的目标是候选 PG，不是当前生产写库；仅在最终同步时短暂设置 `MIGRATION_ALLOW_TARGET_RESET=true`。
5. 确认切流期间写流量保持冻结，直到 smoke test 和回滚决策点结束。若业务要求在 smoke test 期间接受写入，必须另行设计增量回放，本 Runbook 不授权直接回切。

## 正常升级与放量 Gate

按顺序执行，任一步非零立即进入下面的判定矩阵：

```bash
corepack pnpm db:upgrade:timescale
corepack pnpm db:migrate:data
corepack pnpm db:timescale:aggregate:gate
```

审核证据：

- `artifacts/data-migration/report.json`：21 + 4 表、样本和关键业务查询均为 `passed`；
- `artifacts/timescale-aggregate/report.json`：固定 `[start,end)` 月边界内 9 组检查均为 `passed`；
- `monitor_history` 在 Timescale catalog 中仅有 `check_time` 一个时间维，interval 为 7 天，主键为 `(check_time,id)`；
- 9 个 CAGG 均为 `materialized_only`，9 个 refresh job 和 3 个只读兼容视图存在；
- API/Worker smoke test 通过，且维护窗口内仍无任何业务写入。

只有全部成立才能切换读流量；观察完成后再单独批准写流量。切流和解除写冻结必须是两个可审计步骤。

## 失败判定矩阵

| 状态 | 立即动作 | 允许的恢复路径 |
| --- | --- | --- |
| `0001` 在 `COMMIT` 前失败 | 保持 MySQL 服务；不要切流；保存脱敏错误码 | SQL 在单事务内执行，确认 catalog/PK 仍是升级前状态后修复并重跑；状态不明确则恢复变更前 PG 备份到替换实例 |
| 数据迁移失败且没有目标提交 | 保持 MySQL 冻结或恢复 Legacy；不要运行聚合 Gate | 修复源数据/配置/schema 后从头重跑完整数据迁移 |
| `TARGET_COMMIT_PARTIAL` / `TARGET_COMMIT_INDETERMINATE` | 不假设目标已回滚；禁止放量 | 分别核验两库，恢复或重新初始化两库，再从仍冻结的 MySQL 整体重跑 |
| 聚合 Gate 失败 | 不切流；三张 Legacy agg 表仍是对照源 | 核对窗口、刷新和语义；必要时按“只重建 CAGG”处理，再重跑 Gate |
| smoke test 失败且生产写流量仍冻结 | 停止 Neo API/Worker，恢复 Legacy 路由 | MySQL 快照未分叉，可直接恢复 Legacy 服务；PG 保留为故障分析副本 |
| 已解除写冻结后才失败 | 立即停止新的 Neo 写入并升级为事故 | 先导出并核对 PG 新增写入；由回滚决策人批准回放/补偿后才能回 MySQL，禁止盲目切回造成已确认写入丢失 |

失败报告不是放量证据；不得手改 JSON 的 `status`、摘要或错误码。修复后生成新的 `runId` 和完整报告。

## 只重建持续聚合

仅当 hypertable 基础数据和三张 Legacy agg 表已验证正确、问题限定在 CAGG 定义/物化状态时使用。该操作会暂时移除 Neo 聚合读模型，必须先停用 Neo 聚合读路径、确认 MySQL/Legacy 仍可服务并取得当前 PG 备份。

在主营 database 的受控 `psql` 会话执行以下事务；不要增加 `CASCADE`：

```sql
BEGIN;

SELECT remove_continuous_aggregate_policy(
  'public.monitor_history_cagg_asin_hour'::regclass, if_exists => true
);
SELECT remove_continuous_aggregate_policy(
  'public.monitor_history_cagg_asin_day'::regclass, if_exists => true
);
SELECT remove_continuous_aggregate_policy(
  'public.monitor_history_cagg_asin_month'::regclass, if_exists => true
);
SELECT remove_continuous_aggregate_policy(
  'public.monitor_history_cagg_dim_hour'::regclass, if_exists => true
);
SELECT remove_continuous_aggregate_policy(
  'public.monitor_history_cagg_dim_day'::regclass, if_exists => true
);
SELECT remove_continuous_aggregate_policy(
  'public.monitor_history_cagg_dim_month'::regclass, if_exists => true
);
SELECT remove_continuous_aggregate_policy(
  'public.monitor_history_cagg_variant_group_hour'::regclass, if_exists => true
);
SELECT remove_continuous_aggregate_policy(
  'public.monitor_history_cagg_variant_group_day'::regclass, if_exists => true
);
SELECT remove_continuous_aggregate_policy(
  'public.monitor_history_cagg_variant_group_month'::regclass, if_exists => true
);

DROP VIEW IF EXISTS
  public.monitor_history_agg_v2,
  public.monitor_history_agg_dim_v2,
  public.monitor_history_agg_variant_group_v2;

DROP MATERIALIZED VIEW IF EXISTS
  public.monitor_history_cagg_asin_hour,
  public.monitor_history_cagg_asin_day,
  public.monitor_history_cagg_asin_month,
  public.monitor_history_cagg_dim_hour,
  public.monitor_history_cagg_dim_day,
  public.monitor_history_cagg_dim_month,
  public.monitor_history_cagg_variant_group_hour,
  public.monitor_history_cagg_variant_group_day,
  public.monitor_history_cagg_variant_group_month;

COMMIT;
```

若对象集合已经部分缺失，不要在现场改写上述 SQL：恢复备份，或先在隔离副本复现并形成单独修复 Issue。完整删除成功后重新执行：

```bash
corepack pnpm db:upgrade:timescale
corepack pnpm db:timescale:aggregate:gate
```

`0001` 会识别已经存在且结构正确的 hypertable，重新创建 9 个 `WITH NO DATA` CAGG、3 个视图和 9 个 policy；Gate 负责显式历史回填和全量摘要对拍。新报告通过前不得恢复 Neo 聚合读路径。

## 恢复为普通 PostgreSQL 表

本项目不支持在承载数据的实例上就地把 hypertable 逆向改回普通表。Timescale chunk、复合主键、CAGG 和内部 catalog 是一个整体；手工移动 chunk 或删除扩展不属于授权回滚。

支持的路径只有：

1. **阶段 1 切流前**：丢弃候选 PG，创建替换 database，只应用 `0000_baseline.sql`，然后从仍冻结且权威的 MySQL 重跑 P1-T3 迁移。该普通表实例只用于退回 P1-T4 前状态，不会通过当前 P1-T4 迁移器的 hypertable schema Gate。
2. **恢复升级前 PG**：停止所有 PG 写入，把变更前、已验证可恢复的完整备份恢复到替换实例；验证普通 `monitor_history`、`id` 主键和两库报告后再切连接。优先恢复到替换实例，不覆盖故障现场。
3. **回到 Legacy MySQL**：仅在写流量从冻结后从未开放，或 PG 新写入已完成审计和补偿回放时执行。恢复 Legacy API/Worker 配置、确认单写并保持故障 PG 只读。

恢复后不得在同一个普通表 database 上运行当前 `db:migrate:data`，因为当前注册表要求 P1-T4 目标结构。若决定正式撤销 P1-T4，必须新建回退 Issue，同步回退迁移注册表、Drizzle 事实源、CI 和部署顺序。

## 收尾

成功放量或回滚后记录：最终路由、两库只读/读写状态、报告 `runId`、备份保留期限、未解决风险和后续 Issue。删除临时目标或备份必须走独立审批；本 Runbook 不授权删除生产 database、卷或 MySQL 兜底数据。
