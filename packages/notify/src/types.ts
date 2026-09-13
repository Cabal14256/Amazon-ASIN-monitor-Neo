export interface NotificationGroup {
  variantGroupId?: string | null;
  groupName?: string | null;
  statusSource?: string | null;
  manualBrokenReason?: string | null;
}
export interface NotificationAsin extends NotificationGroup {
  asin?: string | null;
  brand?: string | null;
}
export interface NotificationData {
  title?: string;
  country?: string;
  countryDisplay?: string;
  region?: string;
  totalGroups?: number;
  brokenGroups?: number;
  brokenGroupNames?: string[];
  brokenGroupDetails?: (NotificationGroup | null)[];
  brokenASINs?: NotificationAsin[];
  brokenByType?: Partial<
    Record<'SP_API_ERROR' | 'NOT_FOUND' | 'NO_VARIANTS', number>
  > | null;
  checkTime?: Date | string | null;
}
export interface FeishuCard {
  config: { wide_screen_mode: true };
  header: {
    title: { tag: 'plain_text'; content: string };
    template: 'red' | 'green';
  };
  elements: { tag: 'div'; text: { tag: 'lark_md'; content: string } }[];
}
export type NotificationDomain = 'primary' | 'competitor';
