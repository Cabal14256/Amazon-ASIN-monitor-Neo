# `monitor_history` 索引终审（P1-T4b）

## 结论与证据边界

`0000_baseline.sql` 先忠实平移 Legacy 的 19 个索引，`0002_timescale_storage_policies.sql` 再把它们收敛为 7 个运维索引，并为 9 个持续聚合建立 30 个受管 B-tree 复合索引；每个 CAGG 的背景 hypertable 还保留 Timescale 创建的 1 个 `time_slot` B-tree，最终精确 catalog 为 39 个。此处的“保留/删除”不是仅凭列前缀判断：Integration CI 会在 72 万行、60 天、7 天 chunk 的确定性高频监控数据上执行真实的 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`，要求 7 个原始表目标索引分别服务主键回查、游标分页、状态刷新和待通知扫描，并要求 hour/day/month 下 country/site/brand 共 9 个 CAGG 维度索引分别服务直接维度过滤；同时对 12 组冷热窗口、筛选条件以及 hour/day/month 查询做原始表与 CAGG 正确性对拍和 P95 Gate。

CI 为了稳定证明索引可用，会在单个只读事务中设置 `enable_seqscan=off`。这不伪装成本评估结论：报告仍保存实际 plan 节点、命中的索引、执行时间和 shared buffers；生产上线前还必须在同量级快照上用默认 planner 参数复跑，并将报告作为审批证据。报告位于 CI artifact `timescale-performance-<run_id>/integration-report.json`，只含合成数据规模、摘要、plan 元数据和耗时，不含业务行、连接串或凭据。

## 19 个 Legacy 索引逐项决策

| Legacy 索引 | 决策 | 替代/理由 |
| --- | --- | --- |
| `idx_monitor_history_variant_group_id` | 删除 | 被 `(variant_group_id, check_time DESC, id DESC)` 覆盖，支持变体组时间窗与稳定游标。 |
| `idx_monitor_history_asin_id` | 删除 | 被 `(asin_id, country, check_time DESC, id DESC)` 覆盖；当前运维查询总带国家。 |
| `idx_monitor_history_asin_code` | 删除 | 被 `(asin_code, country, check_time DESC, id DESC)` 覆盖。 |
| `idx_monitor_history_check_time` | 删除 | 复合主键 `(check_time, id)` 已提供相同左前缀；Timescale chunk pruning 先缩小扫描范围。 |
| `idx_monitor_history_country` | 删除 | 被 `(country, check_time DESC, id DESC)` 覆盖。 |
| `idx_monitor_history_country_check_time` | 删除 | 同上，新索引补入 `id` 以消除同秒记录分页漂移。 |
| `idx_monitor_history_variant_group_check_time_broken` | 删除 | `is_broken` 的低基数尾列不能抵消写放大；时间列表走变体组索引，待通知走部分索引。 |
| `idx_monitor_history_country_check_time_broken` | 删除 | 国家时间索引负责通用列表；broken 专用路径由更小的部分索引负责。 |
| `idx_monitor_history_check_time_country_broken` | 删除 | 主键、chunk pruning 与国家时间索引已覆盖真实访问路径。 |
| `idx_monitor_history_asin_code_country_check_time` | 替换 | 新索引保持前三列并补 `id DESC`，支持确定性 cursor。 |
| `idx_monitor_history_country_time_broken_asin` | 删除 | 列序无法高效服务 ASIN 精确查询；由 ASIN-ID/国家/时间索引替代。 |
| `idx_monitor_history_asin_country_check_time_broken` | 替换 | 保留前三列并补 `id DESC`；移除低选择性 `is_broken` 尾列。 |
| `idx_monitor_history_country_hour_site_brand` | 删除 | hour 分析迁入 `monitor_history_cagg_dim_hour`。 |
| `idx_monitor_history_country_day_site_brand` | 删除 | day 分析迁入 `monitor_history_cagg_dim_day`。 |
| `idx_monitor_history_country_month_site_brand` | 删除 | month 分析迁入 `monitor_history_cagg_dim_month`。 |
| `idx_monitor_history_hour_country_asin` | 删除 | hour ASIN 分析迁入对应 CAGG。 |
| `idx_monitor_history_day_country_asin` | 删除 | day ASIN 分析迁入对应 CAGG。 |
| `idx_monitor_history_month_country_asin` | 删除 | month ASIN 分析迁入对应 CAGG。 |
| `idx_monitor_history_status_interval_refresh` | 保留 | 状态区间是顺序语义，不是可由 CAGG 替代的聚合；`(check_type, check_time, id)` 服务增量扫描。 |

最终新增 `idx_monitor_history_id_lookup`，因为 Timescale 主键必须包含时间分区键，而 MySQL 迁移、审计和回查仍存在只按 Legacy `id` 定位的路径；新增部分索引 `idx_monitor_history_notification_pending (country, check_time, id) WHERE is_broken=true AND notification_sent=false`，把高频写入承担的索引体积限制在真正待处理的数据上。

## CAGG 索引与 BRIN 决策

P1-T4a 在创建 CAGG 时显式设置 `timescaledb.create_group_indexes=false`，避免 Timescale 隐式决定 group-key 索引集合。P1-T4b 按每个分组键建立 `(key, time_slot)`：ASIN 每个粒度 2 个，dimension 每个粒度 4 个，variant-group 每个粒度 4 个，共 `(2 + 4 + 4) × 3 = 30` 个。Timescale 2.29.2 仍会为每个背景 hypertable 创建 1 个 `time_slot` B-tree 用于时间裁剪，因此 postflight 精确要求 30 个复合索引、9 个单时间索引、总计 39 个，并逐项校验受管名称、所属 CAGG、键顺序、ASC/DESC 与 NULL 排序、唯一性、谓词、key/include 数量、访问方法和 ready/valid 状态；总数相同也不能掩盖定义漂移。

本阶段不增加 BRIN。理由是原始表已按 7 天 chunk 做时间裁剪，主键以 `check_time` 开头，核心过滤还需要国家/ASIN/变体组等高选择性前缀；在当前数据量下再加 BRIN 只会增加写入与维护成本，并不能替代这些复合 B-tree。以下条件同时成立时再开独立 Issue 复评：单 chunk 大到默认时间扫描出现显著 shared-read 增长、相关性仍接近 1、`EXPLAIN ANALYZE` 证明 BRIN 的 P95/空间收益，并且写吞吐回归通过。

## 复核命令

```bash
corepack pnpm --filter db test
corepack pnpm --filter db test:integration
```

Integration 必须使用固定的 `timescale/timescaledb:2.29.2-pg16`。任何实际业务查询形状变化都应先更新性能 fixture 与期望索引，再修改迁移；不得通过保留“可能有用”的索引绕过证据 Gate。
