# Issue #48 Neo 缺口矩阵

> 基线：packages/contracts/src/endpoints.ts 与 packages/contracts/docs/endpoint-inventory.md。矩阵键为 METHOD path，初始证据状态为待核查。skipped 表示环境未启用，不等于通过。

- 端点总数：119
- 域数量：18
- SSE deprecated 数量：9
- 最近更新时间：2026-10-24

| 端点 | 域 | Legacy 控制器 | Neo route / 证据 | 单测 | PostgreSQL/Redis 集成 | Legacy 对拍 | Web 接入 | 生产门禁 | 最近证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| POST /auth/login | auth | authController.login | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /auth/current-user | auth | authController.getCurrentUser | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /auth/logout | auth | authController.logout | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /auth/sessions | auth | authController.listSessions | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /auth/sessions/revoke | auth | authController.revokeSession | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /auth/change-password | auth | authController.changePassword | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| PUT /auth/profile | auth | authController.updateProfile | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /users | users | userController.getUserList | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /users/roles/all | users | userController.getAllRoles | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /users/:userId | users | userController.getUserDetail | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /users | users | userController.createUser | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /users/batch-delete | users | userController.batchDeleteUsers | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| PUT /users/:userId | users | userController.updateUser | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| DELETE /users/:userId | users | userController.deleteUser | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| PUT /users/:userId/password | users | userController.updateUserPassword | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /roles | roles | roleController.getRoleList | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /roles/:roleId | roles | roleController.getRoleDetail | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /permissions | roles | roleController.getPermissionList | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| PUT /roles/:roleId/permissions | roles | roleController.updateRolePermissions | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /variant-groups | asin | asinController.getVariantGroups | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /variant-groups/:groupId | asin | asinController.getVariantGroupById | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /variant-groups | asin | asinController.createVariantGroup | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /variant-groups/batch-delete | asin | asinController.batchDeleteVariantGroups | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| PUT /variant-groups/:groupId | asin | asinController.updateVariantGroup | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| DELETE /variant-groups/:groupId | asin | asinController.deleteVariantGroup | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| PUT /variant-groups/:groupId/feishu-notify | asin | asinController.updateVariantGroupFeishuNotify | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| PUT /variant-groups/:groupId/manual-broken | asin | asinController.updateVariantGroupManualBroken | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /asins | asin | asinController.createASIN | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /asins/batch-create | asin | asinController.batchCreateASINs | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| PUT /asins/:asinId | asin | asinController.updateASIN | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| DELETE /asins/:asinId | asin | asinController.deleteASIN | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /asins/:asinId/move | asin | asinController.moveASIN | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| PUT /asins/:asinId/feishu-notify | asin | asinController.updateASINFeishuNotify | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| PUT /asins/:asinId/manual-broken | asin | asinController.updateASINManualBroken | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /variant-groups/import-excel | asin | asinController.importFromExcel | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /variant-groups/:groupId/check | variant-check | variantCheckController.checkVariantGroup | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /asins/:asinId/check | variant-check | variantCheckController.checkASIN | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /variant-groups/batch-check | variant-check | variantCheckController.batchCheckVariantGroups | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /variant-check/batch-query-parent-asin | variant-check | variantCheckController.batchQueryParentAsin | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /monitor-history/statistics/by-time | monitor | monitorController.getStatisticsByTime | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /monitor-history/statistics/by-country | monitor | monitorController.getStatisticsByCountry | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /monitor-history/statistics/by-variant-group | monitor | monitorController.getStatisticsByVariantGroup | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /monitor-history/statistics/peak-hours | monitor | monitorController.getPeakHoursStatistics | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /monitor-history/statistics/analytics-monthly-breakdown | monitor | monitorController.getAnalyticsMonthlyBreakdown | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /monitor-history/statistics/peak-mark-areas | monitor | monitorController.getAnalyticsPeakMarkAreas | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /monitor-history/statistics/all-countries-summary | monitor | monitorController.getAllCountriesSummary | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /monitor-history/statistics/region-summary | monitor | monitorController.getRegionSummary | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /monitor-history/statistics/period-summary | monitor | monitorController.getPeriodSummary | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /monitor-history/statistics/period-summary/details | monitor | monitorController.getPeriodSummaryTimeSlotDetails | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /monitor-history/statistics/asin-by-country | monitor | monitorController.getASINStatisticsByCountry | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /monitor-history/statistics/asin-by-variant-group | monitor | monitorController.getASINStatisticsByVariantGroup | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /monitor-history/statistics | monitor | monitorController.getStatistics | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /monitor-history/abnormal-duration-statistics | monitor | monitorController.getAbnormalDurationStatistics | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /monitor-history/status-intervals | monitor | MonitorHistoryController.statusIntervals | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /monitor-history/:id | monitor | monitorController.getMonitorHistoryById | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /monitor-history | monitor | monitorController.getMonitorHistory | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /monitor/trigger | monitor | monitorController.triggerManualCheck | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /competitor/variant-groups | competitor-asin | competitorAsinController.getCompetitorVariantGroups | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /competitor/variant-groups/:groupId | competitor-asin | competitorAsinController.getCompetitorVariantGroupById | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /competitor/variant-groups | competitor-asin | competitorAsinController.createCompetitorVariantGroup | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /competitor/variant-groups/batch-delete | competitor-asin | competitorAsinController.batchDeleteCompetitorVariantGroups | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| PUT /competitor/variant-groups/:groupId | competitor-asin | competitorAsinController.updateCompetitorVariantGroup | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| DELETE /competitor/variant-groups/:groupId | competitor-asin | competitorAsinController.deleteCompetitorVariantGroup | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| PUT /competitor/variant-groups/:groupId/feishu-notify | competitor-asin | competitorAsinController.updateCompetitorVariantGroupFeishuNotify | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /competitor/asins | competitor-asin | competitorAsinController.createCompetitorASIN | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /competitor/asins/batch-create | competitor-asin | competitorAsinController.batchCreateCompetitorASINs | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| PUT /competitor/asins/:asinId | competitor-asin | competitorAsinController.updateCompetitorASIN | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| DELETE /competitor/asins/:asinId | competitor-asin | competitorAsinController.deleteCompetitorASIN | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /competitor/asins/:asinId/move | competitor-asin | competitorAsinController.moveCompetitorASIN | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| PUT /competitor/asins/:asinId/feishu-notify | competitor-asin | competitorAsinController.updateCompetitorASINFeishuNotify | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /competitor/variant-groups/import-excel | competitor-asin | competitorAsinController.importCompetitorFromExcel | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /competitor/monitor-history/:id | competitor-monitor | competitorMonitorController.getCompetitorMonitorHistoryById | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /competitor/monitor-history | competitor-monitor | competitorMonitorController.getCompetitorMonitorHistory | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /competitor/monitor/trigger | competitor-monitor | CompetitorMonitorTriggerController.trigger | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /competitor/variant-groups/:groupId/check | competitor-variant-check | competitorVariantCheckController.checkCompetitorVariantGroup | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /competitor/asins/:asinId/check | competitor-variant-check | competitorVariantCheckController.checkCompetitorASIN | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /competitor/variant-groups/batch-check | competitor-variant-check | competitorVariantCheckController.batchCheckCompetitorVariantGroups | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /dashboard | dashboard | dashboardController.getDashboardData | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /export/variant-group | export | exportController.exportVariantGroupData | Legacy-owned / Neo-deprecated | 待核查 | 待核查 | 待核查 | 待核查 | Legacy 双跑期 | 2026-10-24 |
| GET /export/asin | export | exportController.exportASINData | Legacy-owned / Neo-deprecated | 待核查 | 待核查 | 待核查 | 待核查 | Legacy 双跑期 | 2026-10-24 |
| GET /export/competitor-variant-group | export | exportController.exportCompetitorVariantGroupData | Legacy-owned / Neo-deprecated | 待核查 | 待核查 | 待核查 | 待核查 | Legacy 双跑期 | 2026-10-24 |
| GET /export/competitor-asin | export | exportController.exportCompetitorASINData | Legacy-owned / Neo-deprecated | 待核查 | 待核查 | 待核查 | 待核查 | Legacy 双跑期 | 2026-10-24 |
| GET /export/monitor-history | export | exportController.exportMonitorHistory | Legacy-owned / Neo-deprecated | 待核查 | 待核查 | 待核查 | 待核查 | Legacy 双跑期 | 2026-10-24 |
| GET /export/analytics-monthly-breakdown | export | exportController.exportAnalyticsMonthlyBreakdown | Legacy-owned / Neo-deprecated | 待核查 | 待核查 | 待核查 | 待核查 | Legacy 双跑期 | 2026-10-24 |
| POST /export/analytics-monthly-breakdown | export | exportController.exportAnalyticsMonthlyBreakdown | Legacy-owned / Neo-deprecated | 待核查 | 待核查 | 待核查 | 待核查 | Legacy 双跑期 | 2026-10-24 |
| GET /export/competitor-monitor-history | export | exportController.exportCompetitorMonitorHistory | Legacy-owned / Neo-deprecated | 待核查 | 待核查 | 待核查 | 待核查 | Legacy 双跑期 | 2026-10-24 |
| GET /export/parent-asin-query | export | exportController.exportParentAsinQuery | Legacy-owned / Neo-deprecated | 待核查 | 待核查 | 待核查 | 待核查 | Legacy 双跑期 | 2026-10-24 |
| POST /tasks/export | tasks | exportController.createExportTask | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /tasks | tasks | taskController.listTasks | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /tasks/:taskId | tasks | taskController.getTaskStatus | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /tasks/:taskId/cancel | tasks | taskController.cancelTask | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /tasks/:taskId/download | tasks | taskController.downloadTaskFile | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /backup | backup | backupController.createBackup | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /backup/restore | backup | backupController.restoreBackup | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /backup | backup | backupController.listBackups | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| DELETE /backup/:filename | backup | backupController.deleteBackup | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /backup/:filename/download | backup | backupController.downloadBackup | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /backup/config | backup | backupController.getBackupConfig | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /backup/scheduled-tasks | backup | backupController.getScheduledBackupTasks | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /backup/config | backup | backupController.saveBackupConfig | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /feishu-configs | feishu | feishuController.getFeishuConfigs | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /feishu-configs/:country | feishu | feishuController.getFeishuConfigByCountry | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /feishu-configs | feishu | feishuController.upsertFeishuConfig | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| PUT /feishu-configs/:country | feishu | feishuController.upsertFeishuConfig | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| DELETE /feishu-configs/:country | feishu | feishuController.deleteFeishuConfig | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| PATCH /feishu-configs/:country/toggle | feishu | feishuController.toggleFeishuConfig | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /rate-limiter/status | sp-api-config | spApiConfigController.getRateLimiterStatus | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /error-stats | sp-api-config | spApiConfigController.getErrorStats | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /sp-api-configs | sp-api-config | spApiConfigController.getSPAPIConfigForDisplay | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /sp-api-configs/:configKey | sp-api-config | spApiConfigController.getSPAPIConfigByKey | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| PUT /sp-api-configs | sp-api-config | spApiConfigController.updateSPAPIConfig | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /audit-logs | audit | auditLogController.getAuditLogList | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /audit-logs/:id | audit | auditLogController.getAuditLogDetail | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /audit-logs/statistics/actions | audit | auditLogController.getActionStatistics | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /audit-logs/statistics/resources | audit | auditLogController.getResourceStatistics | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /ops/overview | ops | opsController.getOpsOverview | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /ops/analytics/cache/clear | ops | opsController.clearAnalyticsCache | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| POST /ops/analytics/refresh | ops | opsController.refreshAnalyticsAgg | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
| GET /system/alert | system | systemController.getAlert | 待核查 | 待核查 | 待核查 | 待核查 | 待核查 | blocked：待核查 | 2026-10-24 |
