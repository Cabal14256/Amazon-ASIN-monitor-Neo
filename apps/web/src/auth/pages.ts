import type { AccessPolicy } from './access';

interface PageDefinition {
  path: `/${string}`;
  name: string;
  access: 'public' | keyof AccessPolicy;
}

/** All 15 Legacy component routes. '/' is a redirect, FeishuConfig is not a route. */
export const PAGE_ROUTES = [
  { path: '/login', name: '登录', access: 'public' },
  { path: '/403', name: '无权访问', access: 'public' },
  { path: '/home', name: '首页', access: 'isLogin' },
  { path: '/asin', name: 'ASIN 管理', access: 'canReadASIN' },
  { path: '/asin-parent-query', name: 'ASIN父变体查询', access: 'canReadASIN' },
  { path: '/competitor-asin', name: '竞品ASIN 管理', access: 'canReadASIN' },
  { path: '/monitor-history', name: '监控历史', access: 'canReadMonitor' },
  {
    path: '/competitor-monitor-history',
    name: '竞品监控历史',
    access: 'canReadMonitor',
  },
  { path: '/analytics', name: '数据分析', access: 'canReadAnalytics' },
  { path: '/settings', name: '系统设置', access: 'canReadSettings' },
  { path: '/ops', name: '运维观测', access: 'canReadSettings' },
  {
    path: '/user-management',
    name: '用户与权限',
    access: 'canAccessUserManagement',
  },
  { path: '/audit-log', name: '操作审计', access: 'canReadAudit' },
  { path: '/tasks', name: '任务中心', access: 'isLogin' },
  { path: '/profile', name: '个人中心', access: 'isLogin' },
] as const satisfies ReadonlyArray<PageDefinition>;

export type PageRoute = (typeof PAGE_ROUTES)[number];
export type PagePath = PageRoute['path'];
export const DEFAULT_PAGE: PagePath = '/home';
export const PASSWORD_CHANGE_PAGE = '/profile?tab=password&force=1';

export function findPage(pathname: string): PageRoute | undefined {
  const path = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return PAGE_ROUTES.find((page) => page.path === path);
}
