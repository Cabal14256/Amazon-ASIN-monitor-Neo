import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCompetitorFeishuCard, buildFeishuCard } from '../src/cards';
import type { NotificationData } from '../src/types';
import { legacyNotify } from './helpers/legacy-notify';

describe.each(['primary', 'competitor'] as const)(
  '%s notification / complete actual Legacy card',
  (domain) => {
    let legacy: ReturnType<typeof legacyNotify>;
    const build =
      domain === 'primary' ? buildFeishuCard : buildCompetitorFeishuCard;
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-13T16:00:00Z'));
      legacy = legacyNotify(domain);
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    function compare(data: NotificationData) {
      const actual = build(data);
      expect(actual).toEqual(JSON.parse(JSON.stringify(legacy(data))));
      return actual;
    }
    it.each([
      'US',
      'EU',
      'UK',
      'DE',
      'FR',
      'IT',
      'ES',
      'JP',
      'us ',
      '',
      undefined,
    ])(
      'retains complete normal/abnormal output and Amazon URLs for %s',
      (country) => {
        for (const brokenGroups of [0, 1])
          compare({
            country,
            totalGroups: 3,
            brokenGroups,
            brokenASINs: [
              { asin: 'B000000001', brand: 'Brand中文', groupName: '组甲' },
            ],
            brokenByType: { SP_API_ERROR: 1, NOT_FOUND: 2, NO_VARIANTS: 3 },
          });
      },
    );
    it.each([
      undefined,
      null,
      '',
      '已格式化时间',
      new Date('2024-02-28T16:00:00Z'),
      new Date('2024-02-29T15:59:59Z'),
      new Date('invalid'),
    ])('preserves D8/current/provided time (%s)', (checkTime) => {
      compare({ country: 'US', checkTime });
    });
    it('preserves default and explicit empty titles, country display and title-country inference', () => {
      for (const title of [undefined, '', '自定义通知'])
        for (const country of [undefined, '', ' US '])
          for (const countryDisplay of [
            undefined,
            ' 美国(US) ',
            '欧洲五国',
            '',
          ])
            compare({ title, country, countryDisplay });
    });
    it('uses group identity, stable detailed group order, same-name groups, orphan ASINs and fallback-only names', () => {
      compare({
        country: 'DE',
        totalGroups: 6,
        brokenGroups: 5,
        brokenGroupDetails: [
          { variantGroupId: 'g2', groupName: '同名组' },
          null,
          {
            variantGroupId: 'g1',
            groupName: '同名组',
            statusSource: 'MANUAL',
            manualBrokenReason: '人工说明',
          },
          { groupName: '仅组详情', statusSource: 'AUTO+MANUAL' },
          { groupName: '' },
        ],
        brokenGroupNames: ['额外空组', '同名组', ''],
        brokenASINs: [
          { variantGroupId: 'g1', groupName: '同名组', asin: 'B000000001' },
          { variantGroupId: 'g2', groupName: '同名组', asin: 'B000000002' },
          { asin: 'B000000003' },
          { groupName: '无ID组', asin: 'B000000004' },
          { groupName: '无ID组', asin: '', brand: '品牌' },
        ],
      });
    });
    it('keeps all manual/automatic classifications and reasons without losing Unicode or markdown text', () => {
      for (const source of [
        undefined,
        null,
        '',
        'NORMAL',
        'AUTO',
        'MANUAL',
        'AUTO+MANUAL',
        'unknown',
        'prefixMANUAL',
      ])
        compare({
          country: 'UK',
          brokenGroups: 2,
          brokenByType: null,
          brokenGroupDetails: [
            {
              groupName: '组[一]',
              statusSource: source,
              manualBrokenReason: '中文🔎\n多行',
            },
          ],
          brokenASINs: [
            {
              groupName: '组[一]',
              asin: 'A /?中',
              brand: '品牌；（文本）',
              statusSource: source,
              manualBrokenReason: 'ASIN说明',
            },
          ],
        });
    });
    it('retains duplicate detail replacement and grouping with no broken ASINs', () => {
      compare({
        country: 'US',
        brokenGroups: 1,
        brokenGroupDetails: [
          { variantGroupId: 'same', groupName: '旧名', statusSource: 'AUTO' },
          { variantGroupId: 'same', groupName: '新名', statusSource: 'MANUAL' },
        ],
        brokenGroupNames: ['仅名称'],
      });
    });
  },
);
