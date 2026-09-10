# P2 主营文件导入与实际 BullMQ Worker

## 入口与部署

主营 `POST /api/v1/variant-groups/import-excel` 使用 `file` multipart 字段，支持 CSV/XLSX。需要 `asin:write`，带 Origin 时必须匹配 `CORS_ORIGIN`。上传前和上传完成后在短 PostgreSQL 事务内复核当前账号、会话、密码有效期及权限。要求 `AUTH_DATA_AUTHORITY=postgresql`；Legacy 入口保留，本批不切换生产流量。

主库按最终 Legacy 数据导入 →0003→0004→0005 升级。0005 仅为主营导入分组查找增加 ICU collation 和非唯一索引，不改变展示文本或普通组 CRUD 的重复组规则。通过 `psql -X -v ON_ERROR_STOP=1 --dbname <主库> --file packages/db/migrations/0005_import_group_collation.sql` 执行；Compose 已挂载文件至 `/opt/asin-monitor/`，由部署环境提供数据库认证。脚本可重复运行；当前 ICU 版本与 collation 记录不一致时拒绝导入，升级 ICU 后须维护窗口内核实比较规则、重建索引并刷新 collation 版本。

API/Worker 必须使用同一主库、Redis、`BULL_PREFIX` 和共享持久化文件目录。显式设置 `IMPORT_STORAGE_DIRECTORY` 为各进程可访问的绝对路径；同一仓库内省略时均定位仓库根 `var/neo/imports`，独立部署必须显式配置。多个容器可使用不同挂载路径，但必须映射同一持久化卷。文件以 0600、目录以 0700 创建，进程须使用兼容的文件所有者；存储必须支持同卷原子硬链接，禁止使用响应结束即销毁的临时卷。

构建根工作区依赖后运行 `apps/worker/dist/main.js`，`WORKER_ENABLED_QUEUES` 包含 `import` 即注册实际消费者。物理队列为 `import-task-queue`，Neo 前缀固定 `${BULL_PREFIX}:neo`，job 名称为 `asin-import`；不能复制旧 Bull job 数据到 Neo。共享策略沿用每秒一个任务、并发 1、尝试 2 次、指数退避 5 秒、成功保留 1 小时、失败保留 1 天。处理器对已经执行但中断的任务采用下文的明确停止规则，并非所有失败都会自动再跑一遍。

## 输入、兼容与资源边界

默认异步；只有单个 `useAsync` 字段精确等于 `false` 布尔值或字符串 `false` 时同步执行。空格、大小写变体或重复同名字段不作为同步开关。模式字段可以在文件之后。异步成功为 HTTP 200 和原信封 `data: {taskId, status: "pending"}`；同步为原导入计数/错误结果。API 每进程最多同时处理两个上传/同步导入；上传截止 120 秒，整个处理截止 30 分钟。

保留 Legacy 实际列定位、校验优先级、国家集合、ASIN 类型、同组重复、跨组重复及错误顺序。当前 UI 模板的六列为变体组名称、国家、站点、品牌、ASIN、ASIN 类型；可选 ASIN 名称放在类型后，旧七列模板把名称放在类型前存在原列推断问题，兼容测试保留该行为。CSV 保留 BOM/GB18030 检测和旧 ExcelJS 的数值、日期、布尔单元格文本语义。XLSX 使用工作簿中第一张逻辑工作表，处理共享字符串、日期、公式缓存、富文本和合并单元格；不依赖 ZIP 中的工作表文件顺序。

| 边界       | 值                                               |
| ---------- | ------------------------------------------------ |
| 上传       | 1 文件、10 MiB、16 普通字段、字段值 1 KiB        |
| 数据       | 100,000 数据行、256 列、单元格 32,767 字符       |
| 展开文本   | 32 Mi 字符，含重复共享字符串/合并单元格展开      |
| XLSX ZIP   | 1,000 项、声明总大小 128 MiB、单项 64 MiB        |
| 共享字符串 | 32 MiB、500,000 条                               |
| 合并单元格 | 10,000 范围、1,000,000 展开单元格                |
| ASIN 写入  | 每事务最多 1,000 条，单事务 2 秒、SQL 1.5 秒截止 |

超过边界明确失败，不悄悄截断数据。文件保存、CSV 两遍读取及 XLSX XML 解析使用流，不保留完整工作表矩阵；共享字符串和业务导入计划受上述边界约束。XLSX 的旧单元格语义依赖固定 ExcelJS 4.4.0 文档转换器，升级该依赖须重跑真实 Legacy 文件对拍。没有复制旧 `worker_threads` 解析架构。

