import type {
  CompetitorMonitorJob,
  PrimaryMonitorJob,
} from '@asin-monitor/contracts';
import type {
  MonitorCountryResult,
  MonitorMessage,
  RedisMonitorEventRepository,
  TaskState,
} from '@asin-monitor/db';
import { MONITOR_MESSAGE_MAX_BYTES } from '@asin-monitor/db';
import { logger } from './logger';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown, fallback = '') =>
  typeof value === 'string' ? value : fallback;
const nullable = (value: unknown) => (typeof value === 'string' ? value : null);
/** Canonical UTC+8 ISO, hours 00..23. Legacy Intl h24 can display the same
 * local day's zero hour as 24; that platform-dependent byte form is not sent. */
export const monitorTimestamp = (date = new Date()) =>
  new Date(date.getTime() + 8 * 3600_000).toISOString().replace('Z', '+08:00');
const manualFields = (row: Record<string, unknown>) => ({
  statusSource: text(row.statusSource, 'NORMAL'),
  manualBroken: row.manualBroken === 1 ? (1 as const) : (0 as const),
  manualBrokenReason: text(row.manualBrokenReason),
  manualBrokenUpdatedAt: nullable(row.manualBrokenUpdatedAt),
  manualBrokenUpdatedBy: nullable(row.manualBrokenUpdatedBy),
});
const automaticTypes = new Set(['SP_API_ERROR', 'NOT_FOUND', 'NO_VARIANTS']);
class MonitorSummaryCapacity extends Error {}
/** Reconstruct the public business summary, separately from the Feishu recipient
 * selection. No task internals, transport errors or credentials are forwarded. */
