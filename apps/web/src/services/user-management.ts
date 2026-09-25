import {
  adminResetPasswordRequestSchema,
  allRolesResultSchema,
  assignPermissionsRequestSchema,
  assignPermissionsResultSchema,
  batchDeleteResultSchema,
  batchDeleteUsersRequestSchema,
  createUserRequestSchema,
  createUserResultSchema,
  messageResultSchema,
  permissionListResultSchema,
  roleDetailResultSchema,
  roleListResultSchema,
  updateUserRequestSchema,
  updateUserResultSchema,
  userDetailResultSchema,
  userListQuerySchema,
  userListResultSchema,
  type AdminResetPasswordRequest,
  type AssignPermissionsRequest,
  type BatchDeleteUsersRequest,
  type CreateUserRequest,
  type UpdateUserRequest,
  type UserListQuery,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';

const USERS = '/api/v1/users';
const ROLES = '/api/v1/roles';

function identifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,50}$/.test(value))
    throw new ApiError('INVALID_INPUT', `${label}格式无效`);
  return value;
}

function checked<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  value: unknown,
  message: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError('INVALID_INPUT', message);
  return parsed.data;
}

function requireData<T>(
  response: { success?: boolean; data?: T },
  message: string,
): T {
  if (response.success !== true || response.data === undefined)
    throw new ApiError('INVALID_RESPONSE', message);
  return response.data;
}

function requireSuccess(
  response: { success?: boolean },
  message: string,
): void {
  if (response.success !== true)
    throw new ApiError('INVALID_RESPONSE', message);
}

export class UserManagementApi {
  constructor(private readonly http: Pick<HttpClient, 'request'>) {}

  async users(query: UserListQuery, signal?: AbortSignal) {
    const input = checked(userListQuerySchema, query, '用户筛选或分页参数无效');
    if ((input.pageSize ?? 10) > 100)
      throw new ApiError('INVALID_INPUT', '每页最多 100 条用户');
    const response = await this.http.request(
      USERS,
      { query: input, signal },
      userListResultSchema,
    );
    const data = requireData(response, '用户列表响应缺少数据');
    if (
      !Number.isSafeInteger(data.total) ||
      data.total < 0 ||
      data.list.length > (input.pageSize ?? 10) ||
      (data.current !== undefined && data.current !== (input.current ?? 1)) ||
      (data.pageSize !== undefined && data.pageSize !== (input.pageSize ?? 10))
    )
      throw new ApiError('INVALID_RESPONSE', '用户列表响应分页不一致');
    return data;
  }

  async user(userId: string, signal?: AbortSignal) {
    const response = await this.http.request(
      `${USERS}/${identifier(userId, '用户 ID')}`,
      { signal },
      userDetailResultSchema,
    );
    const data = requireData(response, '用户详情响应缺少数据');
    if (data.id !== userId)
      throw new ApiError('INVALID_RESPONSE', '用户详情标识不匹配');
    return data;
  }

  async roles(signal?: AbortSignal) {
    const response = await this.http.request(
      ROLES,
      { signal },
      roleListResultSchema,
    );
    return requireData(response, '角色列表响应缺少数据');
  }

  async allRoles(signal?: AbortSignal) {
    const response = await this.http.request(
      `${USERS}/roles/all`,
      { signal },
      allRolesResultSchema,
    );
    return requireData(response, '可选角色响应缺少数据');
  }

  async role(roleId: string, signal?: AbortSignal) {
    const response = await this.http.request(
      `${ROLES}/${identifier(roleId, '角色 ID')}`,
      { signal },
      roleDetailResultSchema,
    );
    const data = requireData(response, '角色详情响应缺少数据');
    if (data.id !== roleId)
      throw new ApiError('INVALID_RESPONSE', '角色详情标识不匹配');
    return data;
  }

  async permissions(signal?: AbortSignal) {
    const response = await this.http.request(
      '/api/v1/permissions',
      { signal },
      permissionListResultSchema,
    );
    return requireData(response, '权限清单响应缺少数据');
  }

  async createUser(input: CreateUserRequest, signal?: AbortSignal) {
    const body = checked(createUserRequestSchema, input, '新建用户表单无效');
    const response = await this.http.request(
      USERS,
      { method: 'POST', json: body, signal },
      createUserResultSchema,
    );
    return requireData(response, '创建用户响应缺少数据');
  }

  async updateUser(
    userId: string,
    input: UpdateUserRequest,
    signal?: AbortSignal,
  ) {
    const body = checked(updateUserRequestSchema, input, '编辑用户表单无效');
    const response = await this.http.request(
      `${USERS}/${identifier(userId, '用户 ID')}`,
      { method: 'PUT', json: body, signal },
      updateUserResultSchema,
    );
    return requireData(response, '更新用户响应缺少数据');
  }

  async deleteUser(userId: string, signal?: AbortSignal) {
    const response = await this.http.request(
      `${USERS}/${identifier(userId, '用户 ID')}`,
      { method: 'DELETE', signal },
      messageResultSchema,
    );
    requireSuccess(response, '删除用户响应无效');
  }

  async batchDelete(input: BatchDeleteUsersRequest, signal?: AbortSignal) {
    const body = checked(
      batchDeleteUsersRequestSchema,
      input,
      '批量删除用户参数无效',
    );
    const response = await this.http.request(
      `${USERS}/batch-delete`,
      { method: 'POST', json: body, signal },
      batchDeleteResultSchema,
    );
    const data = requireData(response, '批量删除用户响应缺少数据');
    if (data.totalRequested !== body.userIds.length)
      throw new ApiError('INVALID_RESPONSE', '批量删除用户数量不一致');
    return data;
  }

  async resetPassword(
    userId: string,
    input: AdminResetPasswordRequest,
    signal?: AbortSignal,
  ) {
    const body = checked(
      adminResetPasswordRequestSchema,
      input,
      '重置密码表单无效',
    );
    const response = await this.http.request(
      `${USERS}/${identifier(userId, '用户 ID')}/password`,
      { method: 'PUT', json: body, signal },
      messageResultSchema,
    );
    requireSuccess(response, '重置密码响应无效');
  }

  async assignPermissions(
    roleId: string,
    input: AssignPermissionsRequest,
    signal?: AbortSignal,
  ) {
    const body = checked(
      assignPermissionsRequestSchema,
      input,
      '角色权限表单无效',
    );
    const response = await this.http.request(
      `${ROLES}/${identifier(roleId, '角色 ID')}/permissions`,
      { method: 'PUT', json: body, signal },
      assignPermissionsResultSchema,
    );
    const data = requireData(response, '角色权限响应缺少数据');
    if (data.roleId !== roleId)
      throw new ApiError('INVALID_RESPONSE', '角色权限响应标识不匹配');
    return data;
  }
}
