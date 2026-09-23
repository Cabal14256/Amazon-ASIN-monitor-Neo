import type { ReactNode } from 'react';
import { AppShell } from '../../components/app-shell';

/** Account and pending business pages share the authenticated workspace. */
export function AccountLayout({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <AppShell title={title}>
      <div className="mb-7">
        <p className="neo-mono text-xs tracking-[.18em] text-muted-foreground">
          WORKSPACE / ACCOUNT
        </p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight">{title}</h1>
      </div>
      {children}
    </AppShell>
  );
}
