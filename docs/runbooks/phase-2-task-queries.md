# Neo 任务列表与状态查询（Issue #95）

## 已实现入口

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/v1/tasks` | 当前用户的注册表任务，按更新时间倒序；默认 50、最多 200，支持 all/active/具体状态 |
| GET | `/api/v1/tasks/:taskId` | 本人任务详情；注册表缺失时查六类 Neo 业务队列，未恢复注册表记录 |

两端点沿用 Legacy 登录和本人所有权规则，不要求额外 `task:read` 权限。每次请求通过现有实时鉴权读取当前账户和会话；不增加旧任务查询没有的强制改密门槛。任务权威源属于 Neo，`AUTH_DATA_AUTHORITY` 必须已切 PostgreSQL；双跑期仍保留 Legacy 入口。

成功响应采用冻结 TaskInfo / Result 契约和 `Cache-Control: no-store`。查询只接受 status/limit，非法参数 400；超长路由参数可能由 Fastify 提前返回 414。未知 status 与旧版一致返回空列表。缺失 404、非本人或缺失 owner 403；Neo 不继承旧版无 owner 任务对所有登录用户公开的行为。

## 注册表与队列对账

- 共用 `packages/config` 的纯队列目录与 `getNeoQueuePrefix`；Worker 现有选择器、别名和策略保持不变。API 使用只读 `QueueGetters`，不创建业务任务、不注册调度、不改写 Queue 元数据。
- 元数据前缀 `${BULL_PREFIX}:neo:task`，队列前缀 `${BULL_PREFIX}:neo`；不访问裸 `task:*` 或旧 Bull4 `${BULL_PREFIX}:<queue>` 数据。默认分别为 `bull:neo:task` 和 `bull:neo`。
- 查询队列与 Legacy 一致：export、batch-check、batch-delete、import、backup、variant-check。已有元数据只查询其对应队列；无元数据按以上顺序回退，owner 必须明确且等于当前用户。monitor/competitor-monitor 不作为任务中心回退源。
- 注册表终态不回退，不再依赖队列可用。非终态仅吸收 BullMQ completed/failed；读取到终态后重新读取 job hash，避免使用完成前已读取的空 returnvalue。非终态 progress 不覆盖注册表。
- 完成与取消等通过既有 Redis CAS 状态转换处理，第一个终态获胜。新增可选身份条件 owner/type/createdAt，每次 CAS 重试都验证，拒绝过期 ID 复用后污染另一条任务。已过期元数据不会隐式复活。
- 列表先按注册表筛选/limit，再对账，保持旧顺序；对账后可能出现已完成任务仍在本次 active 查询结果中，下次查询会重新筛选。

## 失败、容量与公开数据

API 使用专用懒连接：连接与命令各 1 秒、无离线队列、无未完成命令自动重发、最多一次请求重试、不自动无限重连。下一请求可重新连接；BullMQ 初始化失败的实例会关闭并丢弃。关闭宿主后拒绝新命令，移除队列监听并断开连接。

最多 8 个查询同时执行；每个列表最多 4 项对账并发，3 秒后停止启动新的依赖命令，并等待已启动的有界命令结束（不在后台继续写状态）。一次对账失败后停止后续对账，返回已读的本人元数据并记录一条固定 warn。注册表读取失败或详情对账失败返回固定 500，不把故障伪装成空列表/404。网络写入超时可能已提交，后续请求以同一 taskId 重读。

公共 result 保留业务统计、失败条目与摘要，递归移除路径/目录、凭据与堆栈等内部字段，不返回 owner/revision。结果最大 256 KiB，最多 20 层/20,000 节点；文件名只返回 basename，下载 URL 只生成当前任务的受鉴权路径，避免携带任意外站链接或本地文件地址。队列 failedReason 使用固定错误文本，原始驱动错误和 payload 不进入客户端或日志。各业务 Processor 后续必须继续只写可公开的业务摘要，不能将秘密嵌入普通 message/summary 文本。

## 验证与回滚

- 实读 Legacy taskController / taskRegistryService / taskResultService，VM 对照完整公开 JSON；HTTP 覆盖登录/当前撤销/owner、终态竞争、回退、失败与并发容量。
- `corepack pnpm --filter api exec vitest run test/task-query-values.test.ts test/task-query.test.ts test/task-query-runtime.test.ts` 验证公开模型、路由及真实静默 TCP 对端的失败关闭。
- 设置测试 `RUN_INTEGRATION_TESTS=true`、PostgreSQL 和 Redis 环境，运行 `corepack pnpm --filter api exec vitest run test/task-query.integration.test.ts`。使用随机私有数据库 schema 与 Redis 前缀，真实 BullMQ 入队/领取/完成/失败、六队列回退、两会话并发对账、跨 owner 隔离、撤销、断线恢复均验收；不读取或删除生产数据。
- 无数据库迁移。回滚 TaskQueryModule 接线停止新入口，对账过的终态保留原有 TTL；不清空 Redis、不回退已完成任务状态。
- 本批只新增两个业务端点。取消协调、导出创建/下载流、跨进程 WS、八个实际业务 Processor、通用调度与旧队列 drain 门槛仍需后续完成，不据此切生产。
