import { scheduledMonitorTables } from './scheduled-monitor-tables';

const tables = scheduledMonitorTables('primary');
export const primaryScheduledMonitorRuns = tables.runs;
export const primaryScheduledMonitorNotifications = tables.notifications;
export const primaryScheduledMonitorGroupReceipts = tables.groupReceipts;
