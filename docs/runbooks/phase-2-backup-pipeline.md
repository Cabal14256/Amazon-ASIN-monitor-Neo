# Neo PostgreSQL / TimescaleDB 备份与恢复

## 格式与边界

Neo 只生成 PostgreSQL `pg_dump --format=custom --no-owner --no-acl` 产物，文件名为 `backup_YYYYMMDD-HHmmss-<任务 ID 前八位>-primary.dump` 或 `backup_YYYYMMDD-HHmmss-<任务 ID 前八位>-competitor.dump`。每个正式文件附带 `<文件名>.meta.json`，记录来源数据库类型和目标；两者都须保留。Legacy MySQL `.sql` 文件仅作为历史资料保留，不能通过 Neo 恢复接口导入。创建期间只写同目录 `.partial` 文件；校验 `PGDMP` 文件头、大小和权限后才改为正式文件名。异常退出留下的 `.partial` 文件须由运维核对无活跃任务后清理。

`GET /api/v1/backup/:filename/download` 下载 `.tar`，其中包含原始 `.dump` 和经过校验的同名 `.meta.json`；缺失或无效的元数据会拒绝下载。跨实例恢复时先在受控环境解包，把两个文件以原文件名一起放入目标实例的 `BACKUP_STORAGE_DIRECTORY`，再执行恢复。备份创建时填写的描述会保存在元数据中，并出现在列表中。普通 PostgreSQL 新产物使用 v3 元数据；TimescaleDB 新产物使用 v4 元数据并同样强制保存和核对 SHA-256。旧 Timescale v2 元数据可保留及下载，但缺少绑定摘要，不能自动恢复。普通 PostgreSQL v3 元数据以 `scope: full` 或 `scope: selective` 明确完整/按表归档，并记录归档 SHA-256；恢复前 Worker 流式核对，错配时不运行 `pg_restore`。按表备份使用 PostgreSQL 16 的 `--table-and-children`，包括所选父表的分区与继承子表。新元数据也保存来源数据库的 TimeZone（优先数据库级配置，否则取来源连接有效值）、编码、`LC_COLLATE`、`LC_CTYPE`、locale provider 与 ICU locale/rules；旧元数据缺少可靠范围或字符集信息时 Neo 不自动恢复。

创建和恢复始终提交到 `backup-task-queue` 异步执行。任务元数据先写入 Redis task registry， Worker 再执行 `pg_dump`/`pg_restore`，每次检查 BullMQ lease、任务身份和取消状态。

**当前支持边界：**完整 TimescaleDB 与普通 PostgreSQL custom dump 均恢复到同一 PostgreSQL 实例上的**新建隔离数据库**。Neo 不自动替换在线主库或竞品库，不修改 `DATABASE_URL`/`COMPETITOR_DATABASE_URL`，不执行生产切换。异步任务受理与完成结果分别标记 `restoreMode: isolated`；完成结果提供 `restoredDatabase` 和 `targetDatabaseChanged: false`，运维须独立验证并决定切换。仅 v3 `scope: selective` 的普通 PostgreSQL 按表归档执行原位部分恢复，标记 `restoreMode: in-place`。TimescaleDB 不支持按表 `pg_dump`；该模式缺少重建 hypertable 所需的目录元数据。`GET /api/v1/backup` 仅在备份来源、范围、当前目标库扩展类型与版本相符且文件未超过当前 `BACKUP_MAX_BYTES` 时返回 `restoreSupported: true`；未验证文件与早期缺少 Timescale 目录清单的文件返回 `false`。API 和 Worker 均会拒绝来源/目标类型不一致的任务。

## 持久化存储

API 与 Worker 必须挂载同一个持久化目录，并设置绝对路径 `BACKUP_STORAGE_DIRECTORY`。未设置时，仓库部署使用 `var/neo/backups`；生产环境必须把它映射到组织批准的持久卷，禁止使用容器临时文件系统。`BACKUP_MAX_BYTES` 限制单个产物大小，`BACKUP_COMMAND_TIMEOUT_MS` 限制外部命令最长运行时间。

`DATABASE_URL` 和 `COMPETITOR_DATABASE_URL` 的连接字段只在 Worker 子进程环境中传递给 PostgreSQL 客户端，绝不写入任务 payload、日志或 HTTP 响应。Worker 先按 node-postgres 规则解析 URL、`PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` 等缺省值，再清除继承的 `PG*` 并把解析后的目标显式交给 libpq；不继承 `PGSERVICE` 等额外重定向项。表名参数只接受限定标识符，不接受 shell 片段；命令使用 `shell: false`。备份卷须限制为 API/Worker 与管理员可读写，避免其他进程替换同名文件。

