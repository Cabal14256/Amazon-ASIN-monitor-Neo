import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function Card({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      {...props}
      className={cn(
        'min-w-0 rounded-card border border-border bg-card text-card-foreground',
        className,
      )}
    />
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border p-5 sm:p-6">
      <div>
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {description && (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div {...props} className={cn('p-5 sm:p-6', className)} />;
}

export function ModuleLabel({
  module,
  children,
}: {
  module: 'asin' | 'monitor' | 'analytics' | 'tasks' | 'competitor';
  children: ReactNode;
}) {
  const color = {
    asin: 'bg-module-asin',
    monitor: 'bg-module-monitor',
    analytics: 'bg-module-analytics',
    tasks: 'bg-module-tasks',
    competitor: 'bg-module-competitor',
  }[module];
  return (
    <span className="inline-flex items-center gap-2.5 text-xs font-semibold">
      <span aria-hidden="true" className={cn('h-3 w-1 rounded-pill', color)} />
      {children}
    </span>
  );
}
