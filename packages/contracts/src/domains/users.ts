import { z } from 'zod';

import { resultSchema } from '../envelope';
import { userPublicSchema, userStatusSchema } from './auth';

/**
 * users 域契约（8 端点）。
 * 来源：server/src/controllers/userController.js 实读（2026-08-24）。
 * 注意：用户管理写操作一律走 message 变体或特定 data 形态，见各端点。
 */

const dateTimeString = z.string();

/** 角色行（roles 表；id 为 VARCHAR） */
export const roleSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  create_time: dateTimeString.optional(),
  update_time: dateTimeString.optional(),
});
export type Role = z.infer<typeof roleSchema>;

/** 用户列表项：公开字段 + 角色摘要数组 */
export const userRoleSummarySchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
});

export const userListItemSchema = userPublicSchema.extend({
  roles: z.array(userRoleSummarySchema).optional(),
});
export type UserListItem = z.infer<typeof userListItemSchema>;

// ── 请求 ──

/** GET /users query */
export const userListQuerySchema = z.object({
  username: z.string().optional(),
  status: userStatusSchema.optional(),
  current: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});
export type UserListQuery = z.infer<typeof userListQuerySchema>;

/** POST /users */
export const createUserRequestSchema = z.object({
  username: z.string().min(1, '用户名不能为空'),
  password: z.string().min(1, '密码不能为空'),
  real_name: z.string().optional(),
  roleIds: z.array(z.string()).nonempty('至少分配一个角色'),
  forcePasswordChange: z.boolean().optional().default(true),
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

/** POST /users/batch-delete */
export const batchDeleteUsersRequestSchema = z.object({
  userIds: z.array(z.string().min(1)).nonempty('userIds 不能为空'),
});
export type BatchDeleteUsersRequest = z.infer<
  typeof batchDeleteUsersRequestSchema
>;

/** PUT /users/:userId */
export const updateUserRequestSchema = z.object({
  real_name: z.string().optional(),
  status: userStatusSchema.optional(),
  roleIds: z.array(z.string()).optional(),
  statusReason: z.string().optional(),
});
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

/** PUT /users/:userId/password（管理员重置） */
export const adminResetPasswordRequestSchema = z.object({
  newPassword: z.string().min(1, '新密码不能为空'),
  forceChangeOnNextLogin: z.boolean().optional().default(true),
  revokeAllSessions: z.boolean().optional().default(true),
});
export type AdminResetPasswordRequest = z.infer<
  typeof adminResetPasswordRequestSchema
>;

// ── 响应 data ──

/** GET /users data（非 PageInfo：无 current/pageSize 回显则按实读，含则保留宽松） */
export const userListDataSchema = z.object({
  list: z.array(userListItemSchema),
  total: z.number(),
  current: z.number().optional(),
  pageSize: z.number().optional(),
});
export type UserListData = z.infer<typeof userListDataSchema>;
export const userListResultSchema = resultSchema(userListDataSchema);

/** GET /users/roles/all data */
export const allRolesResultSchema = resultSchema(z.array(roleSchema));

/** GET /users/:userId data：用户 + 角色 + 权限码 + 状态历史 */
export const userDetailDataSchema = userPublicSchema.extend({
  roles: z.array(roleSchema).optional(),
  permissions: z.array(z.string()).optional(),
  statusHistory: z
    .array(
      z.object({
        id: z.number().optional(),
        user_id: z.string().optional(),
        old_status: z.string().nullable().optional(),
        new_status: z.string().optional(),
        reason: z.string().nullable().optional(),
        changed_by: z.string().nullable().optional(),
        operator_id: z.string().nullable().optional(),
        operator_name: z.string().nullable().optional(),
        created_at: dateTimeString.optional(),
        create_time: dateTimeString.optional(),
      }),
    )
    .optional(),
});
export type UserDetailData = z.infer<typeof userDetailDataSchema>;
export const userDetailResultSchema = resultSchema(userDetailDataSchema);

/** POST /users/batch-delete data */
export const batchDeleteDataSchema = z.object({
  totalRequested: z.number(),
  deletedCount: z.number(),
  skipped: z.array(z.object({ userId: z.string(), reason: z.string() })),
  failed: z.array(z.object({ userId: z.string(), message: z.string() })),
});
export type BatchDeleteData = z.infer<typeof batchDeleteDataSchema>;
export const batchDeleteResultSchema = resultSchema(batchDeleteDataSchema);

/** POST /users 与 PUT /users/:userId 返回用户公开字段与角色摘要。 */
export const userMutationDataSchema = userPublicSchema.extend({
  roles: z.array(userRoleSummarySchema),
});
export type UserMutationData = z.infer<typeof userMutationDataSchema>;
export const createUserResultSchema = resultSchema(userMutationDataSchema);
export const updateUserResultSchema = resultSchema(userMutationDataSchema);

/**
 * DELETE /users/:userId 与 PUT /users/:userId/password：
 * message 变体（无 data 或仅提示）。
 * 复用 auth.ts 的 messageResultSchema。
 */
