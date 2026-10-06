# Neo PostgreSQL / TimescaleDB 备份与恢复

## 格式与边界

Neo 只生成 PostgreSQL `pg_dump --format=custom --no-owner --no-acl` 产物，文件名为 `backup_YYYYMMDD-HHmmss-<完整任务 UUID 去除横线>-primary.dump` 或 `backup_YYYYMMDD-HHmmss-<完整任务 UUID 去除横线>-competitor.dump`，读取时兼容既有任务 ID 前八位的文件名。每个正式文件附带 `<文件名>.meta.json`，记录来源数据库类型和目标；两者都须保留。Legacy MySQL `.sql` 文件仅作为历史资料保留，不能通过 Neo 恢复接口导入。创建期间只写同目录 `.partial` 文件；校验 `PGDMP` 文件头、大小和权限后才改为正式文件名。同一创建任务重试会清理自己的未发布临时文件；其他异常退出留下的 `.partial` 文件须由运维核对无活跃任务后清理。

`GET /api/v1/backup/:filename/download` 下载 `.tar`，其中包含原始 `.dump` 和经过校验的同名 `.meta.json`；缺失或无效的元数据会拒绝下载。跨实例恢复时先在受控环境解包，把两个文件以原文件名一起放入目标实例的 `BACKUP_STORAGE_DIRECTORY`，再执行恢复。备份创建时填写的描述会保存在元数据中，并出现在列表中。普通 PostgreSQL 新产物使用 v3 元数据；TimescaleDB 新产物使用 v4 元数据并同样强制保存和核对 SHA-256。旧 Timescale v2 元数据可保留及下载，但缺少绑定摘要，不能自动恢复。普通 PostgreSQL v3 元数据以 `scope: full` 或 `scope: selective` 明确完整/按表归档，并记录归档 SHA-256；恢复前 Worker 流式核对，错配时不运行 `pg_restore`。按表备份使用 PostgreSQL 16 的 `--table-and-children`，包括所选父表的分区与继承子表。新元数据也保存来源数据库的 TimeZone（优先数据库级配置，否则取来源连接有效值）、编码、`LC_COLLATE`、`LC_CTYPE`、locale provider 与 ICU locale/rules；旧元数据缺少可靠范围或字符集信息时 Neo 不自动恢复。

创建和恢复始终提交到 `backup-task-queue` 异步执行。任务元数据先写入 Redis task registry， Worker 再执行 `pg_dump`/`pg_restore`，每次检查 BullMQ lease、任务身份和取消状态。

备份创建与恢复的总执行窗口为受理时不可变 `createdAt` 起六天，包含排队、退避、全部尝试、归档哈希和外部命令；重新投递不重置窗口。`TASK_META_TTL_SECONDS` 对备份至少为 604800（七天，默认不变），API 在创建元数据和入队前拒绝更短配置并返回 503，Worker 在建立消费者或自动计划连接前同样拒绝。其他队列仍可使用原有较短保留期。排队接近截止时仅获得剩余窗口，过期的未发布任务明确失败；静默恢复命令和流式哈希也受同一 AbortSignal 控制，原 `BACKUP_COMMAND_TIMEOUT_MS` 的单命令上限不会延长。停止与清理留出一天保留余量，不新增无界 Redis touch。若 Worker 离线超过保留期，历史元数据按既有 TTL 过期，不复建或猜测任务身份；查询原任务的可用队列证据并人工核对，禁止自动补偿未知恢复。

已发布创建文件与已提交恢复结果优先保留：到期、退出、取消或旧租约丢失不能撤销真实完成点。未发布且清理已确认的最终失败通过绑定原任务身份的专用 CAS 重新读取共享状态，保留已接受的取消；隔离库创建或清理结果不确定、已观察到正式产物或临时文件清理失败时仍保留失败与人工核对提示，不能把不确定状态包装为安全取消。回滚本次生命周期限制前应先停止 Neo 备份生产者和消费者，核对所有长时间排队任务及未知恢复，不降低元数据保留配置作为回滚手段。

