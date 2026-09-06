import { Link } from '@tanstack/react-router';
import { ShieldAlert } from 'lucide-react';

export default function ForbiddenPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-5 px-6">
      <ShieldAlert className="size-12 text-status-warning" aria-hidden="true" />
      <p className="font-mono text-xs text-muted-foreground">
        403 · ACCESS RESTRICTED
      </p>
      <h1 className="text-4xl font-bold">你暂无访问权限</h1>
      <p className="text-sm leading-7 text-muted-foreground">
        如需使用此功能，请联系管理员调整账号权限。
      </p>
      <Link to="/home" className="font-semibold underline underline-offset-4">
        返回首页
      </Link>
    </main>
  );
}
