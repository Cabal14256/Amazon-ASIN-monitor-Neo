# Neo 增量 REST 端点清单

`endpoints.ts` / `endpoint-inventory.md` 保留 118 个冻结 v1 对拍端点，不因 Neo 增量功能改变基线。`neo-endpoints.ts` 将该基线与 `NEO_ENDPOINT_ADDITIONS` 合并为 `NEO_ENDPOINTS`（当前 119 项）。该清单用于迁移覆盖审计，不替代实际控制器的鉴权。

| 方法 | /api/v1 后路径 | 域 | 认证 | 权限 | Neo 控制器 | 契约 |
| --- | --- | --- | --- | --- | --- | --- |
| GET | /backup/scheduled-tasks | backup | 是 | settings:write | BackupController.scheduledTasks | backupScheduledTasksResultSchema |

该管理员 GET 只展示系统计划所有者最近 50 条 backup/create 元数据及可核验的队列完成结果；公开结果移除私有凭据、不能取消任务，也不开放用户任务中心中的系统任务访问。缺少 Redis 历史不证明计划从未执行。`GET /backup/config` 及原 7 项 backup 端点继续存在于冻结基线。
