import { buildScheduledMonitorJobId, type ScheduledMonitorJob } from '@asin-monitor/contracts';
import { scheduledMonitorBatchIndex, scheduledMonitorTaskId } from '../../src/domain/scheduled-monitor-policy';

export function scheduledJob(domain: 'primary' | 'competitor' = 'primary', changes: Partial<ScheduledMonitorJob> = {}): ScheduledMonitorJob {
  const plannedSlot = changes.plannedSlot ?? '2026-10-07T00:00:00.000Z';
  const intervalMinutes = changes.intervalMinutes ?? 30;
  const totalBatches = changes.batchConfig?.totalBatches ?? 1;
  const plan = {
    domain, country: changes.country ?? 'US' as const, plannedSlot, intervalMinutes,
    batchConfig: { batchIndex: scheduledMonitorBatchIndex(Date.parse(plannedSlot),intervalMinutes,totalBatches),totalBatches },
  };
  return {
    ...plan, version: 1, source: 'scheduled', taskType: 'scheduled-monitor',
    actor: { kind: 'system', purpose: 'scheduled-monitor' },
    taskId: scheduledMonitorTaskId(plan), jobId: buildScheduledMonitorJobId(plan),
    requestedAt: plannedSlot, createdAt: plannedSlot, expiresAt: '2026-10-14T00:00:00.000Z',
    ...changes,
  };
}
const common = (id: string) => ({
  id, name: '原始名称', country: 'US', brand: '原始品牌',
  is_broken: false, variant_status: 'NORMAL', feishu_notify_enabled: true,
  create_time: '2026-09-27 08:30:00.000001', update_time: '2026-09-27 08:30:00.000002', last_check_time: null,
});
const manual = {
  manual_broken: false, manual_broken_reason: null, manual_broken_updated_at: null, manual_broken_updated_by: null,
};
export function scheduledGroup(domain: 'primary' | 'competitor' = 'primary', id = ' 原始组😀 '): Record<string, unknown> {
  return domain === 'primary'
    ? { ...common(id),site:'amazon.com', ...manual,is_competitor:false }
    : common(id);
}
export function scheduledMember(domain: 'primary' | 'competitor' = 'primary', groupId = ' 原始组😀 ', id = '成员😀 '): Record<string, unknown> {
  const member = { ...common(id),asin:'B000000001',asin_type:'PARENT',variant_group_id:groupId };
  return domain === 'primary'
    ? { ...member,site:'amazon.com', ...manual,manual_excluded_from_group:false,manual_excluded_reason:null,manual_excluded_updated_at:null,manual_excluded_updated_by:null }
    : member;
}
