import { z } from 'zod';

/**
 * 权限码常量表。
 *
 * 来源：server/database/init.sql、server/src/routes/*.js 的
 * checkPermission 调用点，以及 src/access.ts（2026-08-24）。
 * 这里刻意使用旧系统真实的单数资源名（user/role），不把 API 域名
 * users/roles 或无独立权限资源的 tasks/backup 等混入权限码。
 */
export const PERMISSION_DOMAINS = [
  'asin',
  'monitor',
  'analytics',
  'settings',
  'user',
  'role',
  'audit',
] as const;
export type PermissionDomain = (typeof PERMISSION_DOMAINS)[number];

/** 数据库种子与前端 accessFactory 使用的完整权限全集（14 个）。 */
export const PERMISSION_CODES = [
  'asin:read',
  'asin:write',
  'asin:delete',
  'monitor:read',
  'monitor:write',
  'analytics:read',
  'settings:read',
  'settings:write',
  'user:read',
  'user:write',
  'user:delete',
  'role:read',
  'role:write',
  'audit:read',
] as const;

export const permissionCodeSchema = z.enum(PERMISSION_CODES);
export type PermissionCode = z.infer<typeof permissionCodeSchema>;

/** 供 Guard/前端权限工厂共用的权限元数据。 */
export const PERMISSIONS = [
  { code: 'asin:read', resource: 'asin', action: 'read' },
  { code: 'asin:write', resource: 'asin', action: 'write' },
  { code: 'asin:delete', resource: 'asin', action: 'delete' },
  { code: 'monitor:read', resource: 'monitor', action: 'read' },
  { code: 'monitor:write', resource: 'monitor', action: 'write' },
  { code: 'analytics:read', resource: 'analytics', action: 'read' },
  { code: 'settings:read', resource: 'settings', action: 'read' },
  { code: 'settings:write', resource: 'settings', action: 'write' },
  { code: 'user:read', resource: 'user', action: 'read' },
  { code: 'user:write', resource: 'user', action: 'write' },
  { code: 'user:delete', resource: 'user', action: 'delete' },
  { code: 'role:read', resource: 'role', action: 'read' },
  { code: 'role:write', resource: 'role', action: 'write' },
  { code: 'audit:read', resource: 'audit', action: 'read' },
] as const satisfies ReadonlyArray<{
  code: PermissionCode;
  resource: PermissionDomain;
  action: string;
}>;

export function isPermissionCode(value: unknown): value is PermissionCode {
  return permissionCodeSchema.safeParse(value).success;
}
