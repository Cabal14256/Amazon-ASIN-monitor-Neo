# P2 ASIN 与变体组更新时间策略

## 升级顺序与范围

在最终 Legacy 冻结快照导入、P1 对拍和 `0003_auth_maintenance.sql` 完成后，对主营 PostgreSQL 执行 `0004_asin_timestamp_policy.sql`。本次仅替换 `variant_groups` 与 `asins` 的更新时间触发器；其他表、竞品 database、Legacy MySQL 和历史记录保持原样。竞品写接口迁移时需要单独评估其时间策略。

Compose 使用 `corepack pnpm db:upgrade:asin-timestamp-policy`；已有容器新增挂载后，先执行 `corepack pnpm db:up` 更新容器配置。外部环境使用受控连接执行 `psql -X -v ON_ERROR_STOP=1 --dbname <主营库> --file packages/db/migrations/0004_asin_timestamp_policy.sql`，不在日志或命令示例中放入凭据。

新卷自动初始化仍止于 `0002`，不自动跨越最终数据导入 gate。原始 `0000` 不修改，ETL 的精确表清单与目标重置保护不放宽。升级顺序是部署要求；脚本不会自行证明生产冻结或对拍已经完成。Integration 先运行基线、ETL、Timescale 性能测试，再依次重复应用 `0003` 和 `0004`。

## 时间行为

原始触发器无条件使用事务开始时间覆盖 `update_time`。这会丢失应用明确指定的值，并允许较早开始、较晚取得锁的事务写回较早的时间。新策略区分以下情况：

| 更新方式 | 结果 |
| --- | --- |
| 默认模式，显式时间与原值不同，包括 NULL | 保留指定值 |
| 默认模式，其他字段确实变化，时间与原值相同 | 在取得行锁后取 `clock_timestamp() AT TIME ZONE 'Asia/Shanghai'` |
| 默认模式，整行无变化 | 保留原时间，包括 NULL |
| 事务内显式管理模式 | 每次更新完整保留应用传入的时间，包括保持原值或 NULL |
| 非空且不支持的模式 | 固定错误，事务失败 |

`statement_timestamp()` 同样可能早于行锁等待，所以默认触发器使用执行到该行时的时钟。应用如果先显式锁住父组/ASIN，再执行更新，可以使用锁后的语句时间。[PostgreSQL 日期时间函数说明](https://www.postgresql.org/docs/16/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT)解释了事务时间、语句时间与实际时钟的区别。此策略不对抗操作系统时钟回拨，也不禁止调用方有意保存历史时间。

## 写仓储接入

共享函数 `prepareAsinTimestampWrites(db, ensureOpen)` 必须在受截止时间保护的独占事务中、任何业务写入之前调用。它先持有两张业务表的兼容 `ROW EXCLUSIVE` 表锁，再检查当前 schema 两个触发器的名称、启用状态、事件/行级类型、无列过滤/WHEN/参数、同 schema 函数与版本标记，以及 `session_replication_role=origin`。缺失或不匹配抛出固定 `AsinTimestampPolicyError`；后续写接口应返回 503，不能在旧策略下继续写。

探针通过后用 `set_config(..., true)` 开启 `asin_monitor.timestamp_mode=explicit`，在提交或回滚后自动复位。调用方因此负责该事务中所有 ASIN/组更新的 `update_time`；需明确区分业务修改、父组触碰与监控保留原时间。不得在自动提交连接上单独调用此函数，也不得设置持久连接级模式。两个表锁可与并发业务写入兼容，阻止触发器 DDL/回滚插入探针与提交之间；行锁仍由业务仓储按父组 ID 排序取得。

版本探针用于检测部署遗漏与正常配置漂移，不是对抗可任意修改函数体的数据库管理员。函数升级须使用脚本中的表锁，应用账号不应任意改函数、触发器或复制模式。该批提供接入原语，五个写接口在 Issue #85 中接入；现有两个查询接口不要求这项写策略。

## 回滚与验证

先停止或回退依赖本策略的 ASIN 写入，再执行 `psql -X -v ON_ERROR_STOP=1 --dbname <主营库> --file packages/db/migrations/0004_asin_timestamp_policy.rollback.sql`。脚本将同名触发器恢复为原始函数，再移除专用函数；不重写历史时间。升级与回滚都在单一事务中，表锁等待截止 5 秒、SQL 截止 30 秒；失败整体回滚，可重复执行。回滚后恢复旧触发器行为，故必须先停止依赖的新写入。

真实 PostgreSQL 测试使用随机私有 schema，显式安装从 `0000` 提取的原始函数和触发器，再验证旧问题、新语义、NULL/微秒/UTC 连接、两张表的真实并发行锁、事务模式复位、策略失效拒绝、DDL 与业务事务互斥、重复升级/回滚和失败原子性。`LIKE INCLUDING ALL` 不会复制触发器，后续写接口 fixture 必须同样安装实际策略。当前不执行生产升级或数据修改。
