# P2：主营监控历史列表与详情

关联 Issue #107。新增 `GET /api/v1/monitor-history` 和 `GET /api/v1/monitor-history/:id`，读取 PostgreSQL 主库。保留 Legacy 路径；本次没有生产切流。统计、状态区间、检查调度和竞品历史由后续 Issue 迁移。

## 输入与筛选

保留 variantGroupId、asinId、asin、variantGroupName、asinName、asinType、country、checkType、isBroken、startTime、endTime、current、pageSize。默认分页 1/10，每页最多 100，偏移最多 1,000,000；重复参数形成数组、控制字符、非法日期和超长值返回 400。

ASIN 按逗号或空白拆分并去重，最多 1,000 项；一项使用子串匹配，多项使用精确 IN。名称筛选优先使用历史快照，只有 SQL NULL 才回退当前对象名称；空字符串不回退。`1/MAIN_LINK`、`2/SUB_REVIEW` 保留旧类型别名，其他类型直接比较。只有大写 EU 展开 UK/DE/FR/IT/ES。isBroken 非空时只有字符串 `1` 表示异常，其他值按原模型比较正常，NULL 不匹配任一布尔状态。

时间是上海 DATETIME 墙钟，边界包含端点。接受 `YYYY-MM-DD`（午夜）、`YYYY-MM-DD HH:mm:ss` 或 T 分隔符以及最多三位毫秒。不接受带 Z/偏移量的时间，调用方须先转为上海墙钟；当前 Legacy 页面使用这一墙钟格式。详情 ID 必须是正的安全整数，不能将超出 JavaScript 精度的 ID 四舍五入。Timescale 复合主键若存在同 ID 不同时间的异常重复记录，详情整体失败，避免随机选取。

## 完整响应与一致性

列表保留 list/total/current/pageSize，详情保留原字段和所有驼峰别名。状态和通知字段返回 0/1/null，日期经过 D8 codec 输出 ISO，真实 NULL 不替换为虚构默认值。check_result/checkResult 都保留完整 JSONB 文本；JSONB 会规范化原 MySQL TEXT 的空白和键顺序，因此跨库比较解析后的完整 JSON 值，不宣称字节一致。

历史关联对象删除后，保留记录和当时的名称/代码；没有快照且对象已删除时返回 NULL，asin_type 来自当前对象。列表和总数在同一条 SQL 的 MVCC 快照内读取，按 check_time、id 倒序稳定分页，不使用可能过期的旧总数缓存。

先选取页内主键，再在数据库内计算完整 JSON 字符串响应的字节上界（两个别名各一份，加每行 16 KiB 元数据余量）。超过 64 MiB 时整体返回 413，最终 JSON 聚合位于 CASE 保护分支，避免在应用内先构造超量列表。没有截断、摘要或伪装成功的部分结果。

## 比较规则与迁移边界

0007 复用 0005 的 ICU 一级比较规则。等值/IN 比较忽略大小写、重音和尾部 ASCII 空格，延续 0001 持续聚合和 0005 导入的 `utf8mb4_unicode_ci` 比较契约。PostgreSQL 16 的 LIKE 不支持 nondeterministic collation，因此名称/单 ASIN 使用有界 SQL 函数逐字符匹配，保留 `%`、`_`、反斜杠转义、尾部空格意义以及 LIKE 与等值的字符展开差异（例如 Straße 与 strasse）。函数不使用递归或用户正则，输入最多 500 字符、模式最多 502 字符，并受查询超时限制。

真实 MySQL fixture 使用仓库原 controller/model/表结构，显式指定 utf8mb4_unicode_ci，和现有持续聚合迁移契约一致。MySQL 8 在表仅指定 DEFAULT CHARSET 时可能采用 utf8mb4_0900_ai_ci，它对尾部空格的行为不同；fixture **不能证明未检查的生产列实际使用哪种 collation**。切流前须逐列核实源库排序规则、ICU 版本及真实名称/查询词对照。ICU 与 MySQL Unicode 权重版本仍可能存在边缘字符差异。历史关联 ID 也使用该比较规则，0007 为两张当前对象表建立对应的唯一表达式索引，防止新库出现旧库不允许的歧义 ID，并支持索引连接。升级若遇到既有歧义 ID 必须停止，不自动合并数据。

## 当前权限、容量和错误

两个端点要求登录和 monitor:read，返回 no-store。AUTH_DATA_AUTHORITY 不是 postgresql 时返回 503。事务在共享 RBAC advisory lock 以及当前用户、会话共享行锁下复核账户、密码、会话和实时权限；Redis 中旧权限不能放行已提交的撤权。

API 最多两条活动请求，仓储最多四个事务。1,500 ms SQL／2 秒事务期限复用现有数据库期限实现。API 并发名额在数据库操作结束且响应发送完成/连接关闭后才释放；慢客户端最多保留响应 60 秒。输入、缺失、超量和繁忙分别返回固定 400/404/413/429，数据库失败返回固定 500。logger 只记录固定操作与原因，不记录查询词、原始驱动异常或结果载荷。

## 升级与回滚

在主库完成最终快照及 0003—0006 后、启用本模块前执行 0007。Compose 已挂载升级和回滚文件，升级可重复执行；它安装函数、两个 ID 唯一表达式索引并校验既有 ICU collation，不重写历史数据，也不修改竞品库。

```sh
docker compose --env-file .env.neo -f compose.neo.yml exec -T timescaledb sh -c 'psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --file /opt/asin-monitor/0007_monitor_history_matching.sql'
```

回滚先恢复本模块加入前的 API，再执行同一命令，将文件名换为 `0007_monitor_history_matching.rollback.sql`。回滚只删除该函数和这两个索引，保留历史数据和导入仍使用的 0005 collation。生产执行需沿现有数据迁移/切流门禁，不在开发过程中自动操作生产库。

## 验证

本地覆盖真实 Legacy 模型字段对照、原 controller 的多 ASIN 规则、SQL 参数绑定/容量预检、HTTP 当前授权以及响应结束前的并发控制。Integration 使用随机私有 MySQL database、PG schema 和自有 Redis 权限缓存；业务查询无 public 表回退。完整比较列表/详情/筛选结果，验证删除快照、NULL、时间、LIKE 转义、同一 MVCC 快照、撤权、锁超时、大结果及迁移重复执行/回滚。

合并前执行仓库 17 项基线、db/API 测试类型检查和 URL 合并检查。没有本地隔离 PG/MySQL/Redis 时，集成用例仅能在 CI 验证，跳过不是通过。生产规模性能、源数据对账、灰度及 Legacy 退役门禁仍须单独完成。
