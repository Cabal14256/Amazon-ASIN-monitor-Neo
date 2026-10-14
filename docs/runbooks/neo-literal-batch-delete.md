# Neo 批量删除的原始 ID 安全边界（Issue #212）

主营和竞品批量删除必须只操作用户提交的原始组/ASIN ID。`" Source Ś "` 与 `"Source Ś"`、`"Case"` 与 `"case"`、`"café"` 与 `"cafe"` 是不同的迁移键。Neo 保留每个字符，原值不存在时返回原值 skipped，不能删除其 trim、大小写或重音邻居。

## 契约与调用链

冻结 `batchDeleteVariantGroupsRequestSchema` 及旧 `parseBatchDeleteRequest` 的 Legacy 口径保持原样，供既有合同和 Legacy 对拍使用。新的 `neoBatchDeleteVariantGroupsRequestSchema`、`neoBatchDeleteTargetsSchema`、`isNeoBatchDeleteId` 与 `parseNeoBatchDeleteRequest` 作为 Neo 明确边界。

- 两域 API service 与 repository 均使用 Neo parser；Worker job schema 重新验证原值字符串、数量和精确去重，不再次 normalize。HTTP → registry/queue → compiled Worker → 每个事务分块保留原值。
- 两个 ID 列表仅接受字符串，真正空串无效；`" "` 是非空合法 ID。最多 50 个 Unicode 码点，50 个 emoji 合法，孤立 UTF-16 surrogate、C0/C1 控制字符无效。两个原始数组合计最多 1000 项，重复项也计入资源边界；只按原字符串精确去重。
- 未提供某个列表等价于空列表，非数组列表或列表中的非字符串拒绝，不进行 Legacy 标量转换。不静默丢弃坏行、截断 ID 或修改 case/accent。
- `useAsync` 沿用既有显式布尔/字符串控制规则与阈值；它的规范化不能用于 ID。公共 Neo typed request 要求布尔值，服务器为既有 HTTP caller 保留控制字段兼容。
- 竞品 bulk 去掉 `rtrim`/CI 表达式，复用既有确定性 literal 主键条件及 exact Set 结果守卫；其余列表搜索/详情策略不在本次改动范围。父组先锁、子项后锁、归属复核、级联/RETURNING 计数及事务截止保持原有策略。

## 明确的 Legacy 安全差异

真实 Legacy `batchDeleteService` 先对输入执行 `String(item || '').trim()`。若存在 `" Source Ś "` 和 `"Source Ś"`，请求前者会实际选中并删除后者；若前者不存在，也会错误删除邻居。Neo 存在原值时只删除原值，不存在时不删除任何邻居。这是 #212 要修复的行为，不能将该案例的不同计数、skipped 或剩余行称作迁移不一致，也不能声称旧新产物在此案例等价。

其它无歧义 ID、子项重叠、缺失目标、同步/异步统计与故障策略继续使用既有 Legacy 对拍。本次没有修改 Legacy 生产 service、冻结 v1 schema 或数据库 DDL，没有生产切流。

## 隔离验证

Integration CI 明确执行现有两条入口：

```sh
pnpm --filter @asin-monitor/api exec vitest run test/asin-batch-delete.integration.test.ts
pnpm --filter @asin-monitor/api exec vitest run test/competitor-batch-delete.integration.test.ts
```

两个入口均验证真实 HTTP 与 compiled BullMQ Worker 的组及直接 ASIN 原值删除，包括首尾空格、全空格、50 emoji、case/accent 邻居，检查队列原始 payload、任务结果及实际剩余行。两域 MySQL 对拍执行冻结 service/controller 的实际 SQL 和事务，在 raw 存在与不存在时证明 trim 危险，并明确期望 Neo 安全差异；日志/cache 等边界 stub 不伪造数据库结果。

PostgreSQL 使用既有随机私有 schema 与真实约束/触发器；MySQL 使用明确 opt-in 的随机私有数据库和真实 Legacy DDL；Redis 使用随机前缀。只有 `RUN_INTEGRATION_TESTS=true` 且 `INTEGRATION_ALLOW_DROP_DATABASES=true` 的一次性环境允许创建/清理 MySQL fixture。测试仅使用合成数据，本地默认 skip 不视为真实验收通过，不加载未知部署 `.env`。

### 本地代码验收记录

基于正常合并 `main` 的 `4a3164d`，在 Windows 以 `NODE_OPTIONS=--max-old-space-size=1536`、Vitest 单 worker 串行验证：

| 检查 | 结果 |
| --- | --- |
| API/Worker 依赖图九包 build | 通过 |
| contracts / config | 213 / 41 passed，无 skip |
| DB 默认排除四项数据库运维集成入口的 suite | 893 passed / 227 skipped |
| API 全套 | 1710 passed / 549 skipped |
| Worker 全套 | 250 passed / 41 skipped |
| 改动 API/Worker/DB 测试及 helper 的 expanded strict | 通过，不降低 strict |
| 根 contracts / Legacy server unit / URL 与格式工具 | 40 / 55 / 8 passed |
| `max setup` 后根 `tsc --noEmit` | 通过 |

DB 的 227 skip 包含 13 项仅 Linux 可运行的部署脚本测试，其余及 API/Worker skip 是未开启实际服务 opt-in。两域批量删除实际入口包含 54 项集成测试，默认 skip；它们须在 Integration CI 执行，不能以本表替代实际 SQL/BullMQ/Legacy 对拍。未触及 Web 与 Legacy 前端源码，本地未重复其全套/构建；它们由 CI 基线运行。所有 18 个变更文件 Prettier 与 `git diff --check` 通过。

常规生产 build 和改动范围 expanded strict 分别验证；全 API 测试目录扩大 `tsc` 的检查存在既有未触碰 helper/ops 类型及 rootDir 错误，未冒称该检查通过，也未修改项目 tsconfig 规避它。

## Web 临时限制与回滚

#211 的 UI 在后端修复前暂时拒绝首尾空格 ID。#212 不依赖未合并的 UI 分支；两项正式进入主线后，必须用同一 Neo helper/typed schema 放回原值可选能力并补 mounted POST 原值验证。暂时拒绝不能当作 API 风险已修复，也不能宣称 Web 原始 ID 功能零缺失。

没有数据库迁移。回滚前停止 Neo 批量删除新提交、记录并核实或取消在途任务，再停止相应 Worker；旧版本可能不接受 raw job，不能让它直接消费原值任务。回滚代码不会恢复已删除数据，且会重新引入 trim 邻居风险；恢复旧版本前应禁用 Neo bulk 入口并保留操作证据。未知提交仍不可自动重发。
