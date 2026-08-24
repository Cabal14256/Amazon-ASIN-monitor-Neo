import { z } from 'zod';

import { resultSchema } from '../envelope';
import { roleSchema } from './users';

/**
 * roles 域契约（4 端点）。
 * 来源：server/src/controllers/roleController.js 实读（2026-08-24）。
 */

const dateTimeString = z.string();

/** 权限行（permissions 表；id 为 VARCHAR） */
export const permissionSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  resource: z.string(),
  action: z.string(),
  description: z.string().nullable().optional(),
  create_time: dateTimeString.optional(),
});
export type Permission = z.infer<typeof permissionSchema>;

/** 角色 + 权限摘要（GET /roles 列表项与 GET /roles/:roleId data 同构） */
export const roleWithPermissionsSchema = roleSchema.extend({
  permissions: z
    .array(
      z.object({
        id: z.string(),
        code: z.string(),
        name: z.string(),
        resource: z.string(),
        action: z.string(),
      }),
    )
    .optional(),
});
export type RoleWithPermissions = z.infer<typeof roleWithPermissionsSchema>;

// ── 请求 ──

/** PUT /roles/:roleId/permissions */
export const assignPermissionsRequestSchema = z.object({
  permissionIds: z.array(z.string()),
});
export type AssignPermissionsRequest = z.infer<
  typeof assignPermissionsRequestSchema
>;

// ── 响应 data ──

/** GET /roles data */
export const roleListResultSchema = resultSchema(
  z.array(roleWithPermissionsSchema),
);

/** GET /roles/:roleId data */
export const roleDetailResultSchema = resultSchema(roleWithPermissionsSchema);

/** GET /permissions data：全量列表 + 按 resource 分组 */
export const permissionListDataSchema = z.object({
  list: z.array(permissionSchema),
  grouped: z.record(z.string(), z.array(permissionSchema)),
});
export type PermissionListData = z.infer<typeof permissionListDataSchema>;
export const permissionListResultSchema = resultSchema(
  permissionListDataSchema,
);

/** PUT /roles/:roleId/permissions data */
export const assignPermissionsDataSchema = z.object({
  roleId: z.string(),
  permissions: z.array(permissionSchema.partial()).optional(),
});
export const assignPermissionsResultSchema = resultSchema(
  assignPermissionsDataSchema,
);
