import {
  Check,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Clock3,
  Inbox,
  LoaderCircle,
} from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils';

const statuses = {
  success: {
    text: '正常',
    icon: CircleCheck,
    color: 'bg-status-success-soft text-status-success',
  },
  danger: {
    text: '异常',
    icon: CircleAlert,
    color: 'bg-status-danger-soft text-status-danger',
  },
  warning: {
    text: '预警',
    icon: CircleAlert,
    color: 'bg-status-warning-soft text-status-warning',
  },
  running: {
    text: '进行中',
    icon: LoaderCircle,
    color: 'bg-status-info-soft text-status-info',
  },
  pending: {
    text: '等待中',
    icon: Clock3,
    color: 'bg-muted text-muted-foreground',
  },
  unknown: {
    text: '未知',
    icon: CircleHelp,
    color: 'bg-muted text-muted-foreground',
  },
} as const;

export function StatusBadge({
  status,
  children,
  className,
}: {
  status: keyof typeof statuses;
  children?: ReactNode;
  className?: string;
}) {
  const { icon: Icon, color, text } = statuses[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-xs font-medium',
        color,
        className,
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn('size-3.5', status === 'running' && 'neo-spin')}
      />
      {children ?? text}
    </span>
  );
}

export function FilterChip({
  selected = false,
  children,
  className,
  ...props
}: Omit<ComponentProps<'button'>, 'aria-pressed'> & { selected?: boolean }) {
  return (
    <button
      {...props}
      type="button"
      aria-pressed={selected}
      className={cn(
        'inline-flex min-h-9 items-center gap-2 rounded-pill border px-3 py-1.5 text-xs transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50',
        selected
          ? 'border-ink bg-ink text-white'
          : 'border-border bg-card text-muted-foreground hover:border-input hover:text-foreground',
        className,
      )}
    >
      {selected && (
        <span
          aria-hidden="true"
          className="neo-signal-dot size-1.5 rounded-full bg-signal"
        />
      )}
      {children}
    </button>
  );
}

/** Invalid or absent values remain indeterminate; never imply zero completed work. */
export function Progress({
  value,
  label,
  className,
}: {
  value?: number | null;
  label: string;
  className?: string;
}) {
  const progress =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.min(100, Math.max(0, value))
      : undefined;
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between gap-4 text-xs">
        <span>{label}</span>
        <span className="neo-mono text-muted-foreground">
          {progress === undefined ? '等待进度' : `${Math.round(progress)}%`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        className="h-3.5 overflow-hidden rounded-pill bg-muted"
      >
        <div
          className={cn(
            'h-full rounded-pill bg-progress transition-[width] duration-300',
            progress === undefined && 'neo-indeterminate',
          )}
          style={{ width: progress === undefined ? '34%' : `${progress}%` }}
        />
      </div>
    </div>
  );
}

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      {...props}
      aria-hidden="true"
      className={cn('neo-skeleton rounded-chip bg-muted', className)}
    />
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-card border border-dashed border-input px-6 py-10 text-center">
      <span
        aria-hidden="true"
        className="mb-4 flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        {icon ?? <Inbox className="size-5" />}
      </span>
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function SuccessNotice({
  children,
  icon,
}: {
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-control bg-status-success-soft px-4 py-3 text-sm text-status-success"
    >
      <span aria-hidden="true" className="shrink-0">
        {icon ?? <Check className="size-4" />}
      </span>
      {children}
    </div>
  );
}
