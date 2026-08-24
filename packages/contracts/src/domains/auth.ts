import { z } from 'zod';

import { resultSchema } from '../envelope';

/**
 * auth 域契约（7 端点）。
 * 来源：server/src/controllers/authController.js、models/User.js、models/Session.js、
 * utils/userStatus.js 实读（2026-08-24）。
 */

// ── 实体 ──

/** 用户状态（对齐 utils/userStatus.js USER_STATUS；DB 0/1 会被归一化） */
export const userStatusSchema = z.enum([
  'ACTIVE',
  'INACTIVE',
  'LOCKED',
  'SUSPENDED',
  'PENDING',
]);
export type UserStatus = z.infer<typeof userStatusSchema>;

/** MySQL DATETIME 经 mysql2 → JSON 序列化为字符串 */
const dateTimeString = z.string();

/** User.USER_PUBLIC_COLUMNS（不含 password），formatUser 归一化后形态 */
export const userPublicSchema = z.object({
  id: z.number(),
  username: z.string(),
  real_name: z.string().nullable().optional(),
  status: userStatusSchema,
  last_login_time: dateTimeString.nullable().optional(),
  last_login_ip: z.string().nullable().optional(),
  password_expires_at: dateTimeString.nullable().optional(),
  password_changed_at: dateTimeString.nullable().optional(),
  force_password_change: z.boolean(),
  failed_login_attempts: z.number().optional(),
  locked_until: dateTimeString.nullable().optional(),
  create_time: dateTimeString.optional(),
  update_time: dateTimeString.optional(),
});
export type UserPublic = z.infer<typeof userPublicSchema>;

/** sessions 表行（remember_me 为 MySQL TINYINT 0/1） */
export const sessionSchema = z.object({
  id: z.string(),
  user_id: z.number(),
  user_agent: z.string().nullable().optional(),
  ip_address: z.string().nullable().optional(),
  expires_at: dateTimeString.nullable().optional(),
  remember_me: z.union([z.literal(0), z.literal(1), z.boolean()]).optional(),
  status: z.string().optional(), // 'ACTIVE' | 'REVOKED'
  created_at: dateTimeString.optional(),
  last_active_at: dateTimeString.nullable().optional(),
});
export type SessionRecord = z.infer<typeof sessionSchema>;

// ── 请求 ──

export const loginRequestSchema = z.object({
  username: z.string().min(1, '用户名不能为空'),
  password: z.string().min(1, '密码不能为空'),
  rememberMe: z.boolean().optional().default(false),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const revokeSessionRequestSchema = z.object({
  sessionId: z.string().min(1, '缺少 sessionId'),
});
export type RevokeSessionRequest = z.infer<typeof revokeSessionRequestSchema>;

export const changePasswordRequestSchema = z.object({
  oldPassword: z.string().min(1, '原密码不能为空'),
  newPassword: z.string().min(1, '新密码不能为空'),
  revokeOtherSessions: z.boolean().optional().default(true),
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

/** 控制器要求至少一个字段（当前仅 real_name） */
export const updateProfileRequestSchema = z
  .object({
    real_name: z.string().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: '没有要更新的字段',
  });
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

// ── 响应 data ──

/** 登录成功 data（getAuthResponseData + token） */
export const loginDataSchema = z.object({
  token: z.string(),
  sessionId: z.string(),
  user: userPublicSchema,
  permissions: z.array(z.string()),
  roles: z.array(z.string()),
  mustChangePassword: z.boolean(),
  passwordExpired: z.boolean(),
});
export type LoginData = z.infer<typeof loginDataSchema>;
export const loginResultSchema = resultSchema(loginDataSchema);

/** 当前用户 data（无 token，sessionId 来自请求上下文） */
export const currentUserDataSchema = z.object({
  user: userPublicSchema,
  permissions: z.array(z.string()),
  roles: z.array(z.string()),
  sessionId: z.string().optional(),
  mustChangePassword: z.boolean(),
  passwordExpired: z.boolean(),
});
export type CurrentUserData = z.infer<typeof currentUserDataSchema>;
export const currentUserResultSchema = resultSchema(currentUserDataSchema);

export const sessionListResultSchema = resultSchema(z.array(sessionSchema));

/** 更新资料 data */
export const updateProfileDataSchema = z.object({
  user: userPublicSchema,
  permissions: z.array(z.string()),
  roles: z.array(z.string()),
});
export const updateProfileResultSchema = resultSchema(updateProfileDataSchema);

/**
 * 纯消息响应（logout / sessions/revoke / change-password）：
 * 走 { success, message, errorCode } 变体（无 data）。
 */
export const messageResultSchema = z.object({
  success: z.boolean().optional(),
  message: z.string().optional(),
  errorMessage: z.string().optional(),
  errorCode: z.number().optional(),
});
export type MessageResult = z.infer<typeof messageResultSchema>;

/** 登录错误码全集（登录失败锁定语义）：400 / 401 / 403 / 423 / 500 */
export const LOGIN_ERROR_CODES = [400, 401, 403, 423, 500] as const;
