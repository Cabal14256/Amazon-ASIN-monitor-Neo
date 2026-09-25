import { createContext, useContext } from 'react';
import type { AccessPolicy } from '../../auth/access';
import type { UserManagementApi } from '../../services/user-management';

export interface ManagementContextValue {
  api: UserManagementApi;
  access: AccessPolicy;
  currentUserId: string | null;
  accessDenied: boolean;
  reportAccessDenied: () => void;
  afterWrite: (message: string, refreshIdentity?: boolean) => Promise<void>;
}
export const ManagementContext = createContext<ManagementContextValue | null>(
  null,
);
export function useManagement() {
  const value = useContext(ManagementContext);
  if (!value) throw new Error('缺少用户权限管理上下文');
  return value;
}