## 普通 PostgreSQL 恢复演练

1. 在不含 TimescaleDB 扩展的隔离 PostgreSQL 实例上挂载同一备份目录，确认备份文件的 target 与恢复目标一致。完整归档恢复需要目标角色有 `CREATEDB` 及删除失败隔离库的权限，并预留双份数据库容量。
2. 确认目录里有匹配目标库的正式 `.dump` 文件和同名 `.meta.json`，元数据为 `version: 3`、`sourceEngine: postgresql`，含归档摘要与源数据库字符集设置，且 `PGDMP` 文件头有效；记录文件哈希与 `pg_dump`/`pg_restore` 版本。旧版本 Neo 生成但缺少 v3 `scope` 的文件不能通过自动恢复接口处理，应先在隔离环境人工核实。
3. 使用 `POST /api/v1/backup/restore` 创建任务。`scope: full` 必须返回 `restoreMode: isolated`；完成后从结果读取 `restoredDatabase` 并核对该隔离库中没有备份之后才添加的对象，在线目标库未变。`scope: selective` 返回 `restoreMode: in-place`；等待任务中心状态为 `completed` 且结果中 `verification: confirmed`，若为 `unconfirmed`，先核对目标库，不要直接重试。
4. 检查恢复后的 schema、角色/权限和业务记录，并运行 API/Worker 集成检查。
5. 保留演练日志和 `pg_restore` 版本；生产恢复前必须有变更审批和回滚窗口。

完整归档先用 `TEMPLATE template0` 和归档中的字符集/locale 设置新建受限隔离库，并以 `ALTER DATABASE ... SET TimeZone` 恢复来源时区；旧 sidecar 未记录时区时使用 D8 所要求的 `Asia/Shanghai`。普通 PostgreSQL 随后用 `--dbname=<隔离库名> --single-transaction --exit-on-error --no-owner --no-acl` 恢复。两个引擎都在恢复后重新验证数据库级时区，防止 `LOCALTIMESTAMP` 默认值与触发器发生偏移；成功后保留隔离库供核对，失败或取消时清理本任务确认创建的隔离库。按表归档先确认在线目标库的字符集/locale 设置与备份一致，再使用 `--dbname=<在线目标库名> --single-transaction --exit-on-error --clean --if-exists --no-owner --no-acl` 原位恢复。`pg_restore` 成功退出即表示单事务已提交，任务立即记录 `targetDatabaseChanged: true`、`verification: unconfirmed`；后续健康检查成功才改为 `verification: confirmed`。若后续锁、健康检查或进度写入失败，任务仍显示数据库已变更、需人工核对，不能按已取消或未变更重试。缺少 `--dbname` 时，`pg_restore` 只会把 SQL 输出到 stdout，不能算恢复成功。取消会终止子进程并等待其关闭；单事务帮助避免中途失败留下部分 schema 改动。失败时清理未完成的 `.partial` 文件；已发布的有效 `.dump` 若在 Redis 完成确认时发生歧义，则保留给运维核对。无法确认状态时保留任务 ID，禁止重复提交同一恢复操作作为“补偿”。生产恢复前还须停止写入、安排维护窗口并备好独立回滚备份；自动化检查不能证明业务数据与扩展版本兼容。

同一目标库的备份和恢复共用 PostgreSQL advisory lock，跨 Worker 实例互斥；primary 与 competitor 使用不同键，即使两库位于同一集群也可并行处理。占用时任务明确失败。若 Worker 被强制终止，锁连接会断开，须先确认目标库中没有遗留的 `pg_dump`/`pg_restore` 会话再提交新任务。备份队列 `attempts=1`，不会自动重放可能已部分执行的恢复；操作员应检查任务、文件和数据库状态，再决定是否创建新任务。

## TimescaleDB 隔离恢复

