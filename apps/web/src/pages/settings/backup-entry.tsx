import { useEffect, useState } from 'react';
import { createAccess } from '../../auth/access';
import { useAuth, useIdentity } from '../../auth/context';
import { Button } from '../../components/ui/button';
import { BackupApi } from '../../services/backup';
import { BackupPanel } from './backup-panel';

/** Verify the configured service before exposing any backup mutation. */
export function BackupEntry() {
  const { runtime } = useAuth();
  const identity = useIdentity();
  const authenticated =
    identity.status === 'authenticated' ? identity.identity : undefined;
  const access = createAccess(authenticated);
  const allowed = Boolean(
    authenticated && access.canWriteSettings && !access.mustChangePassword,
  );
  const scope = JSON.stringify([
    identity.status,
    authenticated?.user.id,
    authenticated?.sessionId,
    runtime.session.revision,
    allowed,
  ]);
  const [attempt, setAttempt] = useState(0);
  const [availability, setAvailability] = useState<{
    scope: string;
    ready: boolean;
  }>();
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    let active = true;
    setAvailability(undefined);
    void new BackupApi(runtime.http).capabilities(controller.signal).then(
      () => {
        if (active) setAvailability({ scope, ready: true });
      },
      () => {
        if (active) setAvailability({ scope, ready: false });
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [allowed, runtime.http, scope, attempt]);
  if (availability?.scope === scope && availability.ready)
    return <BackupPanel />;
  return (
    <section
      role="tabpanel"
      aria-label="备份与恢复"
      className="rounded-card border border-border p-6"
    >
      <h2 className="text-lg font-semibold">备份与恢复</h2>
      <p role="status" className="mt-3 text-sm text-muted-foreground">
        {!allowed
          ? '当前账号没有备份操作权限。'
          : availability?.scope === scope
          ? '当前服务尚未支持此备份功能，请继续使用现有备份入口。'
          : '正在确认备份服务是否可用…'}
      </p>
      {allowed && availability?.scope === scope && (
        <Button
          className="mt-4"
          variant="secondary"
          onClick={() => setAttempt((value) => value + 1)}
        >
          重新确认备份服务
        </Button>
      )}
    </section>
  );
}
