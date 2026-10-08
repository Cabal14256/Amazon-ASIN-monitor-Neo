# Neo 定时监控契约、固定分批与私有账本基础

关联 Issue #204。本次为 #188 的执行与恢复、#189 的调度器提供可独立验证的基础：严格内部契约、稳定任务身份、Legacy 分批策略和双 PostgreSQL 账本。没有实现 Repository 状态转换、业务消费者、repeat job 或生产投递；现有手动任务继续使用各自的用户身份、权限与任务查询。

## 稳定身份与目录

- `plannedSlot` 是规范 UTC 分钟时间；`requestedAt` 是首次入队时间，重试不得刷新。完整任务摘要包括两者、TTL、国家、interval 与 batch。
- 稳定 Bull job ID 使用 domain、原 slot、country、batch；任务 UUIDv5 从该 ID 推导。`parseScheduledMonitorJob` 验证严格契约与确定性 UUID；后续 Repository 必须核对完整摘要，拒绝同一 UUID/slot 的 payload 替换。Zod schema 本身只验证 UUID 格式，消费者应使用完整解析函数。
- 首次任务严格超过 25 分钟才过期，等于边界仍可执行；手动任务不使用该规则。缺少可信时间的 scheduled 任务失败关闭。先使用规范的 `requestedAt`，否则只能使用实际 Bull 入队时间；此 helper 不授予重试更新时钟的权限。
- batch 为 epoch slot 的规范 modulo；组归属为原始 UTF-8 ID 的无符号 IEEE CRC32。不得 trim、改大小写或 Unicode normalize。契约 interval 限于 15/30/60 分钟，batch 数为 1–1000。
- 目录排序为 `create_time ASC NULLS FIRST,id COLLATE "C"`。原生文本保留六位微秒，不能经 ORM Date/getTime 排序；读取时使用 `to_char(create_time,'YYYY-MM-DD HH24:MI:SS.US')`。固定 ordinal 与组 ID 在同一任务内分别唯一。
- 账本限制一次目录为 1000 组、20000 成员、16 MiB JSON；结果上限 32 MiB。这些存储约束不等于冻结目录或业务恢复已经接线。

## 双库升级

`0016` 分别安装 `primary_scheduled_monitor_{runs,notifications,group_receipts}` 和 `competitor_scheduled_monitor_{runs,notifications,group_receipts}`。不包含 user/session 字段，不引用用户表。通知与组凭据的复合外键绑定原 task、完整 job digest 与 country；删除 run 只级联私有子表，保留业务历史。

主营库依赖 `0012_primary_monitor.sql`，竞品库依赖 `0015_competitor_monitor.sql`。升级拒绝混合逻辑库；两个数据库名称只能使用字母、数字和下划线，且必须不同。升级不属于空卷自动初始化：先完成最终数据导入和对应手动监控升级，再显式执行。

Compose 先更新挂载，再选择对应逻辑库升级：

```sh
corepack pnpm db:up
corepack pnpm db:upgrade:scheduled-monitor:primary
corepack pnpm db:upgrade:scheduled-monitor:competitor
```

外部 PG 可在配置 `POSTGRES_USER`、`POSTGRES_DB`、`COMPETITOR_DATABASE` 和标准 libpq 连接环境后调用：

```sh
sh packages/db/docker/apply-scheduled-monitor.sh primary packages/db/migrations/0016_scheduled_monitor_primary.sql
sh packages/db/docker/apply-scheduled-monitor.sh competitor packages/db/migrations/0016_scheduled_monitor_competitor.sql
```

SQL 在单个事务内执行，锁等待 5 秒、statement timeout 30 秒；同一 domain 的升级通过事务级 advisory lock 串行。已有私有表在 DDL 前取得排他表锁，以防校验后并发更换结构。

首次创建记录 `amazon-asin-monitor:scheduled-ledger:v1` 版本与 catalog 指纹；重复执行在 DDL 前后核对列类型/空值/default/collation、约束与验证状态、索引及有效性、用户 trigger、内部外键 trigger 的启用状态、rule 和 RLS。内部 trigger 使用逻辑约束与函数身份，排除会因恢复而变化的 OID 名称。ACL 与 ownership 可按部署授权调整，不进入结构摘要。无标记的预存表、未知标记、首次索引命名冲突或任何结构漂移均拒绝且回滚，不能依靠 `IF NOT EXISTS` 静默沿用或修补。该标记属于迁移事实源，不能手工重写以掩盖漂移；修复应先在隔离副本确认原因，再走独立迁移。

升级记录 preflight 已有的普通表 OID，并锁定、验证其旧 marker 与完整 catalog；记录为缺失的表和对应 expiry index 使用普通 CREATE，不能在后续通过 IF NOT EXISTS 跳过。其他会话抢先创建同名对象会使整个迁移失败；外部表/索引不会被盖上自有 marker，已创建的其他迁移对象一起回滚。postflight 仅更新这次已校验或事务内创建并锁定的 relation OID。

历史合法 v1 表的 job/follow-up CHECK 在同一升级事务内收紧并验证全部已有记录，随后更新 v1 catalog 指纹；版本仍表示本迁移所有权，而非放宽旧结构。严格 JSON 根键白名单、actor/batchConfig 白名单、必需字段与字符串类型、规范 UTC 毫秒时间和整体 IS TRUE 校验拒绝缺失/JSON null/借用 user/session。US child 必须提供完整 taskId/jobId/createdAt/expiresAt，jobId 绑定父 slot/batch，createdAt/requestedAt 精确等于原 business_completed_at，TTL 保留父 expires_at。UUIDv5 与完整内容 digest 仍由运行时重新解析/核对，不以数据库接受代表调用授权。

