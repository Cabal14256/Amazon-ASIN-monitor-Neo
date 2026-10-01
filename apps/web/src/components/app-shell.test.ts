import { describe, expect, it } from 'vitest';
import { createAccess } from '../auth/access';
import { workspaceNavigation } from './app-shell-navigation';

describe('workspace navigation', () => {
  it('shows only granted destinations and keeps unfinished pages noninteractive', () => {
    const access = {
      ...createAccess(),
      isLogin: true,
      canReadASIN: true,
      canReadMonitor: true,
      canReadAudit: true,
      canReadSettings: true,
      canAccessUserManagement: true,
    };
    const items = workspaceNavigation(access).flatMap(
      (section) => section.items,
    );
    expect(items.map((item) => item.path)).toContain('/home');
    expect(items.map((item) => item.path)).toContain('/monitor-history');
    expect(items.find((item) => item.path === '/ops')?.available).toBe(true);
    expect(items.find((item) => item.path === '/settings')?.available).toBe(
      true,
    );
    expect(
      items.find((item) => item.path === '/monitor-history')?.available,
    ).toBe(true);
    expect(items.find((item) => item.path === '/home')?.available).toBe(true);
    expect(items.find((item) => item.path === '/tasks')?.available).toBe(true);
    expect(items.find((item) => item.path === '/asin')?.available).toBe(true);
    expect(
      items.find((item) => item.path === '/competitor-asin')?.available,
    ).toBe(true);
    expect(
      items.find((item) => item.path === '/competitor-monitor-history')
        ?.available,
    ).toBe(true);
    expect(items.find((item) => item.path === '/audit-log')?.available).toBe(
      true,
    );
    expect(
      items.find((item) => item.path === '/user-management')?.available,
    ).toBe(true);
  });
  it('exposes only password management when a password change is required', () => {
    const access = {
      ...createAccess(),
      isLogin: true,
      canReadASIN: true,
      mustChangePassword: true,
    };
    expect(
      workspaceNavigation(access).flatMap((section) =>
        section.items.map((item) => item.path),
      ),
    ).toEqual(['/profile']);
  });
});
