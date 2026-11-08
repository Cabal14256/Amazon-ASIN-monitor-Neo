import type { BackupConfig } from '@asin-monitor/contracts';

export function shanghaiParts(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((parts, item) => {
      if (item.type !== 'literal')
        parts[item.type] =
          item.type === 'hour' && item.value === '24' ? '00' : item.value;
      return parts;
    }, {});
}

const weekday = (value: string): number =>
  ((
    { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<
      string,
      number
    >
  )[value] ?? 0);

const BACKUP_SCHEDULE_CATCHUP_MS = 5 * 60_000;

export function backupScheduleKey(
  config: Pick<BackupConfig, 'scheduleType' | 'scheduleValue' | 'backupTime'>,
  now = new Date(),
): string | null {
  if (!config.backupTime) return null;
  // A failed enqueue can retry on the next 30-second tick, including after
  // midnight. Keep the original scheduled key so task IDs remain stable.
  for (let minutesAgo = 0; minutesAgo <= 5; minutesAgo++) {
    const parts = shanghaiParts(new Date(now.getTime() - minutesAgo * 60_000));
    if (`${parts.hour}:${parts.minute}` !== config.backupTime) continue;
    const scheduledAt = Date.parse(
      `${parts.year}-${parts.month}-${parts.day}T${config.backupTime}:00+08:00`,
    );
    if (now.getTime() - scheduledAt >= BACKUP_SCHEDULE_CATCHUP_MS) return null;
    if (
      config.scheduleType === 'weekly' &&
      weekday(parts.weekday) !== config.scheduleValue
    )
      return null;
    if (
      config.scheduleType === 'monthly' &&
      Number(parts.day) !== config.scheduleValue
    )
      return null;
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  }
  return null;
}