1. 确认 `.dump` 与 `.meta.json` 同在备份卷，元数据为 `version: 4`、`sourceEngine: timescaledb`，含归档 SHA-256，并含源数据库字符集设置、扩展版本、hypertable 和 continuous aggregate 清单；缺少字符集设置的旧 sidecar 不自动恢复。目标连接角色须有 `CREATEDB`、`CREATE EXTENSION timescaledb` 和清理隔离库所需的权限；目标实例须安装与备份相同的扩展版本。Worker 在新库以归档版本安装扩展，不依赖控制文件的当前默认版本。先确认数据库容量足以同时容纳在线库与隔离库。
2. 调用 `POST /api/v1/backup/restore`，确认 `restoreMode: isolated`。Worker 在目标实例用归档元数据中的字符集、locale provider 与 ICU rules 创建 `neo_restore_<primary|competitor>_<任务 ID 前 16 位十六进制>`，撤销该库对 `PUBLIC` 的连接权限，安装 TimescaleDB 扩展，调用 `timescaledb_pre_restore()`，验证恢复状态在新会话可见，再运行 `pg_restore -Fc --exit-on-error -d <隔离库>`。Worker 在同一事务中调用 `timescaledb_post_restore()` 并将 `_timescaledb_config.bgw_job` 中 `id >= 1000` 的全部用户作业设为 `scheduled = false`；若作业停用或事务提交失败，隔离库恢复失败并尝试删除。
3. Worker 在新会话核对恢复状态已关闭、用户后台作业均未调度、扩展版本、hypertable 与 continuous aggregate 清单与备份元数据完全一致，才将任务标为完成。失败或取消时先尝试 `timescaledb_post_restore()`，再删除**本任务确认创建**的隔离库；数据库创建确认丢失或清理未确认时任务失败并提示人工核对，禁止把残留库当作成功恢复。数据库名可由任务 ID 确定，排查时不得删除不属于该任务的数据库。
4. 任务完成后从结果读取 `restoredDatabase`，核对业务记录、chunk、压缩与保留策略、CAGG 数据和权限。隔离库中的 retention、columnstore、CAGG 刷新等用户后台作业保持停用；运维完成核对并决定切换后，按各作业的预期策略逐一显式启用。完成状态只证明隔离恢复与目录检查成功；生产切换、连接串变更、回滚窗口及停写安排由运维另行执行。Neo 不运行 `pg_restore -j`。步骤与版本要求以 [Timescale 官方逻辑备份指南](https://docs.timescale.com/self-hosted/latest/backup-and-restore/logical-backup/) 及 [迁移时停用后台作业步骤](https://docs.timescale.com/migrate/latest/dual-write-and-backfill/dual-write-from-timescaledb/) 为准。

## 自动计划

`GET/POST /api/v1/backup/config` 保存 daily/weekly/monthly 和上海时间。启用 `SCHEDULER_ENABLED=true` 后，Worker 通过 Redis scheduler lease 选出调度器。计划时间与目标库生成稳定任务 ID；如某一目标入队失败，下次轮询会沿用该 ID 补齐任务，避免重复创建已成功的一项。调度配置在每次计划检查时读取，可热更新。

有 `settings:write` 权限的管理员可在设置页“自动备份执行记录”或 `GET /api/v1/backup/scheduled-tasks` 查看最近 50 次计划任务的待执行、失败、取消与完成状态。该接口只读取系统计划所有者的备份任务，不授予取消或修改任务权限。列表依赖 Redis 任务元数据的保留期；过期记录须从独立审计或运维日志查找。

## 回滚

回滚应用时停止 Neo Worker/API，保留备份持久卷和任务元数据，恢复 Legacy 服务。Legacy SQL 备份不能用于 Neo 恢复；从 Neo custom dump 恢复前，先在隔离库完成演练并记录可恢复性证据。

当原位恢复已经提交，而两次 Redis task registry 完成写入均失败时，Worker 把小于 1 KiB 的已提交、待核实回执返回给 BullMQ，队列保持 completed。备份队列的完成/失败结果至少保留 max(7 天, TASK_META_TTL_SECONDS)，不设置可提前淘汰回执的 count 上限；任务查询按所有者、创建时间和 restore 子类型绑定回执后恢复 registry。即使 registry 保留 cancelling、cancelled 或 failed，已提交的恢复也不能被展示为未执行。若 BullMQ 自身也失联或进程被强制终止，仍须人工核对数据库，不能依赖该回执证明未提交。

备份下载以 EXPORT/backup 记录持久审计：保留认证操作人、经过文件名校验的归档标识、路由模板及最终状态，不记录文件内容、查询参数或凭据。
