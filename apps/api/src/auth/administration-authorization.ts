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

/** Called after the shared administration lock, inside the write transaction. */
export async function authorizeAdministration(
  unit: RoleWriteUnit,
  principal: AuthPrincipal,
  permission: PermissionCode,
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
  if (
    !(await unit.operatorPermissionCodes(principal.userId)).includes(permission)
  )
    deny('没有权限执行此操作');
}