按表参数继续仅接受一个表标识符或 `schema.table`，每一段单独转为双引号 literal pattern 交给 `pg_dump --table-and-children`；不能用未引用的混合大小写名称折叠到另一个小写表。sidecar 保存原请求表名，恢复时真实 CLI 仅改变该表，大小写冲突的其他表保持不变。参数规则依据 [PostgreSQL 16 pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html) 和 [psql pattern 规则](https://www.postgresql.org/docs/16/app-psql.html#APP-PSQL-PATTERNS)。

**当前支持边界：**完整 TimescaleDB 与普通 PostgreSQL custom dump 均恢复到同一 PostgreSQL 实例上的**新建隔离数据库**。Neo 不自动替换在线主库或竞品库，不修改 `DATABASE_URL`/`COMPETITOR_DATABASE_URL`，不执行生产切换。异步任务受理与完成结果分别标记 `restoreMode: isolated`；完成结果提供 `restoredDatabase` 和 `targetDatabaseChanged: false`，运维须独立验证并决定切换。仅 v3 `scope: selective` 的普通 PostgreSQL 按表归档执行原位部分恢复，标记 `restoreMode: in-place`。TimescaleDB 不支持按表 `pg_dump`；该模式缺少重建 hypertable 所需的目录元数据。`GET /api/v1/backup` 仅在备份来源、范围、当前目标库扩展类型与版本相符且文件未超过当前 `BACKUP_MAX_BYTES` 时返回 `restoreSupported: true`；未验证文件与早期缺少 Timescale 目录清单的文件返回 `false`。API 和 Worker 均会拒绝来源/目标类型不一致的任务。

## 持久化存储

`PG_DUMP_PATH` 和 `PG_RESTORE_PATH` 最长为 512 字符；启动环境校验与 Worker 执行校验使用同一上限，超限配置在启动时拒绝。只接受可执行文件名或绝对路径，不接受命令参数。

`BACKUP_MAX_BYTES` 至少为 5，才能容纳 custom archive 必需的 `PGDMP` 文件头；1–4 在启动校验时拒绝。这个最小值只保证配置不会小于格式头，实际归档仍须通过完整大小、摘要和元数据验证。

备份命令按照锁定的 `pg-connection-string` 2.14.0 / `pg` 8.23.0 实际 SSL 解析结果生成 libpq 环境，不直接照搬 URL 的 `sslmode` 文本。`ssl=true` / `ssl=1` 以及默认的 `sslmode=prefer`、`require`、`verify-ca`、`verify-full` 都要求 TLS、CA 和主机名校验，命令使用 `verify-full`；显式 `ssl=0` / `sslmode=disable` 使用 `disable`。当前应用驱动默认未开启 TLS 时命令也明确 `disable`，不会采用 libpq 的 `prefer` 默认退回行为。URL 显式设置覆盖 `PGSSLMODE`；无 URL SSL 设置时，环境值按当前应用驱动相同规则转换。

只有应用配置显式关闭服务器证书校验（`sslmode=no-verify`、`ssl=no-verify`，或 `uselibpqcompat=true` 下未指定 CA 的 `require` / `prefer`）时，CLI 才使用只要求加密的 `require`。`uselibpqcompat=true` 下指定 CA 的 `require` / `verify-ca` 使用 `verify-ca`；自定义 CA、客户端证书和密钥保留 URL 的文件路径。命令同时禁止 GSS 覆盖 TLS，并为未配置的 libpq HOME 证书、密钥、根证书和 CRL 使用独立不存在路径，避免应用未采用的 `.postgresql` 文件改变认证策略。

未指定自定义 CA 的严格 TLS 命令，会在私有临时目录生成该 Worker 的 Node 默认 CA PEM（目录 0700、文件 0600），传给该命令，子进程 `close` 后逐项清理；证书内容不放入环境变量、命令参数、sidecar 或日志。Node 22+ 使用 `getCACertificates('default')` 的实际默认集合；Node 20 使用 bundled roots，并加入配置的 `NODE_EXTRA_CA_CERTS` 文件。Node 20 显式 `--use-openssl-ca` 无法列举其有效信任集时会失败关闭，需在连接 URL 提供 `sslrootcert`；不会自行换成系统 CA 集合。以上规则以[锁定 parser 文档](https://github.com/brianc/node-postgres/blob/master/packages/pg-connection-string/README.md)、[PostgreSQL 16 SSL 行为](https://www.postgresql.org/docs/16/libpq-ssl.html)和 [Node TLS CA API](https://nodejs.org/api/tls.html#tlsgetcacertificatestype)为依据；升级驱动时须重新跑实际 driver 参数和真实 CLI 回归。

对于普通 PostgreSQL 的选择性归档，列表能力检查及恢复入队前都读取目标数据库的编码、collation、ctype、locale provider 和 ICU locale/rules；不匹配时列表不提供恢复，提交返回 409。目录读取失败时按不可恢复处理。Worker 执行前再次核对，避免排队期间目标配置变化。完整归档在隔离库使用源 locale，因此不要求与在线目标库 locale 相同。

API 与 Worker 必须挂载同一个持久化目录，并设置绝对路径 `BACKUP_STORAGE_DIRECTORY`。未设置时，仓库部署使用 `var/neo/backups`；生产环境必须把它映射到组织批准的持久卷，禁止使用容器临时文件系统。`BACKUP_MAX_BYTES` 限制单个产物大小，`BACKUP_COMMAND_TIMEOUT_MS` 限制外部命令最长运行时间。

`DATABASE_URL` 和 `COMPETITOR_DATABASE_URL` 的连接字段只在 Worker 子进程环境中传递给 PostgreSQL 客户端，绝不写入任务 payload、日志或 HTTP 响应。Worker 先按 node-postgres 规则解析 URL、`PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` 等缺省值，再清除继承的 `PG*` 并把解析后的目标显式交给 libpq；不继承 `PGSERVICE` 等额外重定向项。表名参数只接受限定标识符，不接受 shell 片段；命令使用 `shell: false`。备份卷须限制为 API/Worker 与管理员可读写，避免其他进程替换同名文件。

数据库解析直接复用共享配置的 `pg-connection-string`，与应用使用的 node-postgres 保持一致：URL 路径中的数据库优先于 `?database=`；空路径不采用该查询参数，而沿用 `PGDATABASE` 或用户缺省值。旧实现让查询参数覆盖路径，可能使锁和元数据来自一个库、`pg_dump` 或原位 `pg_restore` 实际操作另一个库，现已更正。隔离恢复仍移除冗余 `database`/`dbname` 参数，并显式传递新建数据库路径。验证用实际 `pg.Client` 的连接参数与命令环境对照，覆盖主库/竞品库相互冲突、保留转义字符、中文空格和空路径；不建立真实数据库连接。五个新回归在旧实现全部失败，修复后 `corepack pnpm --filter worker exec vitest run test/backup-processor.test.ts --maxWorkers=1` 的 19 个测试全部通过。

## 普通 PostgreSQL 恢复演练

1. 在不含 TimescaleDB 扩展的隔离 PostgreSQL 实例上挂载同一备份目录，确认备份文件的 target 与恢复目标一致。完整归档恢复需要目标角色有 `CREATEDB` 及删除失败隔离库的权限，并预留双份数据库容量。
2. 确认目录里有匹配目标库的正式 `.dump` 文件和同名 `.meta.json`，元数据为 `version: 3`、`sourceEngine: postgresql`，含归档摘要与源数据库字符集设置，且 `PGDMP` 文件头有效；记录文件哈希与 `pg_dump`/`pg_restore` 版本。旧版本 Neo 生成但缺少 v3 `scope` 的文件不能通过自动恢复接口处理，应先在隔离环境人工核实。
3. 使用 `POST /api/v1/backup/restore` 创建任务。`scope: full` 必须返回 `restoreMode: isolated`；完成后从结果读取 `restoredDatabase` 并核对该隔离库中没有备份之后才添加的对象，在线目标库未变。`scope: selective` 返回 `restoreMode: in-place`；等待任务中心状态为 `completed` 且结果中 `verification: confirmed`，若为 `unconfirmed`，先核对目标库，不要直接重试。
4. 检查恢复后的 schema、角色/权限和业务记录，并运行 API/Worker 集成检查。
5. 保留演练日志和 `pg_restore` 版本；生产恢复前必须有变更审批和回滚窗口。

完整归档先用 `TEMPLATE template0` 和归档中的字符集/locale 设置新建受限隔离库，并以 `ALTER DATABASE ... SET TimeZone` 恢复来源时区；旧 sidecar 未记录时区时使用 D8 所要求的 `Asia/Shanghai`。普通 PostgreSQL 随后用 `--dbname=<隔离库名> --single-transaction --exit-on-error --no-owner --no-acl` 恢复。两个引擎都在恢复后重新验证数据库级时区，防止 `LOCALTIMESTAMP` 默认值与触发器发生偏移；成功后保留隔离库供核对，失败或取消时清理本任务确认创建的隔离库。按表归档先确认在线目标库的字符集/locale 设置与备份一致，再使用 `--dbname=<在线目标库名> --single-transaction --exit-on-error --clean --if-exists --no-owner --no-acl` 原位恢复。`pg_restore` 成功退出即表示单事务已提交，任务立即记录 `targetDatabaseChanged: true`、`verification: unconfirmed`；后续健康检查成功才改为 `verification: confirmed`。若后续锁、健康检查或进度写入失败，任务仍显示数据库已变更、需人工核对，不能按已取消或未变更重试。缺少 `--dbname` 时，`pg_restore` 只会把 SQL 输出到 stdout，不能算恢复成功。取消会终止子进程并等待其关闭；单事务帮助避免中途失败留下部分 schema 改动。失败时清理未完成的 `.partial` 文件；已发布的有效 `.dump` 若在 Redis 完成确认时发生歧义，则保留给运维核对。无法确认状态时保留任务 ID，禁止重复提交同一恢复操作作为“补偿”。生产恢复前还须停止写入、安排维护窗口并备好独立回滚备份；自动化检查不能证明业务数据与扩展版本兼容。

同一目标库的备份和恢复共用 PostgreSQL advisory lock，跨 Worker 实例互斥；primary 与 competitor 使用不同键，即使两库位于同一集群也可并行处理。占用时创建任务按原任务重试，恢复任务明确失败。创建任务默认最多两次尝试、5 秒指数退避；恢复生产者单独使用 `attempts=1`，已开始的恢复即使因 stalled 再次投递也拒绝重新执行。若 Worker 被强制终止，须核对遗留 PostgreSQL 会话和任务回执，禁止通过新建恢复任务补偿未知提交。

创建文件名由受理时间和完整任务 UUID 确定，保留既有 8 位标识文件的读取兼容。v3/v4 sidecar 保存绑定任务、所有者、目标和参数的摘要 `creationIdentity`；有效 `.dump` 的发布是持久化完成点。发布前失败会清理本任务临时文件；只有清理全部确认且剩余尝试存在时才保留非终态元数据，下一次投递重新抓取。任意临时归档、临时 sidecar 或孤立 sidecar 的清理未确认时，创建任务立即不可重试地失败，并保留人工核对提示；后续取消或意外重投递不能把该失败改为取消，运维核对前不得自动启动替代 dump。发布后 Redis 完成确认丢失时返回有界 BullMQ 结果；重放先验证 sidecar 身份与归档 SHA-256，再恢复完成状态，不运行第二次 `pg_dump`，不覆盖不匹配的文件。API 创建或恢复受理结果不确定时，固定 500 信封保留生成的 `data.taskId`，先查询该 ID；其他 5xx 继续隐藏内部载荷。任务状态发布失败使用共享节流 warn，状态写入成功不会因通知失败被撤销。

已发布文件的恢复校验先于取消、停机和旧执行租约检查；后续取消不能撤销正式文件的发布。Worker 核对完整文件头、大小、归档哈希和服务端元数据后，在私有队列结果中保存绑定不可变任务身份的完成凭据。任务查询与管理员计划记录使用相同身份/参数摘要校验，经受限 `backup/create` CAS 修正遗留的 cancelling/cancelled/failed；不会重跑 dump，也不在 3 秒列表内哈希大文件。公开 HTTP/WS 结果不携带该私有凭据或任务参数；没有有效队列证据时保留原终态。

恢复在提交前被确认取消时，Worker 返回的 `{ cancelled: true }` 会使 BullMQ 作业成为 completed，但这不是数据库已恢复的凭据。任务详情与列表在缺失、无效或仅含取消标记的队列结果下保留已确认的 cancelled/failed，不自动改为 completed；只有符合恢复完成契约、且队列身份与原任务一致的 commit 回执，才能沿专用 CAS 修正旧取消或失败状态。

新 v3/v4 sidecar 的可选 `execution` 保存实际 `pg_dump` 启动前的 `dumpStartedAt`、成功退出后的 `dumpCompletedAt` 和归档/sidecar 原子发布开始前的 `publicationStartedAt`，并标明 `timeSource: dump-start`。列表、创建完成凭据与公开结果的 `createdAt` 使用该执行起点，重放和下载沿用原 sidecar 全部时间。`dump-start` 是 Legacy 同样采用的执行开始时刻，不能声称它是 PostgreSQL 精确 MVCC 快照瞬间；恢复点属于成功 dump 的执行窗口，`publicationStartedAt` 也不宣称文件 rename 已完成。队列不可变 `createdAt`、task identity、确定性文件名和 `creationIdentity` 摘要仍采用首次受理信息，执行时间不会重置六天期限或改变原私有 proof。

旧 v3/v4 sidecar 和旧队列凭据仍兼容，缺少 `execution` 的归档时间明确显示 `timeSource: filename`；旧文件名日历无效时显示 `timeSource: mtime` 并需运维核对。已经完成且不再查询队列的旧创建任务，仅在原私有凭据与任务/所有者/受理时间、确定性文件名和原结果时间一致时，展示来源为 `filename`；无法验证的旧结果标为 `unavailable`。展示不修改终态、存储中的原凭据或 hash，也不重新采样时刻。兼容旧 Intl 以 `24` 表示当日零点的文件名，不使用复制、解压时生成的新 birthtime；这些回退时间不能被当作观测到的实际 dump 时间。不存在（ENOENT）或无效 custom 产物可省略/返回 404；非法下载/删除文件名在鉴权后的请求边界返回固定 400，并仅记录固定 warn reason，不记录原输入。EACCES、EIO、ESTALE 等读取异常仍返回固定 500 并记录最小错误码，不能误报为空列表或不存在。

## TimescaleDB 隔离恢复

1. 确认 `.dump` 与 `.meta.json` 同在备份卷，元数据为 `version: 4`、`sourceEngine: timescaledb`，含归档 SHA-256，并含源数据库字符集设置、扩展版本、hypertable 和 continuous aggregate 清单；缺少字符集设置的旧 sidecar 不自动恢复。目标连接角色须有 `CREATEDB`、`CREATE EXTENSION timescaledb` 和清理隔离库所需的权限；目标实例须安装与备份相同的扩展版本。Worker 在新库以归档版本安装扩展，不依赖控制文件的当前默认版本。先确认数据库容量足以同时容纳在线库与隔离库。
2. 调用 `POST /api/v1/backup/restore`，确认 `restoreMode: isolated`。Worker 在目标实例用归档元数据中的字符集、locale provider 与 ICU rules 创建 `neo_restore_<primary|competitor>_<任务 ID 前 16 位十六进制>`，撤销该库对 `PUBLIC` 的连接权限，安装 TimescaleDB 扩展，调用 `timescaledb_pre_restore()`，验证恢复状态在新会话可见，再运行 `pg_restore -Fc --exit-on-error -d <隔离库>`。Worker 在同一事务中调用 `timescaledb_post_restore()` 并将 `_timescaledb_config.bgw_job` 中 `id >= 1000` 的全部用户作业设为 `scheduled = false`；若作业停用或事务提交失败，隔离库恢复失败并尝试删除。
3. Worker 在新会话核对恢复状态已关闭、用户后台作业均未调度、扩展版本、hypertable 与 continuous aggregate 清单与备份元数据完全一致，才将任务标为完成。失败或取消时先尝试 `timescaledb_post_restore()`，再删除**本任务确认创建**的隔离库；数据库创建确认丢失或清理未确认时任务失败并提示人工核对，禁止把残留库当作成功恢复。数据库名可由任务 ID 确定，排查时不得删除不属于该任务的数据库。
4. 任务完成后从结果读取 `restoredDatabase`，核对业务记录、chunk、压缩与保留策略、CAGG 数据和权限。隔离库中的 retention、columnstore、CAGG 刷新等用户后台作业保持停用；运维完成核对并决定切换后，按各作业的预期策略逐一显式启用。完成状态只证明隔离恢复与目录检查成功；生产切换、连接串变更、回滚窗口及停写安排由运维另行执行。Neo 不运行 `pg_restore -j`。步骤与版本要求以 [Timescale 官方逻辑备份指南](https://docs.timescale.com/self-hosted/latest/backup-and-restore/logical-backup/) 及 [迁移时停用后台作业步骤](https://docs.timescale.com/migrate/latest/dual-write-and-backfill/dual-write-from-timescaledb/) 为准。

## 自动计划

若 Legacy 迁移留下多行 `backup_config`，读取、保存和调度均沿用 Legacy 的最小 ID 行；保存只更新该行，保留后续行供运维核查，不因多行状态中断 API 或自动计划。

`GET/POST /api/v1/backup/config` 保存 daily/weekly/monthly 和上海时间。时间格式化请求 `hourCycle: h23` 并将兼容 ICU 的午夜 `24` 归一化为同一日的 `00`，三种 `00:00` 计划均可触发并保留原五分钟补偿边界。启用 `SCHEDULER_ENABLED=true` 后，Worker 通过 Redis scheduler lease 选出调度器。计划时间与目标库生成稳定任务 ID；如某一目标入队失败，下次轮询会沿用该 ID 补齐任务，避免重复创建已成功的一项。调度配置在每次计划检查时读取，可热更新。

有 `settings:write` 权限的管理员可在设置页“自动备份执行记录”或 `GET /api/v1/backup/scheduled-tasks` 查看最近 50 次计划任务的待执行、失败、取消与完成状态。该接口只读取系统计划所有者的备份任务，不授予取消或修改任务权限。列表依赖 Redis 任务元数据的保留期；过期记录须从独立审计或运维日志查找。

## 回滚

回滚应用时停止 Neo Worker/API，保留备份持久卷和任务元数据，恢复 Legacy 服务。Legacy SQL 备份不能用于 Neo 恢复；从 Neo custom dump 恢复前，先在隔离库完成演练并记录可恢复性证据。

当原位恢复已经提交，或隔离恢复完成验证并保留数据库，而两次 Redis task registry 完成写入均失败时，Worker 把小于 1 KiB 的已恢复、待核实回执返回给 BullMQ，队列保持 completed。隔离恢复回执保留 `restoredDatabase`、`restoreMode: isolated`、`targetDatabaseChanged: false` 和 `verification: unconfirmed`；不得因此自动重试或删除已经保留的恢复库。备份队列的完成/失败结果至少保留 max(7 天, TASK_META_TTL_SECONDS)，不设置可提前淘汰回执的 count 上限；任务查询按所有者、创建时间和 restore 子类型绑定回执后恢复 registry。即使 registry 保留 cancelling、cancelled 或 failed，已完成的恢复也不能被展示为未执行。若 BullMQ 自身也失联或进程被强制终止，仍须人工核对数据库，不能依赖该回执证明未提交。

备份下载以 EXPORT/backup 记录持久审计：保留认证操作人、经过文件名校验的归档标识、路由模板及最终状态，不记录文件内容、查询参数或凭据。