已有结构漂移先拒绝，不能重盖 marker 修补；合法自有旧结构若包含上述污染记录，新 CHECK 验证失败会回滚整个事务，保留原弱约束、原 marker 和全部数据。必须先在隔离副本调查并明确处理这些记录，不能删除、改写任务或伪造合法身份来完成升级。重复合法升级保持约束与更新后的指纹稳定；历史 a56e89d SQL fixture 只供隔离兼容性测试，不是部署入口。

## 回滚与后续存储纪律

回滚前停止对应 system producer/consumer，核对 pending run 和 claimed 通知，并独立备份私有账本。回滚会删除未完成任务、通知声明和组凭据；业务历史与手动任务身份保留。不能据此重新执行已经提交过的业务或重新发送未确认通知。

回滚与升级使用同一 domain 的事务级 advisory lock。删除前对全部仍存在的账本取得排他锁，核验它们是普通表、版本标记严格匹配 `amazon-asin-monitor:scheduled-ledger:v1:<domain>:<table>:<32位十六进制指纹>`，并核对对应业务/手动监控 prerequisite、拒绝相反逻辑库；全部核验通过后才按子表、父表顺序删除。无标记同名表、foreign/mixed-domain 标记、非表对象或错误库均使整个事务拒绝，保留全部原表和数据。因此升级因命名碰撞失败后，不能使用回滚删除该外部对象。

部分账本缺失时只删除仍具备正确归属标记的自有表；删除目标限定于 preflight 已锁定并核验的 relation OID，原先缺失的名字随后被并发创建时也不会删除新对象。全部缺失时回滚安全 no-op，不要求业务 prerequisite。这里校验首次迁移留下的所有权标记，不重新要求完整 catalog 指纹相等：已删除自有子表会改变父表内部外键 trigger，已删除父表也可能移除子表约束。升级仍严格拒绝 catalog 漂移；不能修改标记来使外部对象通过回滚。回滚不使用递归依赖删除，额外依赖会使事务拒绝并要求调查。

Compose 使用同一脚本选择对应 rollback：

```sh
docker compose --env-file .env.neo -f compose.neo.yml exec -T timescaledb sh /opt/asin-monitor/apply-scheduled-monitor.sh primary /opt/asin-monitor/0016_scheduled_monitor_primary.rollback.sql
docker compose --env-file .env.neo -f compose.neo.yml exec -T timescaledb sh /opt/asin-monitor/apply-scheduled-monitor.sh competitor /opt/asin-monitor/0016_scheduled_monitor_competitor.rollback.sql
```

`business_completed_at` 用于后续业务完成边界。US 主营完成后，完整竞品 child payload、digest 与首次 requestedAt 应与父完成状态同事务保存；竞品和非 US 主营不能保存 follow-up。本次 CHECK 只建立存储边界，后续运行时必须重新解析严格 child 契约并核对完整 digest。组结果也必须与业务状态、历史在同一事务提交，回放原收据时不能重新读取新增成员或重复写历史。这些原子操作由 #188 实现，本次没有提供运行时完成凭据。

## 隔离验证与验收边界

本地纯政策、Drizzle/SQL 对齐和 POSIX wrapper 测试不需要数据库。CRC32 golden 由 Python zlib 独立生成，政策测试同时调用未改动的 Legacy helper；这些是纯策略证据。

真实服务测试要求显式 `RUN_NEO_SCHEDULED_MONITOR_INTEGRATION=1`：

- PG 使用 `DATABASE_URL` / `COMPETITOR_DATABASE_URL`，在两个不同 database 的随机私有 schema 中重复升级/回滚、验证 actor/digest/country/ordinal/follow-up/claim、主动制造 catalog 漂移后确认升级拒绝；还覆盖三种同名 foreign 表升级失败后回滚拒绝并保留原数据、foreign 子表不能连带删除自有父表、错误 domain/table/version/hash 标记、非表对象、错误逻辑库、部分缺失和全缺失幂等。新增双 session 在 preflight 后抢表/expiry index，旧 v1 合法记录升级与污染升级完整回滚，以及 root/actor/batch/child 必需字段缺失和 JSON null 对称双域回归。结束时清理自有 schema。
- MySQL 使用 `INTEGRATION_MYSQL_HOST` / `INTEGRATION_MYSQL_PORT` / `INTEGRATION_MYSQL_USER` / `INTEGRATION_MYSQL_PASSWORD`，仅执行只读 SELECT；真实 `CRC32` 与 modulo 对照全部 UTF-8 golden，`DATETIME(6)` / binary ID 排序对照固定目录。
- 不加载部署 `.env`，缺少配置或连接失败会使已启用测试失败；没有 opt-in 时明确 skip。Integration workflow 显式启用并运行两份测试，不能把本地 skip 当成服务验收。

```sh
corepack pnpm --filter db exec vitest run test/scheduled-monitor-policy.test.ts test/scheduled-monitor-schema.test.ts test/scheduled-monitor-script.test.ts --maxWorkers=1
corepack pnpm --filter db exec vitest run test/scheduled-monitor-schema.integration.test.ts test/scheduled-monitor-mysql.integration.test.ts --no-file-parallelism
```

后续 #188 还需真实 BullMQ/Redis/双 PG 编译入口，覆盖首次过期不读取外部服务且不写业务、首次冻结与稳定目录、取消/租约、故障重启恢复、发送 ACK 丢失，以及 US 父任务完成后只恢复原 child。#189 才注册调度与频率热更新。基础测试不能替代生产数据对拍、灰度、旧 Bull drain、性能和 Legacy 退役 gate。
