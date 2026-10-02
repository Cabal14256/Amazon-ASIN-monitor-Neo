# Neo 竞品手动监控（Issue #187）

`POST /api/v1/competitor/monitor/trigger` 仅在 `AUTH_DATA_AUTHORITY=postgresql`、当前会话有效且当前用户具有 `monitor:write` 时受理。body 可省略 countries（默认 US/UK/DE/FR/IT/ES）；输入规范化、去重，非法或空国家组合返回 400。新的异步契约返回 `{message,queued:true,jobId,countries}`，不改变 Legacy 同步 `competitorMonitorTriggerResultSchema`。消费者独立运行在 `${BULL_PREFIX}:neo:competitor-monitor`，任务类型/子类型固定 `competitor-monitor/competitor`，不借用主营任务身份。

## 升级与准入

先完成竞品查询/写入策略、`0014_competitor_check_receipts.sql`、共享 SP-API 与飞书配置升级及 PostgreSQL 权威源验收。部署本版 API/Worker 前执行 `npm run db:upgrade:competitor-monitor`，只在竞品库创建 `0015_competitor_monitor.sql` 的固定快照、通知声明及历史 `monitor_task_id` 列。新 Drizzle 历史定义也用于竞品即时检查，因此即使未启用手动监控队列，仍须先升级该列；隔离 fixture 的 `LIKE public.competitor_monitor_history` 建表同样必须晚于升级。脚本拒绝与主库同名的目标数据库。Worker 启动前验证存储，缺失则不发布消费心跳。生产仍受 #48 阶段门禁限制，本 Issue 不切流、不修改 Legacy 队列或调度。

隔离验证可设置 `WORKER_ENABLED_QUEUES=competitor-monitor`。每个消费者独立续租 10 秒 ready 心跳，最后一个退出立即撤销 ready；退出中的迟到刷新不会恢复心跳。API 同实例最多 4 个在途提交，多个实例共享 Redis 准入租约，在同一租约内核对心跳与待处理/延迟/运行任务总数，50 个积压时返回 429，无消费者返回 503。元数据创建或入队确认不确定时返回固定 500 与 `data.taskId/status=unknown`；先查询该 ID，勿直接再次提交。

## 一致性、权限与通知

第一次执行将按请求国家、原始 canonical ID 固定排序的组目录写入竞品库，每组保存输入摘要；最多 1000 组、20000 总成员、16 MiB 原始快照输入。超限明确失败，不静默截断。摘要包含成员集合、检查输入、创建身份及通知开关，不包含无关更新时间。首次组检查核对摘要，提交时锁组与成员再次比较快照；变化时任务失败而不检查新成员。重试沿原顺序读取已提交的不可变 operation 收据，不重复上游检查或历史。手动任务不是 #188/#189 的稳定批量/调度替代方案。

Worker 不绑定原提交会话，已受理的后台任务可跨 logout 继续。每次新检查提交、通知声明及实际发送前，仍从主库复核 ACTIVE 账户、密码策略、`monitor:write` 和当前 `COMPETITOR_MONITOR_ENABLED`。DB `true/1` 或 `false/0` 覆盖环境默认值，其他值沿 Legacy 回退；读取失败不会复用旧的开启状态。控制事务只覆盖短存储操作，不跨上游 HTTP 或延后等待。

共享 Catalog 使用竞品 owner，US/EU 延后失败在组提交前等待 2 秒并强制复核一次；正常、NOT_FOUND、NO_VARIANTS 与 SP_API_ERROR 分开计数。状态、GROUP/ASIN 历史和 operation 收据同竞品事务提交，历史使用同一 task.createdAt，保留 taskId。空组可记录 GROUP 检查，瞬时检查仍保持旧行为。

飞书通知要求组和成员两个开关同时为 true，缺失/null 默认关闭。新发送前以短竞品事务锁内复核当前 canonical 父组/成员、国家、商品代码、显示字段与创建身份；旧检查收据只恢复业务历史，不能授权新通知。共享主/竞品发送容量先于国家声明；当前区域配置不存在、已关闭或无效时不声明、不发送。每次真实 POST 前重查当前控制及双开关，11232 最多三次退避，每次重新检查。摘要及最终卡片有明确容量边界，超限失败而不截断。

国家声明 `(task_id,country)` 持久化：sent/failed 不自动重发，claimed 表示不确定，需人工核对。重放先校验原始完整任务/固定运行目录/国家并读取旧声明，仍要求当前账户、权限、竞品开关、租约和未取消；旧声明不依赖后来修改的成员或双通知开关，直接恢复原 sent/failed/unconfirmed 结果，不申请发送容量、不读取 webhook、不新写业务历史、不再次 POST。只有不存在旧声明时，才执行当前成员/双开关及新投递准入。声明后即使发送前 guard 拒绝、尚未发出 POST，也保守保留 claimed 而不自动重发；任务错误与本次已尝试后的 unconfirmed 结果分开，但数据库声明不能证明是否发送，需要人工对账。真实 POST 后断线或确认丢失保留 claimed，并返回 unconfirmed；即使任务状态确认失败或进程重启也不释放声明重发。成功确认与该任务/该国异常历史的 notification_sent 同事务更新，不标记其他任务或正常历史。

取消与完成使用 Redis 身份 CAS；已接受的取消保留已提交结果，阻止后续检查与发送。全部业务完成后最终元数据确认失败，可由 BullMQ 完成结果恢复本人任务。内部 `_competitorMonitorCommit` 绑定原不可变 job 的完整身份/国家/有效期摘要，公共 HTTP serializer 在任意深度移除此证据；WS 仅发送任务状态失效通知。缺少队列证据不会按年龄推断已失败或已完成。终态队列凭据至少保留 7 天或更长的元数据 TTL，运行目录和声明按过期时间有界清理。

## 验证与回滚

- 本地专项覆盖契约、真实 Nest HTTP 当前权限/会话、控制与快照摘要、Catalog 延后复核/收据重放、真实通知服务共享准入/当前配置、消费者取消/未知投递/元数据 ACK 丢失。
- Linux CI 显式执行 `apps/worker/test/competitor-monitor-entry.integration.test.ts`：编译后 Worker、独立两套 PostgreSQL schema、真实 Redis/BullMQ、本地 TLS 飞书 hook 与预置 Catalog 数据；任何其他网络请求立即拒绝，不使用生产 webhook。覆盖双开关默认关闭、撤权/取消、错 run 身份、同时间历史、发送确认丢失、两次状态确认失败后三次进程重放、后加成员不检查、心跳退出。Windows 或服务缺失的跳过不能视为集成通过。
- API 真实 Redis 集成验证竞品 job 格式、本人状态恢复和私有证据脱敏、取消 script 原子核对任务类型/子类型/ID/name；CI 升级、回滚均执行两次并验证竞品对象未进入主库。
- 回滚先停止新 API 受理及竞品消费者，记录在途任务/claimed 通知并核对；排空或禁用重放后才执行竞品库 `0015_competitor_monitor.rollback.sql`。回滚删除 Neo 运行目录/声明和 monitor_task_id 列，保留既有 GROUP/ASIN 历史、商品与 Legacy 队列。运行期间删除收据可能导致重复执行，禁止边消费边回滚。

本 Issue 的契约、API、真实 Worker、竞品原子历史、共享通知 guard 和迁移/集成证据共同构成一个手动监控闭环，不能拆为独立可上线的运行功能；因此超过单 PR 文件数和模块警戒线。后续定时调度、批量稳定分页恢复和生产切换各自独立验收。
