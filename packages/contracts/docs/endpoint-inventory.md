# /api/v1 端点清单（契约冻结基线 v1）

> 来源：`server/src/routes/*.js`（18 个路由文件）+ `server/src/index.js` 挂载表，2026-08-24 实读。共 **117 个端点**，与《重构总体计划》§1 口径一致。本清单是重构前后共同验收基线；任何字段/行为变化必须走 contracts 变更流程。

## 0. 全局行为（index.js）

- 挂载：全部业务端点挂 `/api/v1`；根级 `/health`、`/api/v1/health`、`/metrics`。
- 信封：`{ success, errorMessage, errorCode, data }`（部分历史端点混用 `message`）。
- 超时覆盖：`/api/v1/variant-check/batch-query-parent-asin` 300s；`/api/v1/export` 600s；`/api/v1/monitor-history/statistics` 600s；`/api/v1/dashboard` 120s；`/api/v1/analytics` 120s（**无对应路由，遗留配置**）；兜底 `/api/v1` 300s。
- 限流：`apiLimiter` 全局挂 `/api/v1/`（`apiRateLimitEnabled` 开关）；按角色 ADMIN 1000 / EDITOR 500 / READONLY 100（次/15min）；`strictLimiter`（20/15min）**已导出但从未挂载（死代码）**。
- 审计：`auditLogMiddleware` 在 authRoutes 之后、其余路由之前全局生效（包 `res.json` 模式匹配记录）。
- 认证链路：`authenticateToken`（JWT + Session 行校验）→ `checkPermission('domain:action')`；**无全局认证中间件**（见 §18 偏差）。

## 1. auth（7）

| 方法 | 路径 | 认证 | 权限 | 控制器 | 特殊 |
| --- | --- | --- | --- | --- | --- |
| POST | /auth/login | 否 | — | authController.login | 登录 |
| GET | /auth/current-user | 是 | — | getCurrentUser | 前端 getInitialState 依赖 |
| POST | /auth/logout | 是 | — | logout |  |
| GET | /auth/sessions | 是 | — | listSessions |  |
| POST | /auth/sessions/revoke | 是 | — | revokeSession |  |
| POST | /auth/change-password | 是 | — | changePassword |  |
| PUT | /auth/profile | 是 | — | updateProfile |  |

## 2. users（8，router 级认证）

| 方法   | 路径                    | 权限        | 控制器             |
| ------ | ----------------------- | ----------- | ------------------ |
| GET    | /users                  | user:read   | getUserList        |
| GET    | /users/roles/all        | role:read   | getAllRoles        |
| GET    | /users/:userId          | user:read   | getUserDetail      |
| POST   | /users                  | user:write  | createUser         |
| POST   | /users/batch-delete     | user:delete | batchDeleteUsers   |
| PUT    | /users/:userId          | user:write  | updateUser         |
| DELETE | /users/:userId          | user:delete | deleteUser         |
| PUT    | /users/:userId/password | user:write  | updateUserPassword |

## 3. roles（4，router 级认证）

| 方法 | 路径                       | 权限       | 控制器                |
| ---- | -------------------------- | ---------- | --------------------- |
| GET  | /roles                     | role:read  | getRoleList           |
| GET  | /roles/:roleId             | role:read  | getRoleDetail         |
| GET  | /permissions               | role:read  | getPermissionList     |
| PUT  | /roles/:roleId/permissions | role:write | updateRolePermissions |

## 4. asin（16）

