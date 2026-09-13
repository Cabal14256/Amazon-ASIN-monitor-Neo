import { NotificationError } from './errors';
import type { NotificationData, NotificationDomain } from './types';

const fail = (): never => {
  throw new NotificationError('invalid-input');
};
export function notificationCountry(value: unknown): string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 20 &&
    [...value].length <= 10 &&
    !value.includes('\0')
    ? value
    : fail();
}
export function notificationDomain(value: unknown): NotificationDomain {
  return value === 'primary' || value === 'competitor' ? value : fail();
}
/** Bound work before card rendering; copy only known plain input fields so a
 * caller cannot alter a future retry while its first attempt is in flight. */
export function snapshotNotification(value: unknown): NotificationData {
  let bytes = 0,
    items = 0;
  const text = (v: unknown) => {
    if (v === undefined || v === null) return v;
    if (typeof v !== 'string') return fail();
    bytes += Buffer.byteLength(v);
    if (bytes > 1024 * 1024 || v.includes('\0')) return fail();
    return v;
  };
  const count = (v: unknown) =>
    v === undefined
      ? undefined
      : Number.isSafeInteger(v) && (v as number) >= 0
      ? (v as number)
      : fail();
  const record = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail();
    const proto = Object.getPrototypeOf(v);
    if (proto !== null && proto !== Object.prototype) return fail();
    if (
      Object.values(Object.getOwnPropertyDescriptors(v)).some(
        (field) => field.get || field.set,
      )
    )
      return fail();
    return v as Record<string, unknown>;
  };
  const array = <T>(
    v: unknown,
    convert: (item: unknown) => T,
  ): T[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || (items += v.length) > 10_000) return fail();
    // Read the bounded own elements directly. Array.from would execute a
    // caller's custom iterator, which can yield more than the checked length.
    const result: T[] = [];
    for (let index = 0; index < v.length; index++) {
      const field = Object.getOwnPropertyDescriptor(v, String(index));
      if (!field || !Object.hasOwn(field, 'value')) return fail();
      result.push(convert(field.value));
    }
    return result;
  };
  const group = (v: unknown) => {
    const row = record(v);
    return {
      variantGroupId: text(row.variantGroupId),
      groupName: text(row.groupName),
      statusSource: text(row.statusSource),
      manualBrokenReason: text(row.manualBrokenReason),
    };
  };
  const row = record(value),
    result: NotificationData = {};
  for (const key of ['title', 'country', 'countryDisplay', 'region'] as const) {
    if (row[key] === null) return fail();
    const value = text(row[key]);
    if (value !== undefined && value !== null) result[key] = value;
  }
  result.totalGroups = count(row.totalGroups);
  result.brokenGroups = count(row.brokenGroups);
  result.brokenGroupNames = array(row.brokenGroupNames, (v) =>
    typeof v === 'string' ? text(v)! : fail(),
  );
  result.brokenGroupDetails = array(row.brokenGroupDetails, (v) =>
    v === null ? null : group(v),
  );
  result.brokenASINs = array(row.brokenASINs, (v) => {
    const item = record(v);
    return { ...group(item), asin: text(item.asin), brand: text(item.brand) };
  });
  if (row.brokenByType === null) result.brokenByType = null;
  else if (row.brokenByType !== undefined) {
    const types = record(row.brokenByType);
    result.brokenByType = {
      SP_API_ERROR: count(types.SP_API_ERROR),
      NOT_FOUND: count(types.NOT_FOUND),
      NO_VARIANTS: count(types.NO_VARIANTS),
    };
  }
  if (row.checkTime instanceof Date)
    result.checkTime = new Date(row.checkTime.getTime());
  else result.checkTime = text(row.checkTime);
  return result;
}
