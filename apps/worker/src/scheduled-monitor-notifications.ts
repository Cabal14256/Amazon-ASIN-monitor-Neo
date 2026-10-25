import type { ScheduledMonitorJob } from '@asin-monitor/contracts';
import {
  type PgCompetitorScheduledMonitorRunRepository,
  type PgPrimaryScheduledMonitorRunRepository,
  type ScheduledMonitorRun,
} from '@asin-monitor/db';
import {
  snapshotNotification,
  validateCountryNotification,
  type FeishuNotifications,
  type NotificationData,
} from '@asin-monitor/notify';

type Ledger = Pick<
  | PgPrimaryScheduledMonitorRunRepository
  | PgCompetitorScheduledMonitorRunRepository,
  | 'readGroupReceipt'
  | 'readNotification'
  | 'claimNotification'
  | 'completeNotification'
>;

type DeliveryResult = { success: boolean; unconfirmed?: true };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

function aggregateResult(
  summary: NotificationData,
  group: ScheduledMonitorRun['groups'][number],
  value: unknown,
) {
  const result = record(value);
  const snapshot = record(result.groupSnapshot);
  if (
    snapshot.id !== group.group.id ||
    typeof snapshot.country !== 'string' ||
    snapshot.country.replace(/ +$/, '').toUpperCase() !== group.country
  )
    throw new Error('SCHEDULED_MONITOR_NOTIFICATION_IDENTITY_INVALID');
  summary.totalGroups = (summary.totalGroups ?? 0) + 1;
  const groupNotifyEnabled = snapshot.feishuNotifyEnabled;
  if (result.isBroken === true) {
    summary.brokenGroups = (summary.brokenGroups ?? 0) + 1;
    const groupName = text(snapshot.name) ?? group.group.name;
    summary.brokenGroupNames ??= [];
    summary.brokenGroupDetails ??= [];
    summary.brokenGroupNames.push(groupName);
    summary.brokenGroupDetails.push({
      variantGroupId: group.group.id,
      groupName,
      statusSource: text(snapshot.statusSource),
      manualBrokenReason: text(snapshot.manualBrokenReason),
    });
  }
  const brokenByType = record(result.brokenByType);
  summary.brokenByType ??= {};
  for (const code of ['SP_API_ERROR', 'NOT_FOUND', 'NO_VARIANTS'] as const) {
    const count = brokenByType[code];
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
      summary.brokenByType[code] = (summary.brokenByType[code] ?? 0) + count;
  }
  const broken = result.brokenASINs;
  if (
    !Array.isArray(broken) ||
    groupNotifyEnabled === 0 ||
    groupNotifyEnabled === false
  )
    return;
  const children = Array.isArray(snapshot.children) ? snapshot.children : [];
  summary.brokenASINs ??= [];
  for (const item of broken) {
    const row = record(item);
    if (typeof row.asin !== 'string')
      throw new Error('SCHEDULED_MONITOR_NOTIFICATION_INVALID');
    const child = children
      .map(record)
      .find((candidate) => candidate.asin === row.asin);
    if (
      child?.feishuNotifyEnabled === 0 ||
      child?.feishuNotifyEnabled === false
    )
      continue;
    summary.brokenASINs.push({
      asin: row.asin,
      brand: text(row.brand),
      variantGroupId: group.group.id,
      groupName: text(snapshot.name) ?? group.group.name,
      statusSource: text(row.statusSource),
      manualBrokenReason: text(row.manualBrokenReason),
    });
  }
}

async function summaryFor(
  run: ScheduledMonitorRun,
  ledger: Ledger,
  signal: AbortSignal,
  checkpoint: () => Promise<void>,
): Promise<NotificationData> {
  const summary: NotificationData = {
    totalGroups: 0,
    brokenGroups: 0,
    brokenGroupNames: [],
    brokenGroupDetails: [],
    brokenASINs: [],
    brokenByType: {},
    checkTime: run.job.createdAt,
  };
  for (const group of run.groups) {
    await checkpoint();
    const receipt = await ledger.readGroupReceipt(
      run.job,
      group.ordinal,
      signal,
    );
    if (receipt === undefined)
      throw new Error('SCHEDULED_MONITOR_NOTIFICATION_RECEIPT_MISSING');
    aggregateResult(summary, group, receipt);
  }
  return summary;
}

export interface ScheduledMonitorNotificationOptions {
  ledgerFor(domain: ScheduledMonitorJob['domain']): Ledger;
  notifications: Pick<
    FeishuNotifications,
    'withCountryDelivery' | 'withCompetitorCountryDelivery'
  >;
}

/** Deliver one private scheduled-run country summary with a durable claim. */
export async function deliverScheduledMonitorNotifications(
  run: ScheduledMonitorRun,
  signal: AbortSignal,
  checkpoint: () => Promise<void>,
  options: ScheduledMonitorNotificationOptions,
): Promise<void> {
  const ledger = options.ledgerFor(run.job.domain);
  // A completed/claimed delivery is already an immutable recovery decision;
  // avoid rebuilding large receipt summaries or invoking Feishu on replay.
  const existing = await ledger.readNotification(
    run.job,
    run.job.country,
    signal,
  );
  if (existing !== undefined) return;
  const summary = snapshotNotification(
    await summaryFor(run, ledger, signal, checkpoint),
  );
  if (!summary.brokenASINs?.length) return;
  validateCountryNotification(run.job.domain, run.job.country, summary);
  let claimAttempted = false;
  let claimState: 'new' | 'claimed' | 'sent' | 'failed' | undefined;
  const claimForSend = async () => {
    if (claimAttempted) return true;
    claimAttempted = true;
    const claim = await ledger.readNotification(
      run.job,
      run.job.country,
      signal,
    );
    if (claim !== undefined) {
      claimState = claim;
      return false;
    }
    claimState = await ledger.claimNotification(
      run.job,
      run.job.country,
      signal,
    );
    return claimState === 'new';
  };

  const complete = async (result: DeliveryResult) => {
    if (result.unconfirmed) return;
    await ledger.completeNotification(
      run.job,
      run.job.country,
      result.success,
      signal,
    );
  };
  if (run.job.domain === 'primary') {
    await options.notifications.withCountryDelivery(
      'primary',
      run.job.country,
      summary,
      async (send) => {
        if (!(await claimForSend())) return;
        const result = (await send()) as DeliveryResult;
        await complete(result);
      },
      signal,
    );
    return;
  }

  const result = await options.notifications.withCompetitorCountryDelivery(
    run.job.country,
    summary,
    async (send) => {
      if (!(await claimForSend())) return undefined;
      const outcome = (await send()) as DeliveryResult;
      await complete(outcome);
      return outcome;
    },
    checkpoint,
    signal,
  );
  // An absent/disabled competitor config performs no POST. The claim is a
  // durable failed delivery so recovery cannot spin on an unavailable target.
  if (result === undefined && claimState === 'new')
    await ledger.completeNotification(run.job, run.job.country, false, signal);
}
