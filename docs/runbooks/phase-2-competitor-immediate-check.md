# P2：竞品 ASIN 与变体组即时检查

Issue #178 为 Neo 竞品即时检查建立独立闭环。两个入口读取竞品 PostgreSQL，操作者、会话和 `asin:read` 权限仍在主营 PostgreSQL 复核；检查结果只写竞品状态、竞品监控历史和竞品回执，不写主营 ASIN 或主营历史。Legacy 入口继续保留，生产流量切换不属于本阶段。

## 数据库升级

`0014_competitor_check_receipts.sql` 只安装在 `COMPETITOR_DATABASE`。它创建完成回执表、任务所有权索引和过期索引，支持 BullMQ 重试、未知提交核实和重复执行幂等。启用竞品即时检查 Producer/Worker 前，先升级现有竞品库：

```sh
corepack pnpm db:upgrade:competitor-check-receipts
```

Compose 同时挂载升级与回滚文件；新卷初始化仍由基线负责，已有数据库必须使用显式升级命令。不要把 0014 应用到主营库，也不要在应用事务中自动创建表。

## 检查与提交

- 单项和组检查默认同步返回完整结果，兼容正在使用的 Legacy 页面；显式 `useAsync: true` 才创建带任务身份的异步任务，两种请求复用同一管线。非法路径 ID 在入队前返回 400。
- 提交后的缓存清理最多 8 路并发、共享 2 秒截止时间；清理失败不改写已提交的检查结果，关闭服务会中断清理。空分组保留数据库中的既有分组状态且不写新历史；响应与实际 Legacy `CompetitorVariantGroup.findById` 一致，`groupSnapshot` 按子项派生为 NORMAL，顶层 `isBroken: true` 表示没有 ASIN，不能将两者混为持久化状态。
- Neo 任务中心为等待或执行中的竞品即时检查显示取消入口，且尊重 API 的 `canCancel` 标记；取消中及已完成、失败、取消的任务不再显示按钮。取消请求沿用任务所有权校验，运行中任务在安全检查点停止。
- 组检查对每个 ASIN 单独记录成功、确定 `NOT_FOUND` 或上游 `SP_API_ERROR`。可取消、超时、容量和依赖关闭会终止整组，其他上游错误继续检查剩余 ASIN。
- 网络检查不持有数据库事务；提交阶段重新锁定并比较组、ASIN 快照，状态与 GROUP/ASIN 历史在同一个竞品事务内写入。
- 回执写入与业务提交使用同一竞品事务。提交后若连接在确认前中断，Worker 通过回执核实，不重复历史。
- Catalog 检查以 `owner=competitor` 运行，使用共享缓存的 claim 栅栏；提交后不重写成功结果，以免较早提交的任务覆盖较新检查的缓存。上游失败项在提交后失效，且只为确定 `NOT_FOUND` 清理延迟记录。缓存清理失败只产生脱敏告警，不回滚已经提交的业务状态。

## 回滚

先停止竞品即时检查 Producer/Worker，处理或记录 Neo 在途任务，再恢复不依赖回执表的应用版本。使用同一 Compose 容器执行：

```sh
docker compose --env-file .env.neo -f compose.neo.yml exec -T timescaledb sh -c 'psql -X -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$COMPETITOR_DATABASE" --file /opt/asin-monitor/0014_competitor_check_receipts.rollback.sql'
```

回滚脚本只删除竞品回执表，不删除竞品状态或历史；回滚后不能重放仍引用已删除回执的 Neo 任务。需要恢复即时检查时，先重新应用正向迁移并确认表存在，再启动 Producer/Worker。Legacy 数据库和队列不做清空或复制。

## 验证

本地可运行：

```sh
corepack pnpm --filter @asin-monitor/db build
corepack pnpm --filter @asin-monitor/variant-check test
corepack pnpm --filter @asin-monitor/api exec vitest run test/competitor-check.test.ts test/competitor-check-legacy.test.ts --pool=threads --maxWorkers=1 --minWorkers=1
```

Integration CI 在隔离双 PostgreSQL 中对 0014 执行两次，确认回执表只存在于竞品库，再执行两次回滚并重新应用。`competitor-check.integration.test.ts` 覆盖权限复核、竞品状态及历史事务、成员移动、回执重放与故障回滚；编译 Worker 的 BullMQ 测试覆盖竞品组执行和单项回执重放。Legacy 固定 Catalog 对拍覆盖单项成功、组内确定不存在和可恢复上游失败。请求层的 `/api` URL 去重由 `test:contracts` 校验。未配置隔离 PostgreSQL/Redis/BullMQ 时，集成用例跳过不视为通过。
