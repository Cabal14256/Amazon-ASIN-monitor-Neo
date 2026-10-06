# Neo 检查目标使用原始目录 ID

关联 Issue #227。Neo 主营和竞品单项检查、主营批量检查及主营监控快照重试统一使用数据库原始 ID。冻结 REST v1 schema 与 Legacy 生产源码不变。

## 校验与匹配

`packages/contracts/src/domains/neo-catalog-id.ts` 提供与既有 Neo 批量删除一致的目录 ID 校验：非空字符串，最多 50 个 Unicode 码点，拒绝 C0/C1 控制字符、DEL 和孤立 surrogate。50 个 emoji 可以合法通过；全空格、前后空格、大小写、重音和 Unicode 组合方式保持原值。此规则校验存储目标，不校验 ASIN 编码、用户身份、任务 UUID 或时间字段。

- 私有 BullMQ 检查 payload 与执行器重新校验原值，不 trim、不大写、不进行 Unicode normalize。
- 双域检查仓库在读取或锁定目标时校验，并使用字面主键 `id = 原值`。竞品读取不再使用 `rtrim(id) COLLATE neo_competitor_query_ci`，缺失原始目标返回不存在，不能用相近的已存目录代替。
- 主营监控首次目录与已保存快照采用同一校验。首次选择和重试均保留原始 ID、国家顺序与已保存成员；任务身份、重复项、分批与收据摘要不重新生成。
- 数据库已有迁移索引保持不变。不能共存的尾空格或大小写/重音邻居不被伪造为同库夹具；缺失原值的测试只存一张合法邻居记录。

## 与 Legacy 的安全差异

MySQL 的冻结 `utf8mb4_unicode_ci` 比较可能把不存在的 `Tail `、`case`、`cafe` 分别匹配为已存 `Tail`、`Case`、`café`。原竞品服务因此会检查并更新该邻组或邻 ASIN。Neo 改为拒绝缺失的原始目标，不产生商品请求、目录更新、历史或成功收据。这是修复危险选择行为的明确安全差异，不能声称此场景与 Legacy 产物等价。

`apps/api/test/helpers/literal-check-legacy.ts` 在随机私有 MySQL 数据库执行原 `competitor-init.sql` 三张表的 DDL，以及真实冻结检查 service、model 和 history 源码。只替换外部观测、缓存、配置和日志边界，查询及更新结果均由真实 MySQL 返回。使用 BINARY 查询先证明不存在请求的字面 ID，再检查实际邻居发生了更新。

## 隔离验收

`apps/api/test/literal-check-targets.integration.test.ts` 显式接入现有 Integration workflow 的编译 Worker 检查步骤，共 45 项：

- 32 项覆盖双域 group/ASIN、同步/异步检查、前空格/尾空格/全空格/50 emoji，经过实际 Nest HTTP、Redis/BullMQ、编译 Worker 和双 PostgreSQL，验证原始队列 payload、目录、历史及收据身份。
- 12 项使用真实 MySQL Legacy 与 PostgreSQL Neo 验证上述危险邻居差异。Neo 同步及异步请求在受理前返回 404；异步场景额外显式放入一张私有旧任务，证明实际编译消费者仍拒绝缺失原始目标。该旧任务由测试 producer 构造，不宣称其由被拒绝的 HTTP 请求产生。
- 1 项使用原生 PostgreSQL 验证主营监控原始快照首次保存和重试一致。

仅当 `RUN_INTEGRATION_TESTS=true` 且 `INTEGRATION_ALLOW_DROP_DATABASES=true` 时连接真实隔离服务。PostgreSQL 只使用随机私有 schema；MySQL 清理仅删除匹配本夹具随机名称的数据库；Redis 只清理本夹具前缀。CI 已构建实际 Worker，不以源码 mock 替代消费者。

本机未授权真实数据库连接时，这 45 项必须报告 opt-in skipped，不计为通过。单元证据使用实际 Drizzle SQL 生成和映射，仅替换数据库 transport；契约及执行器另验证超限、控制字符、孤立 surrogate、重复顺序和冻结 v1 行为。

## 风险与回滚

旧私有任务若含 51–100 个目录 ID 字符或不安全字符，将明确失败，不能继续检查一个无法用数据库原始主键表示的目标。合法的 50 个非 BMP 字符原先被 UTF-16 长度拒绝，现在可以检查和恢复。

没有新迁移或环境参数。回滚应用代码会恢复旧匹配行为及其已知邻居写入风险；保留已写入任务、快照和收据，不能通过删除记录来重放商品业务。生产切换与 Legacy 退役另行验收。
