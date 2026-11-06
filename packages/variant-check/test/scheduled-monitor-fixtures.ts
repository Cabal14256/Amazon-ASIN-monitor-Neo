import {
  buildScheduledMonitorJobId,
  type ScheduledMonitorJob,
} from '@asin-monitor/contracts';
import {
  scheduledMonitorBatchIndex,
  scheduledMonitorTaskId,
} from '@asin-monitor/db';

export function scheduledJob(
  domain: 'primary' | 'competitor' = 'primary',
): ScheduledMonitorJob {
  const plannedSlot = '2026-10-07T00:00:00.000Z';
  const intervalMinutes = 30 as const;
  const batchConfig = {
    batchIndex: scheduledMonitorBatchIndex(
      Date.parse(plannedSlot),
      intervalMinutes,
      1,
    ),
    totalBatches: 1,
  };
  const plan = {
    domain,
    country: 'US' as const,
    plannedSlot,
    intervalMinutes,
    batchConfig,
  };
  return {
    ...plan,
    version: 1,
    source: 'scheduled',
    taskType: 'scheduled-monitor',
    actor: { kind: 'system', purpose: 'scheduled-monitor' },
    taskId: scheduledMonitorTaskId(plan),
    jobId: buildScheduledMonitorJobId(plan),
    requestedAt: plannedSlot,
    createdAt: plannedSlot,
    expiresAt: '2026-10-14T00:00:00.000Z',
  };
}

const common = (id: string) => ({
  id,
  name: 'Scheduled fixture',
  country: 'US',
  brand: 'Fixture',
  is_broken: false,
  variant_status: 'NORMAL',
  feishu_notify_enabled: true,
  create_time: '2026-09-27 08:30:00.000001',
  update_time: '2026-09-27 08:30:00.000002',
  last_check_time: null,
});

export function scheduledGroup(domain: 'primary' | 'competitor', id: string) {
  return domain === 'primary'
    ? {
        ...common(id),
        site: 'amazon.com',
        manual_broken: false,
        manual_broken_reason: null,
        manual_broken_updated_at: null,
        manual_broken_updated_by: null,
        is_competitor: false,
      }
    : common(id);
}

export function scheduledMember(
  domain: 'primary' | 'competitor',
  groupId: string,
  id: string,
) {
  const member = {
    ...common(id),
    asin: 'B000000001',
    asin_type: 'PARENT',
    variant_group_id: groupId,
  };
  return domain === 'primary'
    ? {
        ...member,
        site: 'amazon.com',
        manual_broken: false,
        manual_broken_reason: null,
        manual_broken_updated_at: null,
        manual_broken_updated_by: null,
        manual_excluded_from_group: false,
        manual_excluded_reason: null,
        manual_excluded_updated_at: null,
        manual_excluded_updated_by: null,
      }
    : member;
}
