# P2：ASIN 变体组列表与详情

关联 Issue #83。Neo 新增 `GET /api/v1/variant-groups` 与 `GET /api/v1/variant-groups/:groupId`，读取 PostgreSQL 主库，供业务页面接入。创建、更新、删除、人工异常写入、批处理、导入和变体检查仍由后续迁移交付；本次保留全部 Legacy 路径，无 DDL 或生产切流。

## 查询与响应

列表保留 keyword、country、variantStatus、current、pageSize，以及 list/total/totalASINs/current/pageSize 的既有信封。分页默认 1/10；空分页值按缺省处理，pageSize 最大 100，偏移最多 1,000,000。keyword 最多 200 字符，country 最多 10 字符，不允许控制字符；variantStatus 支持 BROKEN/NORMAL 或空值。拒绝重复参数形成的数组、对象及非法数值。详情 ID 最多 50 个 Unicode 码点，不剪裁或解释 SQL 字符串。

关键词在组名、组 ID 和 ASIN 代码中不区分大小写匹配，保留旧 LIKE 的 `%`、`_` 通配符语义；国家是不区分大小写的精确值，不把国家中的通配符当模式。所有值经 Drizzle 参数绑定。PostgreSQL 的 Unicode/重音比较与 MySQL 的具体 collation 并非完全相同，切流前须以真实组名和查询词核查这些边界；不把 ILIKE 测试通过视为排序规则完全等价。

组按创建时间倒序、ID 倒序稳定分页；空创建时间排最后。子项按组、创建时间正序、ID 正序排列，空创建时间排最前，对齐原 MySQL 空值排序。整页子项最多 5,000；查询 5,001 条哨兵后整体返回 413，不交付不完整 children 或用其计算虚假的组状态。缩小页大小或筛选可以减少整页子项；单个超大组需使用后续导出路径或继续从 Legacy 读取。

## 计数与兼容修正

- total 按组的国家、关键词和有效异常状态计算，和列表共用同一筛选表达式。旧实现的关键词 COUNT 强制要求存在子项，导致按名称搜到的空组未计入 total；Neo 修复该不一致，空组也计入总数。
- asin_count 保留旧关键词计数：只命中某个子项代码时计数可能小于 children 长度；children 始终包含选中组的全部子项，组状态也依赖全部子项。
- totalASINs 保留旧独立口径：按子 ASIN 自身的国家、有效异常和关键词计算，不把组的筛选结果简单累加。例如 US 组含 UK 子项，country=US 可显示组但 totalASINs 为 0；country=UK 可以 total 为 0、totalASINs 为 1。
- 列表、total、totalASINs、页内组及子项在单条 SQL 的 MVCC 快照中读取；并发写入不会让同一次响应混用数个时点的数据。

保留组的下划线字段、驼峰别名、装饰后子项，以及 MAIN_LINK/SUB_REVIEW 到 1/2 的历史类型映射。PG boolean 转为原 0/1/null，飞书开关 null 的有效值仍为 1。聚合 JSON 通过 schema 的 column codec 恢复 Date，使用 D8 上海墙钟规则后输出 ISO 时间。实际旧模型会返回 null 创建/更新时间，本次补齐既有契约这六处 nullable 缺口，不丢弃字段或伪造时间。

## 有效状态

共享状态函数与实际 Legacy `variantStatus.js` 作 162 组组合对拍。有效异常为自动异常、自身人工异常或未被排除的父组人工异常。排除组人工标记仅取消继承，不清除自身人工或自动异常；原因、更新人和时间优先取自身人工标记。

组有效状态包含子项的自动与自身人工异常，但组 manualBroken 字段仅表示组自身的人工标记。这允许组 manualBroken=0、statusSource=MANUAL：异常来自子项。数据库筛选与响应装饰使用同一规则，不能仅按原始 is_broken 列筛选。

## 当前权限、容量与超时

两个路由均要求登录及 asin:read，返回 no-store。在 PostgreSQL 为鉴权权威源时才启用；Legacy 鉴权模式返回明确 503。

数据事务显式使用 READ COMMITTED，先获取共享 RBAC advisory lock，再对当前操作者和会话获取共享行锁，检查当前账户、密码、会话及权限。共享锁允许多个读者并行，和既有管理写事务的排他锁互斥；等待写者提交后才查询最新权限，Redis 中旧权限不能替代该检查。会话撤销和密码状态修改也不能越过持有的行锁。

API 最多 8 个活动查询，仓储最多 16 个事务，复用现有独占连接的 1,500ms SQL／2 秒事务期限；超时销毁实际连接。输入/超量响应使用固定 400/413，忙碌使用 429，缺失组使用既有 404，其他失败由全局过滤器返回固定 500。日志仅记录固定操作与原因，不包含关键词、SQL、ASIN 或驱动异常原文。

## 验证与回滚

本地覆盖共享状态、实际旧模型完整 JSON 对拍、参数与 HTTP 权限/容量/错误；真实集成沿用随机私有 PG schema、无 public search_path 回退、自有用户及 Redis 权限缓存清理。11 个用例覆盖真实时间、空组总数、完整 children、国家/异常口径、参数绑定、RBAC 撤权、共享读锁、并发提交快照、超大组和 SQL 等待恢复。

完整 17 项基线加 db 类型/构建、API 测试类型检查及契约测试；Integration 单独执行 `test/asin-query.integration.test.ts`。本地没有隔离 PG/Redis 时跳过实际服务用例，必须待 CI 实际通过后合并。fixture 不替代生产数据规模、灰度或影子对拍验收。

回滚本提交移除两个 Neo 端点、模块及新增查询代码；没有数据或 DDL 回滚，Legacy 功能继续保留。
