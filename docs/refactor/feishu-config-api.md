# 主营飞书配置 API

关联 #115、#164。Neo 提供六个主营飞书配置入口，使用 PostgreSQL 权威源和当前 `settings:read` / `settings:write` 权限。Legacy 路径继续保留。配置管理完成不代表通知发送器、重试队列、监控 Worker 或生产切流完成。

## 接口和兼容语义

以下路径均以 `/api/v1/feishu-configs` 为前缀，成功响应保持 `{ success: true, data, errorCode: 0 }`。

| 方法与后缀 | 权限 | 行为 |
| --- | --- | --- |
| GET | settings:read | 只列出 US/EU 配置，包含禁用和 NULL 标记；按国家排序，返回旧 camel 字段及 revision |
| GET /:country | settings:read | 查询启用配置，返回旧 snake 字段及 revision；找不到时 404 |
| POST | settings:write | 使用 body.country 和 expectedRevision 新增或更新，默认启用，返回 camel 字段，状态码 200 |
| PUT /:country | settings:write | 与 POST 相同，以 body.country 为准，不使用路径中的 country |
| DELETE /:country | settings:write | 按原始国家删除，缺失时也返回 200 和“删除成功” |
| PATCH /:country/toggle | settings:write | 按原始国家修改 enabled，再按地区规则查询启用配置；返回 snake 字段或 404 |

GET 详情和 toggle 的查询阶段仅把精确大写 UK/DE/FR/IT/ES 映射为 EU。DELETE 和 toggle 的更新阶段不做地区映射。关闭 EU 配置会先提交禁用，再返回“配置不存在”的 404；不能将此结果当作写入失败而自动重试。若 UK 不存在而 EU 启用，toggle UK 可以没有更新任何行却返回 EU；这些既有行为均保留并对照实际旧控制器验证。

国家比较沿用 MySQL 不区分大小写、重音及尾部空格的等值语义。更新已有配置保留其原始 country 标签与 ID；不会把 `us ` 改名为 `US`。列表与详情保留数据库 NULL 标记及 NULL 时间，非 NULL 布尔值映射为 0/1。所有数据库墙上时间按 UTC+8 转为 ISO。

输入遵循已有共享写契约：enabled 只接受布尔值或 0/1；国家最多 10 个 Unicode 码点，Webhook 最多 500 个，禁止空值和 NUL。读契约允许数据库既有 enabled=NULL，写请求仍不接受 NULL。非法输入返回 400。

所有 Neo 读响应含不透明 UUID `revision`。新建时发送 `expectedRevision: null`；更新时发送从最新读响应取得的 `expectedRevision: "<revision>"`。服务端在 PostgreSQL 事务中比对当前版本，成功写入、toggle 后生成新版本。版本过期、以空版本覆盖已有行、以旧版本新建、并发创建失败均返回固定 409“配置已变更，请刷新后重试”，不泄露 Webhook。旧 Neo 客户端若省略 `expectedRevision`，只可创建尚不存在的配置；尝试修改已有配置会收到 409，需升级客户端。Legacy 响应没有 revision；共享读契约继续兼容它。删除并重建会得到新 UUID，旧版本无法误写重建后的行。toggle 的请求仍按既有接口接受 enabled；它生成新版本，所以同时打开的编辑页保存旧版本会收到 409。

## 权限、事务和凭据

需要 `AUTH_DATA_AUTHORITY=postgresql`；切换前返回 503。每次操作在事务内取得管理锁，然后复核当前账户、密码策略、会话和权限。读操作也复核当前写权限：只有 settings:read 的用户看到 `***REDACTED***`；同时具有 settings:write 的读用户和授权写响应可以获得完整 Webhook。这是明确的 Neo 凭据保护策略，与既有 SP-API 配置策略一致。

所有 Neo 配置事务共用管理排他锁，确保等值国家的并发创建不会产生两行，也不能越过已提交的权限撤销。更新语句另以 `id` 和 `revision` 做原子条件写；插入时若撞上数据库已有唯一键则返回 409。SQL 失败连同版本变动一起回滚；关闭后 404 则在事务成功提交后生成。既有 PostgreSQL 唯一索引不能完全约束尾空格等值行，不遵守管理锁的外部写入若造成歧义，查询返回固定 500，不任意选取某一条。

响应使用 `Cache-Control: no-store`。写请求存在 Origin 时必须匹配配置的 CORS_ORIGIN。审计记录 POST/PUT/PATCH 为 UPDATE、DELETE 为 DELETE；保存实际响应状态，包括已提交禁用的 404。Webhook 在审计中遮盖，日志只记录操作类型和固定错误原因，不记录请求正文、SQL、驱动错误或连接详情。

## 资源限制和回滚

API 服务每进程限制 8 个正在执行的配置操作，仓库限制 16 个包含连接池等待的事务；超量返回 429。连接获取使用现有应用池期限，获得连接后事务总期限 2 秒、单条 SQL 1.5 秒。数据库失败返回固定 500；不返回部分结果。

最终 Legacy 数据导入后，在主营 PostgreSQL 数据库运行 `packages/db/migrations/0013_feishu_revision.sql`；它对已有行补齐 UUID，设置新行默认值和非空约束，可重复执行。Compose 环境先运行 `corepack pnpm db:up` 更新已有容器的挂载，再执行 `corepack pnpm db:upgrade:feishu-revision`。外部环境使用受控连接执行 `psql -X -v ON_ERROR_STOP=1 --dbname <主营库> --file packages/db/migrations/0013_feishu_revision.sql`，不在命令或日志中放入凭据。先完成数据库升级，再部署要求 `expectedRevision` 的 Neo API 和客户端。禁止直接修改冻结的 `0000_baseline.sql`。

回滚时先停止 Neo CAS 写入客户端与 API，再在 Compose 环境执行：

```sh
docker compose --env-file .env.neo -f compose.neo.yml exec -T timescaledb sh /opt/asin-monitor/apply-feishu-revision.sh /opt/asin-monitor/0013_feishu_revision.rollback.sql
```

回滚仅删除 revision 列并保留 Webhook 行；新版 Neo API 无法在回滚后的表上运行。Legacy 生产入口保持可用。未调用真实 Webhook。

## 验证方法

单元与 HTTP 测试覆盖完整字段、国家映射、NULL、输入上限、当前权限、Origin、并发容量和脱敏。Integration 工作流在一次性 MySQL 数据库和 PostgreSQL 私有 schema 中执行实际旧模型/控制器与 Neo HTTP，比较既有响应字段、状态码及存储副作用；另验证两位管理员持同一版本并发更新、并发创建、toggle 后旧版本、删除重建、撤权、SQL 失败回滚和审计。工作流对 0013 重复应用并验证回滚后重装。

测试显式安装 PostgreSQL 基线的更新时间触发器，因为 `LIKE INCLUDING ALL` 不复制触发器。MySQL 测试连接明确设置并检查 `time_zone=+08:00`，使 NOW()/DATETIME 默认值符合 D8 墙上时间；仅设置 mysql2 驱动的 timezone 不会改变数据库会话时区，CI 默认 UTC 会使旧响应的新时间偏移八小时。生产对拍前也必须核查旧库实际会话时区，不能假设驱动配置已完成这一步。

历史时间与 NULL 逐值精确比较；新写入时间分别要求为正确 ISO 且处于实际操作的当前时间范围，然后进行语义比较，允许 MySQL DATETIME 秒精度和 PostgreSQL 毫秒输出及两次写入时刻的差异。国家、ID、Webhook、标记及其他字段不做归一化。该验证不能替代生产数据对拍与后续阶段切流门槛。
