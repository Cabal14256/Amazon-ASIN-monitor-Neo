# Neo 检查目标使用原始目录 ID

关联 Issue #227。Neo 主营和竞品单项检查、主营批量检查及主营监控快照重试统一使用数据库原始 ID。冻结 REST v1 schema 与 Legacy 生产源码不变。

## 校验与匹配

`packages/contracts/src/domains/neo-catalog-id.ts` 提供与既有 Neo 批量删除一致的目录 ID 校验：非空字符串，最多 50 个 Unicode 码点，拒绝 C0/C1 控制字符、DEL 和孤立 surrogate。50 个 emoji 可以合法通过；全空格、前后空格、大小写、重音和 Unicode 组合方式保持原值。此规则校验存储目标，不校验 ASIN 编码、用户身份、任务 UUID 或时间字段。

- 私有 BullMQ 检查 payload 与执行器重新校验原值，不 trim、不大写、不进行 Unicode normalize。
- 双域检查仓库在读取或锁定目标时校验，并使用字面主键 `id = 原值`。竞品读取不再使用 `rtrim(id) COLLATE neo_competitor_query_ci`，缺失原始目标返回不存在，不能用相近的已存目录代替。
- 主营监控首次目录与已保存快照采用同一校验。首次选择和重试均保留原始 ID、国家顺序与已保存成员；任务身份、重复项、分批与收据摘要不重新生成。
- 数据库已有迁移索引保持不变。不能共存的尾空格或大小写/重音邻居不被伪造为同库夹具；缺失原值的测试只存一张合法邻居记录。

检查批次沿用实际 Legacy 逐项执行政策：`variantCheckController.js` 的同步 `runWithConcurrency(groupIds)` 与 `batchCheckTaskProcessor.js` 的异步 `groupIds[index]` 均保留原数组顺序及重复项。Issue 所述“首次去重顺序”不能据此改变已受理检查任务的 ordinal；目录批量删除原有的首次去重仍由其独立 parser 保留，共享校验器只校验原值。相同 ID 的不同 ordinal 使用不同 operation key、相同原请求摘要；重试只能恢复原 ordinal 的收据。

## 与 Legacy 的安全差异

MySQL 的冻结 `utf8mb4_unicode_ci` 比较可能把不存在的 `Tail `、`case`、`cafe` 分别匹配为已存 `Tail`、`Case`、`café`。原竞品服务因此会检查并更新该邻组或邻 ASIN。Neo 改为拒绝缺失的原始目标，不产生商品请求、目录更新、历史或成功收据。这是修复危险选择行为的明确安全差异，不能声称此场景与 Legacy 产物等价。

`apps/api/test/helpers/literal-check-legacy.ts` 在随机私有 MySQL 数据库执行原 `competitor-init.sql` 三张表的 DDL，以及真实冻结检查 service、model 和 history 源码。只替换外部观测、缓存、配置和日志边界，查询及更新结果均由真实 MySQL 返回。使用 BINARY 查询先证明不存在请求的字面 ID，再检查实际邻居发生了更新。

## 隔离验收

`apps/api/test/literal-check-targets.integration.test.ts` 显式接入现有 Integration workflow 的编译 Worker 检查步骤，共 46 项：

- 32 项覆盖双域 group/ASIN、同步/异步检查、前空格/尾空格/全空格/50 emoji，经过实际 Nest HTTP、Redis/BullMQ、编译 Worker 和双 PostgreSQL，验证原始队列 payload、目录、历史及收据身份。
- 12 项使用真实 MySQL Legacy 与 PostgreSQL Neo 验证上述危险邻居差异。Neo 同步及异步请求在受理前返回 404；异步场景额外显式放入一张私有旧任务，证明实际编译消费者仍拒绝缺失原始目标。该旧任务由测试 producer 构造，不宣称其由被拒绝的 HTTP 请求产生。
- 1 项使用原生 PostgreSQL 验证主营监控原始快照首次保存和重试一致。
- 1 项经真实主营批量 HTTP → BullMQ → 编译 Worker 检查前空格、全空格、50 emoji 与重复组，核对原队列数组、完整结果顺序、每个 ordinal 的不可变任务/请求摘要及实际商品请求次数；保留批量检查不写监控历史的既有行为。