| 方法 | 路径 | 认证 | 权限 | 控制器 | 特殊 |
| --- | --- | --- | --- | --- | --- |
| GET | /variant-groups | **路由层未挂** | — | getVariantGroups |  |
| GET | /variant-groups/:groupId | **未挂** | — | getVariantGroupById |  |
| POST | /variant-groups | **未挂** | — | createVariantGroup |  |
| POST | /variant-groups/batch-delete | 是 | asin:delete | batchDeleteVariantGroups |  |
| PUT | /variant-groups/:groupId | **未挂** | — | updateVariantGroup |  |
| DELETE | /variant-groups/:groupId | **未挂** | — | deleteVariantGroup |  |
| PUT | /variant-groups/:groupId/feishu-notify | **未挂** | — | updateVariantGroupFeishuNotify |  |
| PUT | /variant-groups/:groupId/manual-broken | 是 | asin:write | updateVariantGroupManualBroken |  |
| POST | /asins | **未挂** | — | createASIN |  |
| POST | /asins/batch-create | 是 | asin:write | batchCreateASINs |  |
| PUT | /asins/:asinId | **未挂** | — | updateASIN |  |
| DELETE | /asins/:asinId | **未挂** | — | deleteASIN |  |
| POST | /asins/:asinId/move | **未挂** | — | moveASIN |  |
| PUT | /asins/:asinId/feishu-notify | **未挂** | — | updateASINFeishuNotify |  |
| PUT | /asins/:asinId/manual-broken | 是 | asin:write | updateASINManualBroken |  |
| POST | /variant-groups/import-excel | 是 | asin:write | importFromExcel | **multer 上传（file 字段）** |

## 5. variant-check（4）

| 方法 | 路径 | 认证 | 权限 | 控制器 | 特殊 |
| --- | --- | --- | --- | --- | --- |
| POST | /variant-groups/:groupId/check | **未挂** | — | checkVariantGroup |  |
| POST | /asins/:asinId/check | **未挂** | — | checkASIN |  |
| POST | /variant-groups/batch-check | 是 | asin:read | batchCheckVariantGroups |  |
| POST | /variant-check/batch-query-parent-asin | 是 | asin:read | batchQueryParentAsin | 超时 300s |

## 6. monitor（17，**全部路由层未挂认证**）

| 方法 | 路径 | 控制器 | 特殊 |
| --- | --- | --- | --- |
| GET | /monitor-history/statistics/by-time | getStatisticsByTime | 超时 600s（statistics 前缀） |
| GET | /monitor-history/statistics/by-country | getStatisticsByCountry | 同上 |
| GET | /monitor-history/statistics/by-variant-group | getStatisticsByVariantGroup | 同上 |
| GET | /monitor-history/statistics/peak-hours | getPeakHoursStatistics | 同上 |
| GET | /monitor-history/statistics/analytics-monthly-breakdown | getAnalyticsMonthlyBreakdown | 同上 |
| GET | /monitor-history/statistics/peak-mark-areas | getAnalyticsPeakMarkAreas | 同上 |
| GET | /monitor-history/statistics/all-countries-summary | getAllCountriesSummary | 同上 |
| GET | /monitor-history/statistics/region-summary | getRegionSummary | 同上 |
| GET | /monitor-history/statistics/period-summary | getPeriodSummary | 同上 |
| GET | /monitor-history/statistics/period-summary/details | getPeriodSummaryTimeSlotDetails | 同上 |
| GET | /monitor-history/statistics/asin-by-country | getASINStatisticsByCountry | 同上 |
| GET | /monitor-history/statistics/asin-by-variant-group | getASINStatisticsByVariantGroup | 同上 |
| GET | /monitor-history/statistics | getStatistics | 同上 |
| GET | /monitor-history/abnormal-duration-statistics | getAbnormalDurationStatistics |  |
| GET | /monitor-history/:id | getMonitorHistoryById |  |
| GET | /monitor-history | getMonitorHistory |  |
| POST | /monitor/trigger | triggerManualCheck |  |

> 路由顺序约束：具体路径必须在 `:id` 之前（文件内注释明示），契约测试需覆盖。

## 7. competitor-asin（14，router 级认证）

