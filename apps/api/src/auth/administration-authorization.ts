import type { PermissionCode } from '@asin-monitor/contracts';
import type { RoleWriteUnit } from '@asin-monitor/db';
import { HttpException } from '@nestjs/common';
import type { AuthPrincipal } from './auth.types';
import { normalizeUserStatus } from './authentication.service';

function deny(message: string): never {
  throw new HttpException(
    { success: false, errorCode: 403, errorMessage: message },
    403,
  );
}

type AdministrationAuthorizationUnit = Pick<
  RoleWriteUnit,
  'lockOperator' | 'lockSession' | 'operatorPermissionCodes'
>;

/** Called after the shared administration lock, inside the transaction. */
export function authorizeAdministration(
  unit: AdministrationAuthorizationUnit,
  principal: AuthPrincipal,
  permission: PermissionCode,
) {
  return authorizeAdministrationAny(unit, principal, [permission]);
}

/** A current permission grant must satisfy at least one explicitly allowed code.
 * Cached token/guard permissions cannot authorize a cached analytics response. */
export async function authorizeAdministrationAny(
  unit: AdministrationAuthorizationUnit,
  principal: AuthPrincipal,
  permissions: readonly PermissionCode[],
) {
  await authorizeCurrentSession(unit, principal);
  const current = await unit.operatorPermissionCodes(principal.userId);
  if (!permissions.some((permission) => current.includes(permission)))
    deny('没有权限执行此操作');
}

/** Authenticated-only reads still recheck account/password/session state under
 * the transaction lock. This does not treat an empty permission list as a grant. */
export async function authorizeCurrentSession(
  unit: Pick<AdministrationAuthorizationUnit, 'lockOperator' | 'lockSession'>,
  principal: AuthPrincipal,
) {
  const user = await unit.lockOperator(principal.userId);
  if (!user || normalizeUserStatus(user.status, user.lockedUntil) !== 'ACTIVE')
    deny('账户不可用');
  if (
    user.forcePasswordChange ||
    (user.passwordExpiresAt && user.passwordExpiresAt <= new Date())
  )
    deny('请先修改密码');
  const session = await unit.lockSession(principal.userId, principal.sessionId);
  if (
    !session ||
    session.status !== 'ACTIVE' ||
    (session.expiresAt && session.expiresAt <= new Date())
  )
    deny('会话已失效');
}
