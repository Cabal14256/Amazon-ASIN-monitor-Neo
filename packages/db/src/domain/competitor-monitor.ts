import {
  competitorMonitorJobSchema,
  type CompetitorMonitorJob,
} from '@asin-monitor/contracts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RoleWriteUnit } from '../repositories/role-repository';
import type { CompetitorGroupCheckSnapshot } from './competitor-check';

export const COMPETITOR_MONITOR_MAX_GROUPS = 1000;
export const COMPETITOR_MONITOR_MAX_MEMBERS = 20_000;
export const COMPETITOR_MONITOR_MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export interface CompetitorMonitorGroup {
  groupId: string;
  country: 'US' | 'UK' | 'DE' | 'FR' | 'IT' | 'ES';
  snapshotDigest: string;
}
/** Private original canonical notification inputs; never put these in a public
 * task result. Current rows must still match before a new external send. */
export interface CompetitorMonitorNotificationCandidate {
  groupId: string;
  groupName: string;
  groupCreatedAt: string | null;
  asinId: string;
  asin: string;
  brand: string | null;
  asinCreatedAt: string | null;
}
export function assertCompetitorMonitorNotificationCandidate(
  country: CompetitorMonitorGroup['country'],
  candidate: CompetitorMonitorNotificationCandidate,
  group: CompetitorGroupCheckSnapshot['group'] | undefined,
  asin: CompetitorGroupCheckSnapshot['asins'][number] | undefined,
): void {
  if (
    !group ||
    !asin ||
    group.id !== candidate.groupId ||
    group.name !== candidate.groupName ||
    group.createTime?.toISOString() !==
      (candidate.groupCreatedAt ?? undefined) ||
    group.country.replace(/ +$/, '').toUpperCase() !== country ||
    group.feishuNotifyEnabled !== true ||
    asin.id !== candidate.asinId ||
    asin.asin !== candidate.asin ||
    asin.brand !== candidate.brand ||
    asin.createTime?.toISOString() !== (candidate.asinCreatedAt ?? undefined) ||
    asin.variantGroupId !== group.id ||
    asin.country.replace(/ +$/, '').toUpperCase() !== country ||
    asin.feishuNotifyEnabled !== true
  )
    throw new CompetitorMonitorControlError('denied');
}
export type CompetitorMonitorControlUnit = Pick<
  RoleWriteUnit,
  'lockOperator' | 'operatorPermissionCodes'
> & {
  competitorMonitorConfiguration(): Promise<string | null | undefined>;
};
export class CompetitorMonitorControlError extends Error {
  constructor(readonly code: 'disabled' | 'denied') {
    super(code === 'disabled' ? '竞品监控已关闭' : '当前账户无权执行竞品监控');
    this.name = 'CompetitorMonitorControlError';
  }
}
/** Match Legacy's DB override and fallback; a fresh failed read never falls
 * back to a previously enabled value. */
export function competitorMonitorEnabled(
  value: string | null | undefined,
  fallback: boolean,
): boolean {
  const normalized = value?.trim().toLowerCase();
  return ['true', '1'].includes(normalized ?? '')
    ? true
    : ['false', '0'].includes(normalized ?? '')
    ? false
    : fallback;
}
export async function assertCompetitorMonitorControl(
  unit: CompetitorMonitorControlUnit,
  userId: string,
  fallback: boolean,
) {
  const user = await unit.lockOperator(userId);
  const active =
    user?.status?.trim().toUpperCase() === 'ACTIVE' &&
    (user.lockedUntil === null || user.lockedUntil <= new Date());
  if (
    !user ||
    !active ||
    user.forcePasswordChange ||
    (user.passwordExpiresAt && user.passwordExpiresAt <= new Date()) ||
    !(await unit.operatorPermissionCodes(userId)).includes('monitor:write')
  )
    throw new CompetitorMonitorControlError('denied');
  if (
    !competitorMonitorEnabled(
      await unit.competitorMonitorConfiguration(),
      fallback,
    )
  )
    throw new CompetitorMonitorControlError('disabled');
}
/** Hash canonical persisted inputs, not transport aliases or incidental update
 * timestamps. Creation identity prevents a delete/recreate from matching. */
export function competitorMonitorSnapshotText(
  snapshot: CompetitorGroupCheckSnapshot,
): string {
  const g = snapshot.group;
  return JSON.stringify([
    [
      g.id,
      g.name,
      g.country,
      g.brand,
      g.feishuNotifyEnabled,
      g.createTime?.toISOString() ?? null,
    ],
    [...snapshot.asins]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((a) => [
        a.id,
        a.asin,
        a.name,
        a.asinType,
        a.country,
        a.brand,
        a.variantGroupId,
        a.feishuNotifyEnabled,
        a.isBroken,
        a.variantStatus,
        a.createTime?.toISOString() ?? null,
      ]),
  ]);
}
export function competitorMonitorSnapshotDigest(
  snapshot: CompetitorGroupCheckSnapshot,
): string {
  return createHash('sha256')
    .update(competitorMonitorSnapshotText(snapshot))
    .digest('hex');
}
export function competitorMonitorJobDigest(raw: CompetitorMonitorJob): string {
  const job = competitorMonitorJobSchema.parse(raw);
  return createHash('sha256')
    .update(
      JSON.stringify([
        job.taskId,
        job.userId,
        job.taskType,
        job.taskSubType,
        job.createdAt,
        job.expiresAt,
        job.countries,
      ]),
    )
    .digest('hex');
}
const count = z.number().int().min(0).max(COMPETITOR_MONITOR_MAX_MEMBERS);
export const competitorMonitorCompletionSchema = z
  .object({
    success: z.literal(true),
    totalChecked: count,
    totalBroken: count,
    totalNormal: count,
    countryResults: z.record(
      z.enum(['US', 'UK', 'DE', 'FR', 'IT', 'ES']),
      z
        .object({
          totalGroups: count,
          brokenGroups: count,
          checkTime: z.string().datetime(),
          brokenByType: z.object({
            SP_API_ERROR: count,
            NOT_FOUND: count,
            NO_VARIANTS: count,
          }),
        })
        .strict(),
    ),
    notificationResults: z.record(
      z.enum(['US', 'UK', 'DE', 'FR', 'IT', 'ES']),
      z.enum(['sent', 'failed', 'unconfirmed', 'skipped']),
    ),
    _competitorMonitorCommit: z
      .object({
        version: z.literal(1),
        requestHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();
export function parseCompetitorMonitorCompletion(
  job: CompetitorMonitorJob,
  value: unknown,
) {
  const result = competitorMonitorCompletionSchema.parse(value);
  if (
    result._competitorMonitorCommit.requestHash !==
      competitorMonitorJobDigest(job) ||
    result.totalChecked !== result.totalBroken + result.totalNormal ||
    JSON.stringify(Object.keys(result.countryResults)) !==
      JSON.stringify(job.countries) ||
    JSON.stringify(Object.keys(result.notificationResults)) !==
      JSON.stringify(job.countries) ||
    Object.values(result.countryResults).some(
      (row) =>
        row.checkTime !== job.createdAt || row.brokenGroups > row.totalGroups,
    ) ||
    result.totalChecked !==
      Object.values(result.countryResults).reduce(
        (sum, row) => sum + row.totalGroups,
        0,
      ) ||
    result.totalBroken !==
      Object.values(result.countryResults).reduce(
        (sum, row) => sum + row.brokenGroups,
        0,
      )
  )
    throw new Error('COMPETITOR_MONITOR_RESULT_IDENTITY_CHANGED');
  return result;
}