export class MonitorRunEvents {
  readonly countryResults: Record<string, MonitorCountryResult>;
  private readonly startedAt = process.hrtime.bigint();
  private readonly competitor: boolean;
  private summaryBytes = 0;
  private unavailable = false;
  private readonly classificationCounts = new Map<string, number>();
  constructor(
    private readonly data: PrimaryMonitorJob | CompetitorMonitorJob,
    private readonly publisher?: Pick<RedisMonitorEventRepository, 'publish'>,
  ) {
    this.competitor = data.taskType === 'competitor-monitor';
    const checkTime = new Date().toISOString();
    this.countryResults = Object.fromEntries(
      data.countries.map((country) => [
        country,
        {
          country,
          totalGroups: 0,
          brokenGroups: 0,
          brokenGroupNames: [],
          brokenGroupDetails: [],
          brokenASINs: [],
          brokenByType: { SP_API_ERROR: 0, NOT_FOUND: 0, NO_VARIANTS: 0 },
          asinClassifications: {},
          checkedGroupKeys: [],
          checkTime,
        },
      ]),
    );
    this.summaryBytes = Buffer.byteLength(JSON.stringify(this.countryResults));
  }
  private reserve(bytes: number) {
    this.summaryBytes += bytes;
    if (this.summaryBytes > MONITOR_MESSAGE_MAX_BYTES)
      throw new MonitorSummaryCapacity();
  }
  private append<T>(array: T[], item: T) {
    this.reserve(
      Buffer.byteLength(JSON.stringify(item)) + (array.length ? 1 : 0),
    );
    array.push(item);
  }
  private async send(
    task: TaskState,
    sequence: number,
    message: MonitorMessage,
  ) {
    if (!this.publisher) return;
    try {
      await this.publisher.publish(task, sequence, message);
    } catch (error) {
      // Publication is advisory and must not reclassify already committed work.
      logger.warn('监控实时消息未确认，请通过监控历史和任务查询恢复', {
        reason:
          error instanceof Error && error.message === 'MONITOR_EVENT_TOO_LARGE'
            ? 'monitor_event_capacity'
            : 'monitor_event_unconfirmed',
      });
    }
  }
  started(task: TaskState) {
    return this.send(task, 0, {
      type: 'monitor_progress',
      status: 'started',
      countries: this.data.countries,
      batchInfo: null,
      timestamp: monitorTimestamp(),
      ...(this.competitor ? { isCompetitor: true as const } : {}),
    });
  }
  progress(
    task: TaskState,
    country: PrimaryMonitorJob['countries'][number],
    current: number,
    total: number,
  ) {
    return this.send(
      task,
      this.data.countries.indexOf(country) * 1001 + current,
      {
        type: 'monitor_progress',
        status: 'progress',
        country,
        current,
        total,
        progress: Math.round((current / total) * 100),
        timestamp: monitorTimestamp(),
        ...(this.competitor ? { isCompetitor: true as const } : {}),
      },
    );
  }
  addGroup(country: string, input: unknown) {
    if (this.unavailable) return;
    try {
      this.collectGroup(country, input);
    } catch (error) {
      this.unavailable = true;
      for (const key of Object.keys(this.countryResults))
        delete this.countryResults[key];
      this.classificationCounts.clear();
      logger.warn('监控实时摘要不可用，请通过监控历史和任务查询恢复', {
        reason:
          error instanceof MonitorSummaryCapacity
            ? 'monitor_event_capacity'
            : 'monitor_event_unconfirmed',
      });
    }
  }
  private collectGroup(country: string, input: unknown) {
    const result = record(input),
      group = record(result.groupSnapshot),
      summary = this.countryResults[country];
    const countBytes = () =>
      JSON.stringify([
        summary.totalGroups,
        summary.brokenGroups,
        ...Object.values(summary.brokenByType),
      ]).length;
    const previousCountBytes = countBytes();
    const groupId = text(group.id),
      groupName = text(group.name);
    summary.totalGroups++;
    this.append(summary.checkedGroupKeys, `group:${groupId}`);
    if (!this.competitor) summary.checkTime = new Date().toISOString();
    if (result.isBroken === true) {
      summary.brokenGroups++;
      this.append(summary.brokenGroupNames, groupName);
      this.append(summary.brokenGroupDetails, {
        variantGroupId: groupId,
        groupName: this.competitor ? groupName : groupName || null,
        ...(!this.competitor ? manualFields(group) : {}),
      });
      const counts = record(result.brokenByType);
      for (const key of ['SP_API_ERROR', 'NOT_FOUND', 'NO_VARIANTS'] as const)
        summary.brokenByType[key] +=
          typeof counts[key] === 'number' ? (counts[key] as number) : 0;
    }
    this.reserve(countBytes() - previousCountBytes);
    const children = Array.isArray(group.children)
      ? group.children.map(record)
      : [];
    const details = record(result.details),
      observations = Array.isArray(details.results)
        ? details.results.map(record)
        : [];
    const broken = Array.isArray(result.brokenASINs)
      ? result.brokenASINs.map(record)
      : [];
    const index = (rows: Record<string, unknown>[]) => {
      const values = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        const key = text(row.asin).toUpperCase();
        if (!values.has(key)) values.set(key, row); // Legacy find() keeps the first case-insensitive match.
      }
      return values;
    };
    const observationsByAsin = index(observations),
      brokenByAsin = index(broken);
    for (const child of children) {
      const asin = text(child.asin),
        asinId = text(child.id);
      const current = observationsByAsin.get(asin.toUpperCase());
      const brokenAsin = brokenByAsin.get(asin.toUpperCase());
      const isDeferred = current?.isDeferred === true;
      const currentBroken =
        !isDeferred &&
        !!current &&
        (current.isBroken === true ||
          current.hasVariants === false ||
          (current.hasVariants !== true &&
            current.variantCount !== undefined &&
            Number(current.variantCount) === 0));
      const automatic = isDeferred
        ? null
        : text(current?.errorType) ||
          (currentBroken ? 'NO_VARIANTS' : text(brokenAsin?.errorType)) ||
          null;
      const errorType =
        automatic ||
        (['MANUAL', 'AUTO+MANUAL'].includes(text(child.statusSource))
          ? 'MANUAL_MARKED'
          : null);
      if (automatic && automaticTypes.has(automatic)) {
        const key = `group:${groupId}:asin:${asinId || asin}`,
          previous = summary.asinClassifications[key];
        if (previous)
          this.reserve(
            Buffer.byteLength(JSON.stringify(automatic)) -
              Buffer.byteLength(JSON.stringify(previous)),
          );
        else {
          const count = this.classificationCounts.get(country) ?? 0;
          this.reserve(
            Buffer.byteLength(JSON.stringify(key)) +
              1 +
              Buffer.byteLength(JSON.stringify(automatic)) +
              (count ? 1 : 0),
          );
          this.classificationCounts.set(country, count + 1);
        }
        summary.asinClassifications[key] = automatic as
          | 'SP_API_ERROR'
          | 'NOT_FOUND'
          | 'NO_VARIANTS';
      }
      const enabled = (row: Record<string, unknown>) =>
        this.competitor
          ? row.feishuNotifyEnabled !== null &&
            row.feishuNotifyEnabled !== undefined &&
            row.feishuNotifyEnabled !== 0
          : row.feishuNotifyEnabled !== 0;
      if (enabled(group) && enabled(child) && child.isBroken === 1)
        this.append(summary.brokenASINs, {
          asin,
          ...(asinId ? { asinId } : {}),
          name: text(child.name),
          variantGroupId: groupId,
          groupName,
          brand: text(child.brand),
          errorType: errorType as
            | 'SP_API_ERROR'
            | 'NOT_FOUND'
            | 'NO_VARIANTS'
            | 'MANUAL_MARKED'
            | null,
          ...(!this.competitor ? manualFields(child) : {}),
        });
    }
  }
  complete(task: TaskState) {
    if (this.unavailable) return Promise.resolve();
    const rows = Object.values(this.countryResults),
      totalChecked = rows.reduce((n, r) => n + r.totalGroups, 0),
      totalBroken = rows.reduce((n, r) => n + r.brokenGroups, 0);
    return this.send(task, 7000, {
      type: 'monitor_complete',
      success: true,
      totalChecked,
      totalBroken,
      totalNormal: totalChecked - totalBroken,
      duration: (
        Number(process.hrtime.bigint() - this.startedAt) / 1e9
      ).toFixed(2),
      countryResults: this.countryResults,
      timestamp: monitorTimestamp(),
      ...(this.competitor ? { isCompetitor: true as const } : {}),
    });
  }
}
