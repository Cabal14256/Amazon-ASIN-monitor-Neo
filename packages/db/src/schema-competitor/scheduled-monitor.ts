import { scheduledMonitorTables } from '../schema/scheduled-monitor-tables';

const tables = scheduledMonitorTables('competitor');
export const competitorScheduledMonitorRuns = tables.runs;
export const competitorScheduledMonitorNotifications = tables.notifications;
export const competitorScheduledMonitorGroupReceipts = tables.groupReceipts;