组依文件顺序独立提交，再进行全文件 ASIN 规范化/去重，最后分块写入。组匹配忽略大小写、重音和尾部空格，复用最新创建的匹配组；同一创建时间再以 ID 确定稳定次序。ICU 非确定性比较用于等值和索引，并在相同规则下生成事务锁键，避免并发导入重复建组。其能力依据 [PostgreSQL 16 collation 文档](https://www.postgresql.org/docs/16/collation.html#COLLATION-NONDETERMINISTIC)；MySQL/ICU 的 Unicode 版本不同，不能把有限 fixture 对拍说成全 Unicode 等价证明。

## 任务、结果与下载

上传流写入私有 `.part` 文件，计算 SHA-256 后原子发布。队列仅保存绑定任务 UUID 的文件引用、字节数、摘要、原文件名和不可变任务身份，不存文件 Buffer。消费者验证实际文件大小、摘要、非符号链接、job ID/名称、元数据 owner/type/subtype/createdAt 和 BullMQ 锁 token。

接受后退出登录不撤回后台授权；取消使用现有任务取消接口。Redis 元数据创建或入队的应答无法确认时，返回固定 500 和 `data: {taskId, status: "unknown"}` 并保留文件。先按该 ID 查询/取消，避免盲目再提交。所有 Redis 控制命令有界等待，禁用离线排队和未确认命令自动重发；不把 Redis 操作放进数据库事务中等待。

完成结果含全文件计数、校验结果、summary、warnings、原文件名和完整 errors，流式保存为绑定 UUID+输入摘要的不可变 JSON 报告，最大 256 MiB。Redis 与 BullMQ 返回值仅含最多 100 条且不超过 100 KiB JSON 编码字节的错误预览；截断时明确给出 `errorsTruncated`、`errorCount` 和完整结果下载提示。计数从不随预览截断。

`GET /api/v1/tasks/:taskId/download` 沿用登录和任务所有者规则，提供已完成的主营导入报告；其他任务类型的文件下载仍待各域迁移。当前会话撤销或非所有者拒绝下载，管理员也不能下载他人的报告。文件引用严格绑定任务，下载前验证大小与摘要；附件为 JSON，带 no-store/nosniff，采用流与背压，每 API 同时最多两个下载，120 秒截止。未完成任务 409，缺失/过期 404，损坏报告返回固定失败信息，不泄露私有路径。

## 中断、重试与清理

消费者在每个分组/分块前检查任务和锁，并每秒检查一次以中断较长解析、结果写盘等阶段。当前事务内在写入前后检查 AbortSignal；中断可撤销尚未提交的当前块，已提交的其他块保留。取消不承诺撤销已写入数据。元数据缺失、身份变化、锁丢失和 Redis 故障停止后续写入，不复活过期记录。

最终报告发布在完成元数据之前。报告已发布而 Redis 完成应答丢失时保留报告和输入，重投读取已有完整结果并恢复终态，不再次写数据库。终态已确认时重投只返回保留结果。如果上次已开始处理、但没有最终报告，任务失败并提示核实已写入数据再导入剩余记录；不自动整文件重跑，把上次提交误算成已存在失败。这里没有跨 PostgreSQL/文件系统/Redis 的分布式事务，也没有数据库分块恢复检查点。

确认任务完成、失败或取消后删除原始输入。运行时每分钟最多扫描 100 个目录项，保留扫描游标并限制 Redis 清理判定时段；未确认上传和残留 `.part` 至少保留一天及配置的完整任务 TTL。pending/processing 任务保护输入，报告保留到元数据和可查询队列记录均消失。Redis 不可用时保留文件。只有导入 Worker 启用时执行周期清理；应按上述上限和保留期监控共享卷容量。

正常关闭立即中断解析和新块，关闭消费者、目录游标、队列和连接池；入口保留整体 10 秒退出上限。跨进程 WebSocket 事件桥仍待迁移，当前通过任务查询/轮询观察状态；完整 D5 出口尚未达成。

## 验证与回滚

`corepack pnpm --filter @asin-monitor/import test` 对真实 Legacy ExcelJS CSV/XLSX 解析、计数与归一化、文件生命周期和完整报告做对拍。API/Worker 测试覆盖上传字段顺序与限制、当前权限复核、未知应答、文件下载、分块取消、锁丢失、终态恢复和关闭。

隔离数据库环境先构建 API/Worker，设置 `RUN_INTEGRATION_TESTS=true`、`INTEGRATION_ALLOW_DROP_DATABASES=true` 及专用 MySQL/PostgreSQL/Redis 连接，再运行 `corepack pnpm --filter api exec vitest run test/asin-import.integration.test.ts`。该测试使用随机数据库/schema/Redis 前缀和临时目录，执行真实旧 Worker+MySQL 与 HTTP→ 新编译 Worker+PostgreSQL，对同一 CSV/XLSX 比较完整结果、组和 ASIN 业务字段/父组关系，并覆盖完整错误报告、并发分组和 Linux 入口关闭。生成 ID 与时间戳不作字节相等要求。是否通过以相应提交的 CI 结果为准。

回滚先停止 Neo 导入接受和消费，核实在途任务与已提交数据，保留完整报告供对账，恢复旧入口。之后可执行 `0005_import_group_collation.rollback.sql` 移除专用索引/collation；导入预检将拒绝执行，其他主营 CRUD 不依赖 0005。回退代码或 SQL 不会撤销已经导入的数据，不清空生产 Redis 或共享卷，不向旧队列搬运 Neo job。
