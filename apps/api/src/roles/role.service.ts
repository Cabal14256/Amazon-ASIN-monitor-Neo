import type { Env } from '@asin-monitor/config';
import { assignPermissionsRequestSchema } from '@asin-monitor/contracts';
import type {
  PermissionRecord,
  RoleReadUnit,
  RoleRecord,
  RoleRepositoryPort,
  RoleWriteUnit,
} from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { authorizeAdministration } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import { PermissionCacheService } from '../auth/permission-cache.service';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';

export const ROLE_REPOSITORY = Symbol('ROLE_REPOSITORY');
const SELF_REQUIRED = [
  'user:read',
  'user:write',
  'user:delete',
  'role:read',
  'role:write',
  'audit:read',
];
function fail(status: number, errorMessage: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage },
    status,
  );
}
function validId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    [...value].length <= 50 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
function publicRole(row: RoleRecord) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    create_time: row.createTime?.toISOString() ?? null,
    update_time: row.updateTime?.toISOString() ?? null,
  };
}
function permissionSummary(row: PermissionRecord) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    resource: row.resource,
    action: row.action,
  };
}
function publicPermission(row: PermissionRecord) {
  return {
    ...permissionSummary(row),
    description: row.description,
    create_time: row.createTime?.toISOString() ?? null,
  };
}

@Injectable()
export class RoleService {
  private active = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(ROLE_REPOSITORY) private readonly repository: RoleRepositoryPort,
    @Inject(PermissionCacheService)
    private readonly cache: PermissionCacheService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  private async run<T>(
    operation: 'read' | 'assign',
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有角色管理入口');
    if (this.active >= 8) fail(429, '角色管理请求繁忙，请稍后再试');
    this.active++;
    try {
      return await action();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error('角色管理请求失败', 'RoleService', {
        operation,
        reason: 'role_operation_failed',
      });
      return fail(500, '角色管理请求失败');
    } finally {
      this.active--;
    }
  }
  private read<T>(action: (unit: RoleReadUnit) => Promise<T>) {
    return this.run('read', () => this.repository.read(action));
  }
  allRoles() {
    return this.read(async (unit) => (await unit.listRoles()).map(publicRole));
  }
  listRoles() {
    return this.read(async (unit) => {
      const rows = await unit.listRoles();
      const assigned = await unit.listRolePermissions();
      const byRole = new Map<string, ReturnType<typeof permissionSummary>[]>();
      for (const permission of assigned) {
        const values = byRole.get(permission.roleId) ?? [];
        values.push(permissionSummary(permission));
        byRole.set(permission.roleId, values);
      }
      return rows.map((role) => ({
        ...publicRole(role),
        permissions: byRole.get(role.id) ?? [],
      }));
    });
  }
  roleDetail(roleId: string) {
    if (!validId(roleId)) fail(400, '角色ID格式无效');
    return this.read(async (unit) => {
      const role = await unit.findRole(roleId);
      if (!role) fail(404, '角色不存在');
      return {
        ...publicRole(role),
        permissions: (await unit.listRolePermissions(roleId)).map(
          permissionSummary,
        ),
      };
    });
  }
  listPermissions() {
    return this.read(async (unit) => {
      const rows = await unit.listPermissions();
      const grouped: Record<
        string,
        Omit<ReturnType<typeof publicPermission>, 'create_time'>[]
      > = Object.create(null);
      for (const row of rows) {
        const key = row.resource || 'other';
        (grouped[key] ??= []).push({
          ...permissionSummary(row),
          description: row.description,
        });
      }
      return { list: rows.map(publicPermission), grouped };
    });
  }
  private async verifyOperator(unit: RoleWriteUnit, principal: AuthPrincipal) {
    await authorizeAdministration(unit, principal, 'role:write');
  }
  async assignPermissions(
    principal: AuthPrincipal,
    roleId: string,
    body: unknown,
  ) {
    const parsed = assignPermissionsRequestSchema.safeParse(body);
    if (
      !validId(roleId) ||
      !parsed.success ||
      parsed.data.permissionIds.length > 1000 ||
      parsed.data.permissionIds.some((id) => id !== '' && !validId(id))
    )
      fail(400, '角色权限参数无效');
    const ids = [...new Set(parsed.data.permissionIds.filter(Boolean))];
    return this.run('assign', async () => {
      const result = await this.repository.transaction(async (unit) => {
        await this.verifyOperator(unit, principal);
        const role = await unit.findRole(roleId);
        if (!role) fail(404, '角色不存在');
        const allPermissions = await unit.listPermissions();
        const byId = new Map(
          allPermissions.map((permission) => [permission.id, permission]),
        );
        if (ids.some((id) => !byId.has(id))) fail(400, '包含无效权限ID');
        const userIds = await unit.usersWithRole(roleId);
        if (userIds.includes(principal.userId)) {
          const codes = new Set(ids.map((id) => byId.get(id)!.code));
          const missing = SELF_REQUIRED.filter((code) => !codes.has(code));
          if (missing.length)
            fail(400, `当前角色必须保留权限: ${missing.join(', ')}`);
        }
        await unit.replacePermissions(roleId, ids);
        return {
          permissions: (await unit.listRolePermissions(roleId)).map(
            permissionSummary,
          ),
          affectedUsers: userIds.length,
        };
      });
      // Generation-based invalidation also prevents a pre-commit read from
      // repopulating the namespace used by subsequent requests.
      await this.cache.clearPostgresCaches();
      this.logger.info('角色权限更新成功', 'RoleService', {
        permissionCount: ids.length,
        affectedUsers: result.affectedUsers,
      });
      return { roleId, permissions: result.permissions };
    });
  }
}
