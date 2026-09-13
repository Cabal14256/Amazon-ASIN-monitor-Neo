import type {
  FeishuCard,
  NotificationAsin,
  NotificationData,
  NotificationGroup,
} from './types';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  hourCycle: 'h23',
});
export function notificationTime(value: Date = new Date()): string {
  const date = Number.isNaN(value.getTime()) ? new Date() : value;
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
const own = (map: Record<string, string>, key: string | undefined) =>
  key && Object.hasOwn(map, key) ? map[key] : undefined;
const regionNames = { US: '美国区域', EU: '欧洲区域' };
const manual = (source: string | null | undefined) =>
  String(source || '').includes('MANUAL');
const statusLabel = (source: string) =>
  own(
    {
      AUTO: '自动检测',
      MANUAL: '人工标记',
      'AUTO+MANUAL': '自动检测 + 人工标记',
      NORMAL: '正常',
    },
    source,
  ) ||
  source ||
  '未知';
const groupKey = (
  item: NotificationGroup | null,
  groupName: string | null | undefined,
) =>
  item?.variantGroupId
    ? `id:${item.variantGroupId}`
    : `name:${groupName || '未知变体组'}`;
function asinLabel(item: NotificationAsin, country: string | undefined) {
  const asin = item.asin || '';
  if (!asin) return '';
  const domain =
    own(
      {
        US: 'amazon.com',
        UK: 'amazon.co.uk',
        DE: 'amazon.de',
        FR: 'amazon.fr',
        IT: 'amazon.it',
        ES: 'amazon.es',
      },
      country,
    ) || 'amazon.com';
  return `[${asin}](https://www.${domain}/dp/${encodeURIComponent(asin)})`;
}
function common(data: NotificationData) {
  const {
    country,
    totalGroups = 0,
    brokenGroups = 0,
    brokenASINs = [],
    brokenByType,
    checkTime,
  } = data;
  const countryName =
    data.countryDisplay || own(regionNames, country) || country;
  const time = checkTime
    ? checkTime instanceof Date
      ? notificationTime(checkTime)
      : checkTime
    : notificationTime();
  let text = `【${time}】【${countryName}】\n\n`;
  text += `已检查分组数量：${totalGroups}，异常分组数量：${brokenGroups}，异常ASIN数量：${brokenASINs.length}\n\n`;
  const total = brokenASINs.length;
  if (total > 0) {
    text += '异常分类统计：\n';
    for (const [count, label] of [
      [brokenByType?.SP_API_ERROR || 0, '❌ SP-API错误'],
      [brokenByType?.NOT_FOUND || 0, '⛔ ASIN不存在'],
      [brokenByType?.NO_VARIANTS || 0, '⚠️ 无父变体ASIN'],
    ] as const) {
      if (count > 0) text += `  ${label}：${count} 个\n`;
    }
  }
  return { text, countryName, total };
}
function card(
  title: string,
  brokenGroups: number,
  content: string,
): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: brokenGroups > 0 ? 'red' : 'green',
    },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content } }],
  };
}