仅当 `RUN_INTEGRATION_TESTS=true` 且 `INTEGRATION_ALLOW_DROP_DATABASES=true` 时连接真实隔离服务。PostgreSQL 只使用随机私有 schema；MySQL 清理仅删除匹配本夹具随机名称的数据库；Redis 只清理本夹具前缀。CI 已构建实际 Worker，不以源码 mock 替代消费者。

本机未配置并启用隔离服务时，这 46 项必须报告 opt-in skipped，不计为通过。单元证据使用实际 Drizzle SQL 生成和映射，仅替换数据库 transport；契约及执行器另验证超限、控制字符、孤立 surrogate、重复顺序和冻结 v1 行为。

## 本地恢复验证（2026-10-09）

复用已有 `fix/227-literal-check-targets` 实现 `5d29adc`，普通合并 `origin/main` 的 `3df5a2a`，保留主营历史 preflight 的 Integration 步骤。没有复制尚未合入的 catalog fence；未来同步该依赖后，私有旧任务 producer 仍需按新的受理边界重新验收。

完整 18 项基线全部通过：根契约检查、Legacy server 单元和 Umi 构建、contracts/config/db/api/worker/web 全套、Web lint/build/typecheck、API/Worker/DB 构建、根 TypeScript、变更格式测试及 `git diff --check`。包测试逐项串行使用 `--maxWorkers=1 --no-file-parallelism`，依赖构建使用单 workspace 并发，Node 堆上限为 1536 MiB。

| 验证 | 本次结果 |
| --- | --- |
| Legacy server 单元 | 55 通过 |
| contracts / config 全套 | 285 / 41 通过 |
| DB 全套 | 957 通过，231 项真实服务 opt-in 跳过 |
| API 全套 | 1710 通过，595 项真实服务 opt-in 跳过；包含本文件的 46 项 |
| Worker 全套 | 250 通过，41 项真实服务 opt-in 跳过 |
| Web 全套 | 851 通过，无跳过 |
| variant-check 全套及测试 strict | 124 通过，21 项真实仓库 opt-in 跳过；strict 通过 |
| 原值契约 / 仓库定向 | 89 / 63 通过 |
| 新增 API 集成及两个 helper / DB 原值测试 strict | 使用继承项目 strict 配置的独立临时 tsconfig，全部通过 |
| DB 大数据 Legacy oracle | 10k ASIN × 30 天摘要，6352 ms；原 10 秒期限和精确摘要断言不变 |

本次未启用 PostgreSQL、MySQL 或 Redis 隔离服务，以上 opt-in 项不能作为真实消费者运行成功的证据；真实 46 项仍由现有 Integration workflow 验收。

原失败记录也保留：首次仓库定向测试因该工作树尚未构建 `@asin-monitor/sp-api` 的 `dist` 而在收集阶段退出、没有运行测试；标准依赖构建后，同一测试 63 项通过。根 TypeScript 首次缺少 Umi 开发期 `src/.umi` 类型入口；执行仓库标准 `npm run setup` 后原命令通过，只生成被忽略的文件，没有修改 Legacy 源码或 tsconfig。

首次完整 API 的一个未修改 Legacy 权限用例触发默认 5 秒超时；同一原期限单独运行 4 项全部通过（首项 507 ms），随后完整 API 1710 项通过。没有提高超时或放宽断言。验证台账、初始失败日志及最终成功日志保留在本机 `%TEMP%/neo-227-verification`；这份本地证据不代替发布后的 CI、Integration 和 Review。

## 风险与回滚

旧私有任务若含 51–100 个目录 ID 字符或不安全字符，将明确失败，不能继续检查一个无法用数据库原始主键表示的目标。合法的 50 个非 BMP 字符原先被 UTF-16 长度拒绝，现在可以检查和恢复。

没有新迁移或环境参数。回滚应用代码会恢复旧匹配行为及其已知邻居写入风险；保留已写入任务、快照和收据，不能通过删除记录来重放商品业务。生产切换与 Legacy 退役另行验收。
