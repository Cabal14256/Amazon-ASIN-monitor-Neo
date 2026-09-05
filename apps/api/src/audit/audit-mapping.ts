import { auditText } from './audit-data';

export interface AuditAction {
  action: string;
  resource: string;
  resourceId: string | null;
  resourceName: string | null;
}

/** 迁移 legacy 路径/方法优先级；只匹配 API 路由模板，不匹配 query 内容。 */
export function auditAction(
  method: string,
  route: string,
  params: Record<string, unknown> = {},
  body: Record<string, unknown> = {},
): AuditAction | undefined {
  if (!route.startsWith('/api/v1/')) return undefined;
  const path = route.slice('/api/v1'.length);
  if (method === 'HEAD' || method === 'OPTIONS') return undefined;
  const entry = (
    action: string,
    resource: string,
    id?: unknown,
    name?: unknown,
  ): AuditAction => ({
    action,
    resource,
    resourceId: auditText(id, 50),
    resourceName: auditText(name, 255),
  });
  if (path.startsWith('/export/') || path === '/tasks/export') {
    if (method !== 'GET' && method !== 'POST') return undefined;
    return entry(
      'EXPORT',
      path.includes('asin')
        ? 'asin'
        : path.includes('monitor')
        ? 'monitor_history'
        : 'unknown',
    );
  }
  if (method === 'GET') return undefined;
  const auth: Record<string, [string, string]> = {
    '/auth/login': ['POST', 'LOGIN'],
    '/auth/logout': ['POST', 'LOGOUT'],
    '/auth/change-password': ['POST', 'CHANGE_PASSWORD'],
    '/auth/profile': ['PUT', 'UPDATE_PROFILE'],
    '/auth/sessions/revoke': ['POST', 'REVOKE_SESSION'],
  };
  if (auth[path]?.[0] === method) return entry(auth[path]![1], 'auth');
  const segment = path.replace(/^\/competitor\//, '/').split('/')[1];
  const resources: Record<string, [string, string, string, string]> = {
    'variant-groups': ['variant_group', 'groupId', 'name', '变体组'],
    asins: ['asin', 'asinId', 'asin', 'ASIN'],
    users: ['user', 'userId', 'username', '用户'],
  };
  const resource = Object.hasOwn(resources, segment ?? '')
    ? resources[segment!]
    : undefined;
  if (resource) {
    const [kind, idParam, nameKey, label] = resource;
    if (method === 'POST' && path.endsWith('/batch-delete') && kind !== 'asin')
      return entry('BATCH_DELETE', kind, null, `批量删除${label}`);
    if (method === 'POST' && path.endsWith('/batch-create') && kind === 'asin')
      return entry('BATCH_CREATE', kind, null, '批量新增ASIN');
    if (method === 'PUT' && kind === 'user' && path.endsWith('/password'))
      return entry('RESET_PASSWORD', kind, params[idParam], body.username);
    if (method === 'POST') return entry('CREATE', kind, body.id, body[nameKey]);
    if (method === 'PUT')
      return entry('UPDATE', kind, params[idParam], body[nameKey]);
    if (method === 'DELETE') {
      const id = auditText(params[idParam], 50);
      return entry(
        'DELETE',
        kind,
        id,
        id ? `${label} ${id.slice(0, 8)}...` : null,
      );
    }
  }
  if (segment === 'roles' && path.endsWith('/permissions') && method === 'PUT')
    return entry('UPDATE_ROLE_PERMISSIONS', 'role', params.roleId);
  if (segment === 'roles' || segment === 'permissions')
    return entry(method, segment === 'roles' ? 'role' : 'permission');
  if ((method === 'POST' || method === 'PUT') && segment === 'feishu-configs')
    return entry(
      'UPDATE',
      'feishu_config',
      null,
      body.country || body.region || '飞书配置',
    );
  if ((method === 'POST' || method === 'PUT') && segment === 'sp-api-configs')
    return entry('UPDATE', 'sp_api_config', null, 'SP-API配置');
  if (method === 'POST' && /^\/(competitor\/)?monitor\/trigger$/.test(path))
    return entry('TRIGGER_MONITOR', 'monitor');
  return undefined;
}
