import { SetMetadata } from '@nestjs/common';

import type { PermissionCode } from '@asin-monitor/contracts';

export const REQUIRED_PERMISSIONS = 'auth:required-permissions';

export const RequirePermissions = (...permissions: PermissionCode[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);
