# Neo 竞品批量检查（Issue #251）

`POST /api/v1/competitor/variant-groups/batch-check` 使用当前 `asin:read` 权限和服务端竞品目录操作围栏。Legacy 原入口保留；本轮不在远程生产服务器执行任何升级或启用操作。

## 请求与结果

- `groupIds` 必须包含 1–1000 个合法 Neo literal ID；保留原始字节、输入顺序和重复位置，不 trim、去重或按国家重新分组。
- 默认异步。只有显式同步标志且组数不超过 `BATCH_CHECK_SYNC_MAX_GROUPS`（默认 20）时同步；同步组并发默认 3，异步默认 2，共用现有有界配置。
- `forceRefresh` 只有显式 `false` 才关闭。`country` 是保留的请求元数据，不覆盖组所属国家，但参与不可变任务请求摘要。
- 同步返回 `{ total, results }`；每项保留 `groupId`、`success`、完整组结果或固定失败原因。可恢复单组问题不阻止其余组；提交结果不确定、租约/身份失效或取消不能伪装成单组失败后继续提交。
- 异步返回 `{ taskId, status: 'pending', total }`，任务类型是 `batch-check/competitor-variant-group`。详情、进度、取消和 JSON 下载沿用 `/tasks` 的本人所有权、当前会话和读取权限边界。

## 回执与恢复

每个输入位置对应独立 `group-<index>` 操作；重复组仍是不同位置。所有逐组状态、历史和回执在竞品事务内原子提交；root 使用 `competitor-batch` 回执，完整结果不复制进 Redis 元数据。主库只提供鉴权、目录围栏和任务绑定，不存竞品检查回执。

重试先读取 root，已有 root 时不重新执行业务。root 缺失时先计入所有已提交组回执的完整结果预算，再执行未完成位置。聚合结果上限保持 32 MiB，新增结果在组事务提交前预留容量，避免先提交业务后才发现完整结果无法保存。root COMMIT 后 ACK 丢失保留不确定状态，下一次按原身份回读，不重新调用已完成组。

取消使用确切 taskId/userId/taskType/taskSubType/createdAt。pending 任务只在原子 queue.remove 确认后结算；运行中取消停止新组与 root 完成，已提交的组状态、历史和回执保留。任务最终为 cancelled，不发布部分 completed 结果。Redis 终态或 queue ACK 都不能代替原物理事务/pin 排空。

## 升级与回滚

竞品库先安装 0014，再执行 0018。`corepack pnpm db:upgrade:competitor-batch-check-receipts` 通过现有 Neo compose 的受限竞品库 wrapper 应用迁移；wrapper 拒绝主库与竞品库相同。应用两次应保持相同约束。此命令只是操作入口，不表示本轮已对任何部署执行。

回滚前停止新的竞品批量生产者并排空/取消原任务，核验不确定回执与目录 pin。0018 rollback 只恢复原 kind 约束；存在 `competitor-batch` 行时整个事务失败并保留原约束和所有完成证据。不得删除回执、清 Redis、重置 taskId 或直接回滚二进制来强制重跑。原回执经过保留期且任务已对账后，再安排清理和回滚。

## 验证边界

- 执行实际 Legacy controller 的 VM fixture 证明 envelope、默认值、同步/异步和顺序/失败分派；依赖端口为合成，不宣称 Legacy SQL 对拍。
- DB/执行器单测验证原始请求摘要、competitor root/step 类型、primary port 拒绝、重试/取消、容量与提交不确定边界。
- 原生 API suite 使用真实 Fastify、双 PostgreSQL、Redis/BullMQ 和编译后的 batch-only Worker，覆盖本人下载、权限撤销、literal 邻居、回执隔离、取消、重启及 root COMMIT ACK 故障。
- 新原生夹具仅在明确的可丢弃 loopback CI 数据库和 Redis DB 15 中创建随机 schema/命名空间，清理范围由夹具所有权检查限制。默认 skip、VM、单测和静态扫描不计作原生通过。
- 本地真实服务未启用，最终原生结果必须来自对应 head 的 Integration。单个任务切片通过不关闭 #190 全任务故障报告、118 端点对拍、浏览器、内存或生产切流门禁。
