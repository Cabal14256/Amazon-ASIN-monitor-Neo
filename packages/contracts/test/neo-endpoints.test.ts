import { describe, expect, it } from 'vitest';
import { ENDPOINTS } from '../src/endpoints';
import * as contracts from '../src/index';

describe('Neo additive endpoint inventory', () => {
  it('preserves the frozen 118 baseline and inventories the authenticated scheduled backup read', () => {
    expect(ENDPOINTS).toHaveLength(118);
    const inventory = contracts as unknown as {
      NEO_ENDPOINT_ADDITIONS: unknown[];
      NEO_ENDPOINTS: { method: string; path: string }[];
      neoEndpointsOf(domain: string): unknown[];
    };
    expect(inventory.NEO_ENDPOINT_ADDITIONS).toEqual([
      {
        method: 'GET',
        path: '/backup/scheduled-tasks',
        domain: 'backup',
        auth: true,
        permission: 'settings:write',
        controller: 'BackupController.scheduledTasks',
      },
    ]);
    expect(inventory.NEO_ENDPOINTS).toHaveLength(119);
    expect(
      new Set(inventory.NEO_ENDPOINTS.map((e) => `${e.method} ${e.path}`)).size,
    ).toBe(119);
    expect(inventory.neoEndpointsOf('backup')).toHaveLength(8);
    expect(ENDPOINTS.some((e) => e.path === '/backup/scheduled-tasks')).toBe(
      false,
    );
  });
});
