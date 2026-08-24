/**
 * 权限码常量表。
 * P0-T1 将对照 src/access.ts 与 server checkPermission 调用点补全全部 domain:action。
 */
export const PERMISSION_DOMAINS = [
  'asin',
  'monitor',
  'competitor',
  'export',
  'tasks',
  'backup',
  'feishu',
  'sp-api-config',
  'audit',
  'ops',
  'users',
  'roles',
  'system',
] as const;
export type PermissionDomain = (typeof PERMISSION_DOMAINS)[number];

/** domain:action 形式的权限码 */
export type PermissionCode = `${PermissionDomain}:${string}`;
