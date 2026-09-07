# P2 / D4 会话清理与审计归档数据层

## 迁移顺序

本批提供 PostgreSQL 数据原语与查询兼容。实际 Worker Processor、每日/每月调度、单调度器锁及停止恢复步骤见[Worker 运行说明](./phase-2-auth-maintenance-worker.md)；部署前须先完成下列迁移顺序。

1. 保留 Legacy，按 P1 流程完成最终冻结快照导入和对拍。
2. 在主营 PostgreSQL database 执行 `0003_auth_maintenance.sql`，再部署使用新审计查询视图的 Neo API。新视图是本版本审计查询的数据库前提。
3. Worker 仅在 PostgreSQL 权威源下接入实际调度，并按独立运行说明验收启用。

Compose 使用显式命令 `corepack pnpm db:upgrade:auth-maintenance`。新卷的自动初始化仍止于 `0002`；已有容器新增挂载后先执行 `corepack pnpm db:up` 重建容器配置，再运行升级。外部环境用 `psql -X -v ON_ERROR_STOP=1 --dbname <主营库> --file packages/db/migrations/0003_auth_maintenance.sql`，使用现有受控连接配置，不把凭据写入日志。

Legacy 全量 ETL 精确校验目标表清单，`0003` 增加归档表后会在重置数据前拒绝再次导入，连空归档表也会被拒绝；保留这项保护。预演需要重新导入时，应使用新的隔离目标库。已经接收 Neo 业务的库不应再次用 Legacy 快照覆盖；数据恢复须走备份与恢复流程。Integration 同样先运行原基线/ETL/性能测试，再升级 `0003` 并测试 D4 与 API。

## 审计证据保留

- `audit_logs` 继续接收新记录；`audit_logs_archive` 按 `create_time` 月份做范围分区，保留相同的 15 个字段、原始 bigint ID、JSON、NULL 与时间精度，没有自动删除归档的策略。
- `audit_logs_all` 通过 `UNION ALL` 提供统一只读入口。列表、详情、操作统计和资源统计继续覆盖全部历史，接口权限、参数、排序与响应契约不变。
- 同一事务选择候选、删除热记录并插入归档。重复运行不重复移动，插入/分区/超时失败回滚整批；并发只读快照始终能读到一个版本的记录。
- 分区先作为独立表创建，然后 `ATTACH PARTITION`，避免直接 `CREATE TABLE ... PARTITION OF` 对父表要求的排他锁阻塞审计读快照。分区范围只由数据库年月经严格数字校验后构造，不接受任务中的表名或 SQL。[PostgreSQL 16 分区说明](https://www.postgresql.org/docs/16/ddl-partitioning.html)说明了两种操作的锁要求及唯一键必须包含分区键的限制。
- 分区主键为 `(create_time,id)`，另有 ID 及常用筛选列索引。应用写入只使用热表 identity；归档仓储遇到热/冷重复 ID 会中止，避免外部重导造成跨月重复。数据库管理员不得绕过此约束直接写归档或复用历史 ID。
- 审计查询保留原有安全整数检查。归档在 SQL 中搬运 bigint，不经 JS 转换；超过 JS 安全整数的 ID 仍完整保存，但公开 API 会拒绝无法安全表示的结果。

## 有界批处理

- `cleanupSessions(limit, now)` 仅删除 `expires_at IS NOT NULL AND expires_at <= now` 的会话，保留 NULL 期限和未来会话。状态本身不决定是否删除。
- `archiveAuditLogs(retentionDays, limit, now)` 默认 90 天，只移动严格早于截止的审计记录。截止当天的精确时刻仍保留，NULL 时间留在热表；D8 时间统一按 UTC+8 解释，连接时区为 UTC 也不偏移。
- 每批最多 1000 条、每次归档只处理最早月份；返回 `processed/hasMore/busy`，后续 Worker 需要有界续跑处理余量，不能把一次调用等同于全部清理完成。
- 每类操作使用独立的 PostgreSQL 事务 advisory lock，冲突立即返回 busy。候选行使用 `FOR UPDATE SKIP LOCKED`，跳过业务正在修改的行；`hasMore=true` 可包含暂时锁住的记录。
- 沿用连接池获取超时、2 秒独占事务总截止与 1.5 秒单 SQL 截止，失败销毁连接且不得迟到提交。分区创建需要业务 DB 角色具备当前 schema 的 CREATE 和归档表所有者权限；权限不足时整批失败，不删除热数据。
- 保留天数限 1–3650，时间限可表示的正四位年份，分区月份限 0001-01 到 9999-11。历史异常值会停止归档，需查明来源后修复，不能跳过并丢弃记录。

## 回滚与验证

回滚先停止维护任务和应用写入，回退依赖新视图的查询代码，再用主营管理连接执行 `0003_auth_maintenance.rollback.sql`。脚本持有表锁，将所有归档原样恢复到热表并逐行核对；ID 冲突且字段不同会整笔失败并保留归档。核对完成才移除视图和归档表，identity 高水位只推进不降低。应预演容量和 10 分钟脚本截止，超时会回滚数据搬迁；序列推进本身不回滚，产生空洞不影响 ID 唯一性。

已清理的过期 Session 不会由 DDL 回滚恢复；需要恢复数据时使用事前备份，不复活已经失效的登录会话。当前批次不对生产执行迁移、归档或清理。

本地运行 DB 测试和构建；真实 PostgreSQL 的 10 项隔离测试覆盖到期边界、行锁、批量、归档字段及查询等价、插入失败、互斥与并发、跨连接读快照、重复 ID、完整回滚/超大 ID 和超时恢复。私有 schema 以随机 ID 命名，测试结束仅清理该 schema。完整 CI 同时继续验证 Legacy 与所有 Neo 模块，根契约检查请求/导出 URL 的 `/api` 去重。