/** Complete Legacy primary card, including manual sources and empty-ASIN groups. */
export function buildFeishuCard(data: NotificationData): FeishuCard {
  const {
    title = 'ASIN变体监控通知',
    country,
    brokenGroups = 0,
    brokenGroupNames = [],
    brokenGroupDetails = [],
    brokenASINs = [],
  } = data;
  const { text, countryName, total } = common(data);
  const countryCode =
    country?.trim() ||
    (countryName == null ? '' : String(countryName).trim()).match(
      /\(([A-Z]{2})\)$/,
    )?.[1] ||
    (countryName == null ? '' : String(countryName).trim());
  const heading = `${title}-${countryCode}${
    brokenGroups > 0 ? '异常' : '正常'
  }`;
  let content = text;
  if (total > 0) {
    const count = brokenASINs.filter((item) =>
      manual(item?.statusSource),
    ).length;
    if (count > 0) content += `  🏷️ 含人工标记：${count} 个\n`;
    content += '\n';
  }
  const manualGroups = brokenGroupDetails.filter((item) =>
    manual(item?.statusSource),
  ).length;
  if (manualGroups > 0) content += `含人工标记异常分组：${manualGroups} 个\n\n`;
  content += `${brokenGroups > 0 ? '⚠️ 发现异常' : '✅ 全部正常'}\n`;
  if (brokenGroups > 0) {
    const buckets = new Map<
      string,
      {
        groupName: string;
        detail: NotificationGroup | null;
        asins: NotificationAsin[];
      }
    >();
    for (const item of brokenGroupDetails) {
      if (!item?.groupName) continue;
      buckets.set(groupKey(item, item.groupName), {
        groupName: item.groupName,
        detail: item,
        asins: [],
      });
    }
    for (const item of brokenASINs) {
      const name = item.groupName || '未知变体组',
        key = groupKey(item, name);
      if (!buckets.has(key))
        buckets.set(key, { groupName: name, detail: null, asins: [] });
      buckets.get(key)!.asins.push(item);
    }
    const names = new Set(
      [...buckets.values()].map((bucket) => bucket.groupName),
    );
    for (const name of brokenGroupNames) {
      if (name && !names.has(name)) {
        names.add(name);
        buckets.set(`name:${name}`, {
          groupName: name,
          detail: null,
          asins: [],
        });
      }
    }
    for (const { groupName, detail, asins } of buckets.values()) {
      content += `\n⚠️ ${groupName}\n`;
      if (detail?.statusSource && detail.statusSource !== 'NORMAL')
        content += `  来源：${statusLabel(detail.statusSource)}\n`;
      if (detail?.manualBrokenReason)
        content += `  说明：${detail.manualBrokenReason}\n`;
      for (const item of asins) {
        const extra: string[] = [];
        if (item.brand) extra.push(`品牌：${item.brand}`);
        if (item.statusSource && item.statusSource !== 'NORMAL')
          extra.push(`来源：${statusLabel(item.statusSource)}`);
        if (item.manualBrokenReason)
          extra.push(`说明：${item.manualBrokenReason}`);
        content += `- ${asinLabel(item, country)}${
          extra.length ? `（${extra.join('；')}）` : ''
        }\n`;
      }
    }
  }
  return card(heading, brokenGroups, content);
}

/** Competitor ordering and branding differ intentionally from the primary card. */
export function buildCompetitorFeishuCard(data: NotificationData): FeishuCard {
  const {
    title = '竞品ASIN变体监控通知',
    country,
    brokenGroups = 0,
    brokenGroupDetails = [],
    brokenASINs = [],
  } = data;
  const { text, total } = common(data);
  let content = text + (total > 0 ? '\n' : '');
  content += `${brokenGroups > 0 ? '⚠️ 发现异常' : '✅ 全部正常'}\n`;
  if (brokenGroups > 0 && total > 0) {
    const buckets = new Map<
      string,
      { groupName: string; asins: NotificationAsin[] }
    >();
    for (const item of brokenASINs) {
      const name = item.groupName || '未知变体组',
        key = groupKey(item, name);
      if (!buckets.has(key)) buckets.set(key, { groupName: name, asins: [] });
      buckets.get(key)!.asins.push(item);
    }
    const order = new Set<string>();
    for (const item of brokenGroupDetails) {
      const key = groupKey(item, item?.groupName);
      if (buckets.has(key)) order.add(key);
    }
    for (const key of buckets.keys()) order.add(key);
    for (const key of order) {
      const { groupName, asins } = buckets.get(key)!;
      content += `\n⚠️ ${groupName}\n`;
      for (const item of asins)
        content += `- ${asinLabel(item, country)}${
          item.brand ? ` ⚠️ 品牌：${item.brand}` : ''
        }\n`;
    }
  }
  return card(title, brokenGroups, content);
}