| 方法 | 路径 | 权限 | 控制器 | 特殊 |
| --- | --- | --- | --- | --- |
| GET | /competitor/variant-groups | asin:read | getCompetitorVariantGroups |  |
| GET | /competitor/variant-groups/:groupId | asin:read | getCompetitorVariantGroupById |  |
| POST | /competitor/variant-groups | asin:write | createCompetitorVariantGroup |  |
| POST | /competitor/variant-groups/batch-delete | asin:delete | batchDeleteCompetitorVariantGroups |  |
| PUT | /competitor/variant-groups/:groupId | asin:write | updateCompetitorVariantGroup |  |
| DELETE | /competitor/variant-groups/:groupId | asin:write | deleteCompetitorVariantGroup |  |
| PUT | /competitor/variant-groups/:groupId/feishu-notify | asin:write | updateCompetitorVariantGroupFeishuNotify |  |
| POST | /competitor/asins | asin:write | createCompetitorASIN |  |
| POST | /competitor/asins/batch-create | asin:write | batchCreateCompetitorASINs |  |
| PUT | /competitor/asins/:asinId | asin:write | updateCompetitorASIN |  |
| DELETE | /competitor/asins/:asinId | asin:write | deleteCompetitorASIN |  |
| POST | /competitor/asins/:asinId/move | asin:write | moveCompetitorASIN |  |
| PUT | /competitor/asins/:asinId/feishu-notify | asin:write | updateCompetitorASINFeishuNotify |  |
| POST | /competitor/variant-groups/import-excel | asin:write | importCompetitorFromExcel | **multer 上传（10MB，xlsx/csv）** |

## 8. competitor-monitor（3，router 级认证）

| 方法 | 路径 | 权限 | 控制器 |
| --- | --- | --- | --- |
| GET | /competitor/monitor-history/:id | monitor:read | getCompetitorMonitorHistoryById |
| GET | /competitor/monitor-history | monitor:read | getCompetitorMonitorHistory |
| POST | /competitor/monitor/trigger | monitor:write | triggerCompetitorManualCheck（路由内联实现） |

## 9. competitor-variant-check（3，router 级认证）

| 方法 | 路径 | 权限 | 控制器 |
| --- | --- | --- | --- |
| POST | /competitor/variant-groups/:groupId/check | asin:read | checkCompetitorVariantGroup |
| POST | /competitor/asins/:asinId/check | asin:read | checkCompetitorASIN |
| POST | /competitor/variant-groups/batch-check | asin:read | batchCheckCompetitorVariantGroups |

## 10. dashboard（1，router 级认证）

| 方法 | 路径       | 控制器           | 特殊      |
| ---- | ---------- | ---------------- | --------- |
| GET  | /dashboard | getDashboardData | 超时 120s |

## 11. export（9，router 级认证）

| 方法 | 路径 | 权限 | 控制器 | 特殊 |
| --- | --- | --- | --- | --- |
| GET | /export/variant-group | asin:read | exportVariantGroupData | **SSE 进度**；超时 600s |
| GET | /export/asin | asin:read | exportASINData | SSE |
| GET | /export/competitor-variant-group | asin:read | exportCompetitorVariantGroupData | SSE |
| GET | /export/competitor-asin | asin:read | exportCompetitorASINData | SSE |
| GET | /export/monitor-history | monitor:read | exportMonitorHistory | SSE |
| GET | /export/analytics-monthly-breakdown | analytics:read | exportAnalyticsMonthlyBreakdown | SSE |
| POST | /export/analytics-monthly-breakdown | analytics:read | 同上（POST 兼容） | SSE |
| GET | /export/competitor-monitor-history | monitor:read | exportCompetitorMonitorHistory | SSE |
| GET | /export/parent-asin-query | asin:read | exportParentAsinQuery | SSE |

> 决策 D5：新系统统一"异步任务 + WS 进度"，以上 SSE 同步导出端点双跑期由旧后端继续服务，新契约标记 deprecated。

## 12. tasks（5，router 级认证）

| 方法 | 路径 | 权限 | 控制器 | 特殊 |
| --- | --- | --- | --- | --- |
| POST | /tasks/export | **控制器内按导出类型判定** | exportController.createExportTask | 创建异步导出任务 |
| GET | /tasks | — | listTasks |  |
| GET | /tasks/:taskId | — | getTaskStatus |  |
| POST | /tasks/:taskId/cancel | — | cancelTask |  |
| GET | /tasks/:taskId/download | — | downloadTaskFile | **文件下载** |

