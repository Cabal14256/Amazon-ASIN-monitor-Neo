declare namespace API {
  type BackupInfo = {
    filename?: string;
    filepath?: string;
    size?: number;
    createdAt?: string;
    modifiedAt?: string;
    description?: string;
    restoreSupported?: boolean;
    restoreMode?: 'isolated' | 'in-place';
  };

  type BackupScheduledTask = {
    taskId: string;
    title: string;
    status: string;
    message: string;
    createdAt: string;
    completedAt?: string | null;
  };

  type BackupConfig = {
    id?: number;
    enabled?: boolean;
    scheduleType?: 'daily' | 'weekly' | 'monthly';
    scheduleValue?: number;
    backupTime?: string;
    createTime?: string;
    updateTime?: string;
  };

  interface Result_BackupInfo__ {
    success?: boolean;
    errorMessage?: string;
    data?: BackupInfo;
  }

  interface Result_BackupInfo___ {
    success?: boolean;
    errorMessage?: string;
    data?: BackupInfo[];
  }

  interface Result_BackupConfig__ {
    success?: boolean;
    errorMessage?: string;
    data?: BackupConfig;
  }

  interface Result_any__ {
    success?: boolean;
    errorMessage?: string;
    data?: any;
  }
}
