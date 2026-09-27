# Neo PostgreSQL 备份与普通 PostgreSQL 恢复

## 格式与边界

Neo 只生成 PostgreSQL `pg_dump --format=custom --no-owner --no-acl` 产物，文件名为 `backup_YYYYMMDD-HHmmss-<任务 ID 前八位>-primary.dump` 或 `backup_YYYYMMDD-HHmmss-<任务 ID 前八位>-competitor.dump`。每个正式文件附带 `<文件名>.meta.json`，记录来源数据库类型和目标；两者都须保留。Legacy MySQL `.sql` 文件仅作为历史资料保留，不能通过 Neo 恢复接口导入。创建期间只写同目录 `.partial` 文件；校验 `PGDMP` 文件头、大小和权限后才改为正式文件名。异常退出留下的 `.partial` 文件须由运维核对无活跃任务后清理。

创建和恢复始终提交到 `backup-task-queue` 异步执行。任务元数据先写入 Redis task registry， Worker 再执行 `pg_dump`/`pg_restore`，每次检查 BullMQ lease、任务身份和取消状态。

**当前支持边界：**Neo 可对完整 TimescaleDB 数据库创建 custom dump，但不能通过 Neo 恢复接口恢复 TimescaleDB 来源文件，也不能对安装了 TimescaleDB 扩展的目标库原位恢复。TimescaleDB 目标也不允许通过 Neo 接口按表备份；官方指出按表 `pg_dump` 缺少重建 hypertable 所需的元数据。`GET /api/v1/backup` 只对元数据证实来自普通 PostgreSQL 且当前目标库也为普通 PostgreSQL 的文件返回 `restoreSupported: true`；来源元数据缺失或能力检查失败时返回 `false`。`POST /api/v1/backup/restore` 在入队前返回 409，Worker 再次检查以防止绕过 API。

## 持久化存储

API 与 Worker 必须挂载同一个持久化目录，并设置绝对路径 `BACKUP_STORAGE_DIRECTORY`。未设置时，仓库部署使用 `var/neo/backups`；生产环境必须把它映射到组织批准的持久卷，禁止使用容器临时文件系统。`BACKUP_MAX_BYTES` 限制单个产物大小，`BACKUP_COMMAND_TIMEOUT_MS` 限制外部命令最长运行时间。

`DATABASE_URL` 和 `COMPETITOR_DATABASE_URL` 的连接字段只在 Worker 子进程环境中传递给 PostgreSQL 客户端，绝不写入任务 payload、日志或 HTTP 响应。Worker 清除继承的 `PG*` 环境变量，再设置目标数据库的主机、端口、用户、密码、库名和 URL 中的 TLS 选项。表名参数只接受限定标识符，不接受 shell 片段；命令使用 `shell: false`。备份卷须限制为 API/Worker 与管理员可读写，避免其他进程替换同名文件。

## 普通 PostgreSQL 恢复演练

1. 在不含 TimescaleDB 扩展的隔离 PostgreSQL database 上挂载同一备份目录，确认备份文件的 target 与恢复目标一致。
2. 确认目录里有匹配目标库的正式 `.dump` 文件和同名 `.meta.json`，元数据的 `sourceEngine` 为 `postgresql`，且 `PGDMP` 文件头有效；记录文件哈希与 `pg_dump`/`pg_restore` 版本。旧版本 Neo 生成但缺少元数据的文件不能通过自动恢复接口处理，应先在隔离环境人工核实。使用 `POST /api/v1/backup/restore` 创建任务，等待任务中心状态为 `completed`。
3. 检查恢复后的 schema、角色/权限和业务记录，并运行 API/Worker 集成检查。
4. 保留演练日志和 `pg_restore` 版本；生产恢复前必须有变更审批和回滚窗口。

恢复任务使用 `--dbname=<目标库名> --single-transaction --exit-on-error --clean --if-exists --no-owner --no-acl`，命令成功并验证实际连接到目标库后才写入完成状态。缺少 `--dbname` 时，`pg_restore` 只会把 SQL 输出到 stdout，不能算恢复成功。取消会终止子进程并等待其关闭；单事务帮助避免中途失败留下部分 schema 改动。失败时清理未完成的 `.partial` 文件；已发布的有效 `.dump` 若在 Redis 完成确认时发生歧义，则保留给运维核对。无法确认状态时保留任务 ID，禁止重复提交同一恢复操作作为“补偿”。生产恢复前还须停止写入、安排维护窗口并备好独立回滚备份；自动化检查不能证明业务数据与扩展版本兼容。

同一目标库的备份和恢复共用 PostgreSQL advisory lock，跨 Worker 实例互斥；占用时任务明确失败。若 Worker 被强制终止，锁连接会断开，须先确认目标库中没有遗留的 `pg_dump`/`pg_restore` 会话再提交新任务。备份队列 `attempts=1`，不会自动重放可能已部分执行的恢复；操作员应检查任务、文件和数据库状态，再决定是否创建新任务。

## TimescaleDB 恢复边界

TimescaleDB 全库 dump 的恢复必须由运维在**新建的隔离目标库**执行，先安装相容版本的扩展并调用 `timescaledb_pre_restore()`，然后以 `pg_restore -d <新库>` 恢复，最后调用 `timescaledb_post_restore()`。不得使用 `pg_restore -j`。完成后核对 hypertable、chunk、continuous aggregate、压缩策略和记录；当前 Neo API 不负责该流程，也不提供生产数据库切换。步骤与版本要求以 [Timescale 官方逻辑备份指南](https://docs.timescale.com/self-hosted/latest/backup-and-restore/logical-backup/) 为准。

## 自动计划

`GET/POST /api/v1/backup/config` 保存 daily/weekly/monthly 和上海时间。启用 `SCHEDULER_ENABLED=true` 后，Worker 通过 Redis scheduler lease 选出调度器。计划时间与目标库生成稳定任务 ID；如某一目标入队失败，下次轮询会沿用该 ID 补齐任务，避免重复创建已成功的一项。调度配置在每次计划检查时读取，可热更新。

## 回滚

回滚应用时停止 Neo Worker/API，保留备份持久卷和任务元数据，恢复 Legacy 服务。Legacy SQL 备份不能用于 Neo 恢复；从 Neo custom dump 恢复前，先在隔离库完成演练并记录可恢复性证据。