## 13. backup（7，router 级认证 + settings:write）

| 方法   | 路径                       | 控制器           | 特殊         |
| ------ | -------------------------- | ---------------- | ------------ |
| POST   | /backup                    | createBackup     |              |
| POST   | /backup/restore            | restoreBackup    |              |
| GET    | /backup                    | listBackups      |              |
| DELETE | /backup/:filename          | deleteBackup     |              |
| GET    | /backup/:filename/download | downloadBackup   | **文件下载** |
| GET    | /backup/config             | getBackupConfig  |              |
| POST   | /backup/config             | saveBackupConfig |              |

> 契约变化点（已批准）：新系统备份产物切换为 pg_dump 自定义格式；旧 MySQL 备份仅历史保留。

## 14. feishu（6，**路由层未挂认证**）

| 方法   | 路径                            | 控制器                   |
| ------ | ------------------------------- | ------------------------ |
| GET    | /feishu-configs                 | getFeishuConfigs         |
| GET    | /feishu-configs/:country        | getFeishuConfigByCountry |
| POST   | /feishu-configs                 | upsertFeishuConfig       |
| PUT    | /feishu-configs/:country        | upsertFeishuConfig       |
| DELETE | /feishu-configs/:country        | deleteFeishuConfig       |
| PATCH  | /feishu-configs/:country/toggle | toggleFeishuConfig       |

## 15. sp-api-config（5，**路由层未挂认证**）

| 方法 | 路径                       | 控制器                   |
| ---- | -------------------------- | ------------------------ |
| GET  | /rate-limiter/status       | getRateLimiterStatus     |
| GET  | /error-stats               | getErrorStats            |
| GET  | /sp-api-configs            | getSPAPIConfigForDisplay |
| GET  | /sp-api-configs/:configKey | getSPAPIConfigByKey      |
| PUT  | /sp-api-configs            | updateSPAPIConfig        |

## 16. audit（4，router 级认证 + audit:read）

| 方法 | 路径                             | 控制器                |
| ---- | -------------------------------- | --------------------- |
| GET  | /audit-logs                      | getAuditLogList       |
| GET  | /audit-logs/:id                  | getAuditLogDetail     |
| GET  | /audit-logs/statistics/actions   | getActionStatistics   |
| GET  | /audit-logs/statistics/resources | getResourceStatistics |

## 17. ops（3，router 级认证）

| 方法 | 路径                       | 控制器              |
| ---- | -------------------------- | ------------------- |
| GET  | /ops/overview              | getOpsOverview      |
| POST | /ops/analytics/cache/clear | clearAnalyticsCache |
| POST | /ops/analytics/refresh     | refreshAnalyticsAgg |

## 18. system（1）与偏差登记

| 方法 | 路径          | 控制器   |
| ---- | ------------- | -------- |
| GET  | /system/alert | getAlert |

**偏差与安全发现（契约冻结如实记录，P2-T1 auth 模块平移时统一处置）：**

1. **43 个端点路由层未挂认证**：asin 域 11 个、variant-check 域 2 个、monitor 域 17 个、feishu 域 6 个、sp-api-config 域 5 个、system 域 1 个、auth 域 1 个（login 为设计预期）（控制器内以 `req.user?.` 兜底，实际可匿名访问）。
2. `strictLimiter`（20 次/15min）已定义导出但从未挂载（死代码）。
3. `/api/v1/analytics` 120s 超时配置无对应路由（遗留）。
4. 竞品删除/更新语义混用 `asin:write`（见 §7 DELETE/PUT），与主域 `asin:delete` 不一致——契约保留原样，P2 平移时确认。
5. WS 协议：`/ws`，JWT+Session 握手，关闭码 4401/4403；服务端 9 种消息（connected / monitor_progress / monitor_complete / stats_update / task_progress / task_complete / task_error / task_cancelled / pong）；客户端上行 ping（30s）。
