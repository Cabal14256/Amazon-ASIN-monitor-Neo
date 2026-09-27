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
    hour12: false,
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((parts, item) => {
      if (item.type !== 'literal') parts[item.type] = item.value;
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

export function backupScheduleKey(
  config: Pick<BackupConfig, 'scheduleType' | 'scheduleValue' | 'backupTime'>,
  now = new Date(),
): string | null {
  if (!config.backupTime) return null;
  const parts = shanghaiParts(now);
  if (`${parts.hour}:${parts.minute}` !== config.backupTime) return null;
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
