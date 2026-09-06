import type { CurrentUserData, PermissionCode } from '@asin-monitor/contracts';

/** Only pass the current-user response after server verification, never storage hints. */
export function createAccess(identity?: CurrentUserData) {
  const hasUser =
    Boolean(identity?.user.id) && identity?.user.status === 'ACTIVE';
  const permissions = new Set(identity?.permissions ?? []);
  const roles = new Set(identity?.roles ?? []);
  const can = (permission: PermissionCode) =>
    hasUser && permissions.has(permission);
  return {
    isLogin: hasUser,
    canAccessAdmin: hasUser && roles.has('ADMIN'),
    canAccessEditor: hasUser && (roles.has('EDITOR') || roles.has('ADMIN')),
    canAccessReadOnly:
      hasUser &&
      (roles.has('READONLY') || roles.has('EDITOR') || roles.has('ADMIN')),
    canAccessUserManagement: can('user:read') || can('role:read'),
    canReadASIN: can('asin:read'),
    canWriteASIN: can('asin:write'),
    canDeleteASIN: can('asin:delete'),
    canReadMonitor: can('monitor:read'),
    canWriteMonitor: can('monitor:write'),
    canReadAnalytics: can('analytics:read'),
    canReadSettings: can('settings:read'),
    canWriteSettings: can('settings:write'),
    canReadUser: can('user:read'),
    canWriteUser: can('user:write'),
    canDeleteUser: can('user:delete'),
    canReadRole: can('role:read'),
    canWriteRole: can('role:write'),
    canReadAudit: can('audit:read'),
    mustChangePassword:
      hasUser &&
      Boolean(
        identity?.mustChangePassword ||
          identity?.passwordExpired ||
          identity?.user.force_password_change,
      ),
  };
}

export type AccessPolicy = ReturnType<typeof createAccess>;
