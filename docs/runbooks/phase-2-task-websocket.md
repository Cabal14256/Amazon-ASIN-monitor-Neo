# Neo 任务跨进程 WebSocket（Issue #103）

Worker、取消接口和任务查询终态对账统一通过 RedisTaskRepository 发布变更。两个 API 实例各自订阅，再向已鉴权的任务所有者推送冻结的 task_progress/task_complete/task_error/task_cancelled 消息；同一用户的多个连接都可接收。monitor_progress、monitor_complete、stats_update 暂时仍为进程内事件，后续监控业务 Worker 接入时另验。

## 提交与通知

任务元数据、用户索引和通知发布在同一 Redis Lua 脚本中按顺序执行。CAS 冲突不发布；重复终态不写入、不续期、不发布。PUBLISH 使用 redis.pcall；失败时返回“状态已提交但通知失败”，仓储仍返回成功，API/Worker 最多每分钟记录一次固定 warn。诊断回调抛错也不能把已提交任务改判为失败。Redis 故障导致整个 EVAL 回复未知时仍须重新查询同一任务，不能换 ID 重做业务。

频道为 `<trimmed BULL_PREFIX>:neo:task:events`。Redis Pub/Sub 不按数据库编号隔离，部署环境应使用不同 BULL_PREFIX；API/Worker 必须连接同一状态库并使用相同前缀。Redis ACL 除已有任务命令和 key 权限，还需允许生产者 PUBLISH 和 API SUBSCRIBE/PING 及该确切频道；API 使用单独连接执行 GET，不在订阅连接上读取任务。

内部消息最大 4096 字节，仅包含 version=1、type=task_changed、taskId、userId、taskType、createdAt 和 revision。未知版本、额外字段、非法值和过大消息均丢弃。消息不携带业务结果、错误对象、路径、令牌或完整导入报告。API 重新读取当前记录，复核所有者/类型/创建时间及 revision，丢弃过期记录、复用身份和未来版本；仅由权威状态生成 WS 消息。失败提示固定，完成消息只含规范化本人下载地址与文件名，不透传结果对象或外部 URL。

## 容量、断线与恢复

- 每个 API 最多 8 个任务读取并发、256 个不同任务的待处理通知；同一任务的积压合并为最新 revision。最近 4096 个任务身份保留已发送 revision，用于去重和防止乱序回退；超出此窗口可能再次发出相同提示，客户端仍须按 HTTP 快照处理。
- 超过容量丢弃通知并节流 warn。Pub/Sub 是更新提示，不是可靠事件日志，不保证每个中间进度或终态必达。已有任务 hooks 持续轮询非终态详情、定期刷新列表，终态提示触发完整快照重读；断线期间的完成也通过本人 HTTP 查询恢复。
- WS 网关启动时才创建 Redis 连接；订阅与读取各自使用 1 秒连接/命令超时、3 秒 ready 总截止、最多 1 次请求重试，禁止离线排队和未确认命令重发。读取超时断开连接，避免底层等待回复队列持续累积。重连间隔逐步增加至 1 秒，每次 ready 明确重订阅；15 秒 PING 检测无消息时的断链。
- Redis 断线使旧读取结果失效并清空待处理通知。关闭模块时停止接收、取消计时器和重连、断开两条连接；迟到结果不再发给网关。

## 会话与所有者

握手继续使用原有 Cookie/Bearer JWT、权威会话和当前账户校验及 Origin 限制。每次发送业务消息前重新校验 JWT、会话归属/状态/到期时间和账户状态；30 秒连接心跳也校验闲置连接。该只读校验不 touchSession，不因接收进度延长用户活跃时间，也不额外修改到期会话。401/403 分别关闭为 4401/4403，依赖失败关闭为 1013；鉴权后到实际发送之间的并发撤销不构成跨系统事务。

发送鉴权最多 8 个并发，每连接最多 32 条排队消息，排队/正在鉴权的消息加 socket 缓冲总量不超过 1 MiB。2 秒校验截止后关闭连接，迟到结果丢弃；依赖未结束前不释放并发槽。网关最多 1000 条连接、64 个握手鉴权；达到限制时拒绝或关闭连接，浏览器按既有重连/HTTP 恢复策略处理。

任务广播必须含所有者，ownerless task helper 和全体 task 广播均拒绝。取消接口删除旧进程内 sendTaskCancelled 调用，仅由提交后的共享通知发布一次；运行中的 cancelling 发送进度提示，只有 cancelled 终态发送 task_cancelled。

## 验证与回滚

定向测试：

```sh
corepack pnpm --filter db exec vitest run test/task-registry.test.ts test/task-notification.test.ts
corepack pnpm --filter api exec vitest run test/task-notification-consumer.test.ts test/redis-websocket-events.test.ts test/websocket.test.ts test/task-cancellation.test.ts
```

隔离环境设置 RUN_INTEGRATION_TESTS=true 后运行任务注册表、取消和 task-websocket.integration.test.ts。真实 Redis 覆盖并发 CAS 只发布已提交版本、拒绝 PUBLISH 的临时 ACL 用户仍保留完成状态；两个真实 API 网关共享隔离 PostgreSQL 会话，验证独立编译 Worker 的业务进度、所有者隔离、终态去重、Redis 重连、HTTP 恢复及已提交撤权。独立 Worker 进程/SIGTERM 场景在 Linux Integration CI 执行，Windows 本地显式跳过；测试只清理随机命名空间和专属 schema，不使用 FLUSHDB。

无数据库结构或公开 REST/WS 契约变化，无生产入口切换。回滚本 Issue 的 API/Worker/共享仓储提交即可；旧代码忽略该新增频道，保留已有任务记录和产物，客户端继续 HTTP 轮询。此链路不代表其余业务 Worker、监控广播、页面、实际生产双跑与旧队列 drain 门槛已完成。
