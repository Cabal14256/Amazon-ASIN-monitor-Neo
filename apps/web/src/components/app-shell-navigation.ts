import {
  BarChart3,
  Boxes,
  ClipboardList,
  History,
  LayoutDashboard,
  Radar,
  ScrollText,
  Settings2,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import type { AccessPolicy } from '../auth/access';
import type { PagePath } from '../auth/pages';

interface NavItem {
  path: PagePath;
  label: string;
  access: keyof AccessPolicy;
  icon: LucideIcon;
  available: boolean;
}
const SECTIONS: { label: string; items: NavItem[] }[] = [
  {
    label: '工作区',
    items: [
      {
        path: '/home',
        label: '监控总览',
        access: 'isLogin',
        icon: LayoutDashboard,
        available: true,
      },
      {
        path: '/tasks',
        label: '任务中心',
        access: 'isLogin',
        icon: ClipboardList,
        available: false,
      },
    ],
  },
  {
    label: '业务',
    items: [
      {
        path: '/asin',
        label: 'ASIN 管理',
        access: 'canReadASIN',
        icon: Boxes,
        available: true,
      },
      {
        path: '/asin-parent-query',
        label: '父变体查询',
        access: 'canReadASIN',
        icon: Radar,
        available: false,
      },
      {
        path: '/competitor-asin',
        label: '竞品 ASIN',
        access: 'canReadASIN',
        icon: Boxes,
        available: false,
      },
      {
        path: '/monitor-history',
        label: '监控历史',
        access: 'canReadMonitor',
        icon: History,
        available: false,
      },
      {
        path: '/competitor-monitor-history',
        label: '竞品历史',
        access: 'canReadMonitor',
        icon: History,
        available: false,
      },
      {
        path: '/analytics',
        label: '数据分析',
        access: 'canReadAnalytics',
        icon: BarChart3,
        available: false,
      },
    ],
  },
  {
    label: '管理',
    items: [
      {
        path: '/settings',
        label: '系统设置',
        access: 'canReadSettings',
        icon: Settings2,
        available: false,
      },
      {
        path: '/ops',
        label: '运维观测',
        access: 'canReadSettings',
        icon: Radar,
        available: false,
      },
      {
        path: '/user-management',
        label: '用户与权限',
        access: 'canAccessUserManagement',
        icon: ShieldCheck,
        available: false,
      },
      {
        path: '/audit-log',
        label: '操作审计',
        access: 'canReadAudit',
        icon: ScrollText,
        available: false,
      },
      {
        path: '/profile',
        label: '个人中心',
        access: 'isLogin',
        icon: UserRound,
        available: true,
      },
    ],
  },
];

/** Navigation follows the verified identity and the password-change gate. */
export function workspaceNavigation(access: AccessPolicy) {
  return SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) =>
        access[item.access] &&
        (!access.mustChangePassword || item.path === '/profile'),
    ),
  })).filter((section) => section.items.length > 0);
}
