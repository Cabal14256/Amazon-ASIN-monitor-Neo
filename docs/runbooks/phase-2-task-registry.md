# Neo 任务注册表（P2-T2b）

## 已实现范围

`packages/db` 导出 `RedisTaskRepository` 供 API/Worker 共享数据访问。此 PR 只提供仓储和状态转换，不启动新 Redis 连接，不开放任务中心端点，也不消费或创建 BullMQ 业务任务。后续端点必须先鉴权并检查 `userId`；仓储 `read`/`mutate` 是受信服务端内部接口，不是授权边界。

- `create`：要求可信 `userId`、`taskId`、`taskType`；不接受客户端指定初始状态、时间、结果或 owner 更新。
- `read`/`listUser`：实时读取共享 Redis，无进程内缓存。列表按更新时间倒序，支持 `all`、`active` 与具体状态，limit 为 1–200；在完整有界索引内过滤，不使用 `limit*3` 截断。
- `mutate`：processing/progress/cancel-request/cancelled/completed/failed。取消请求保持粘性，后到进度不会清除；第一个终态获胜，后续任何转换不覆盖结果，也不续期；完成可能先于取消生效，不保证撤回已提交的业务修改。
- 元数据和索引通过 Lua 比较旧值再写入；竞争时最多重读/重算 8 次，仍冲突报 `TASK_CONTENTION`。不使用客户端 get/set 的无保护覆盖，也不允许更新缺失任务时隐式创建无主记录。

## 数据与配置

默认键为 `bull:neo:task:meta:<encoded-taskId>` 和 `bull:neo:task:user:<encoded-userId>`；前缀来自 `BULL_PREFIX`，总是追加 `:neo:task`。ID 用 URI 编码，索引 member 保留原始 taskId。旧系统裸 `task:meta:*` / `task:user:*` 完全不读写；两个系统各自拥有状态权威来源。

| 配置                    | 默认           | 允许范围          |
| ----------------------- | -------------- | ----------------- |
| `TASK_META_TTL_SECONDS` | 604800（7 天） | 1–31536000 整数秒 |
| `TASK_USER_MAX_ITEMS`   | 200            | 1–1000 整数       |

成功变更同时刷新该任务和用户索引 TTL。读取、终态重复操作不续期。索引按更新顺序保留最新 N 条，裁剪索引不立即删除对应元数据；过期元数据即使仍在索引中也不会复活。元数据 JSON 最大 256 KiB，拒绝循环引用、BigInt、函数、undefined 和非有限数值；结果应保存摘要/产物引用，不把全部导出行放进元数据。时间与 revision 由服务端产生，owner/type/创建时间不随变更修改。

## 连接与失败边界

调用方拥有 Redis 连接和关闭职责：使用专用有界请求连接，建议 `commandTimeout=2000`、`connectTimeout=2000`、`maxRetriesPerRequest=1`、`enableOfflineQueue=false`、`autoResendUnfulfilledCommands=false`，并在调用前等待连接 ready、接入脱敏 logger 的 error 监听。不要传 BullMQ 阻塞 Worker 的无限重试连接。

Redis 是跨进程状态权威源，失败直接上抛，不返回私有 Map 中的“成功”；旧 `TASK_REGISTRY_MEMORY_ONLY` 不适用于 Neo。请求超时意味着写入结果可能未知，调用方先重新读取同一个 taskId，不可直接创建第二个业务任务。仓储不记录原始异常、任务 payload 或用户数据，调用方只记录安全错误码和最小上下文。

Lua 提供无其他客户端插入的比较/写入，不提供任意运行错误回滚；脚本先验证 key 类型和 CAS，再进行写入。Redis OOM、断电、持久化策略等仍可能影响持久性，运维必须配置容量和 Redis 持久化。当前目标拓扑为单 Redis 实例，不宣称支持 Redis Cluster 多 slot 事务。依据 [Redis Lua 官方说明](https://redis.io/docs/latest/develop/programmability/eval-intro/)。

## 验证、切换与回滚

- 单测对照 Legacy 顺序状态行为，并覆盖取消竞争、终态不可逆、配置/JSON 限制、缺失/过期无复活、错误明确传播和索引过滤。
- 显式 `RUN_INTEGRATION_TESTS=true` 加测试 `REDIS_URL` 运行 `corepack pnpm --filter db exec vitest run test/task-registry.integration.test.ts`：两真实客户端竞争 20 轮、TTL/索引裁剪、owner/命名空间隔离、类型错误写前校验。仅使用随机 `fixture-task-registry-*` 前缀并按确切 key 清理，无 FLUSHDB。
- 没有数据库 schema 迁移，不读取/写入真实生产任务。回滚仓储接线即可停止新元数据写入；现有键按 TTL 自然过期，不主动删除历史。
- 尚待任务中心授权/序列化端点、取消与 BullMQ job 协调、跨进程 WS 发布、实际 Processor/调度和新旧产物对拍。只有这些完成且旧队列 drain 门槛通过后，才能切换生产。
