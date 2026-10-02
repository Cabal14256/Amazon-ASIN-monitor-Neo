import { useQuery, type QueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import type { HttpClient } from '../lib/http';
import { shouldRetryQuery } from '../lib/http';
import { getSystemAlert } from '../services/system-alert';

export const SYSTEM_ALERT_QUERY_KEY = ['system', 'alert'] as const;

const tones = {
  info: {
    Icon: Info,
    classes: 'border-status-info/20 bg-status-info-soft text-status-info',
  },
  success: {
    Icon: CircleCheck,
    classes:
      'border-status-success/20 bg-status-success-soft text-status-success',
  },
  warning: {
    Icon: TriangleAlert,
    classes:
      'border-status-warning/20 bg-status-warning-soft text-status-warning',
  },
  error: {
    Icon: CircleAlert,
    classes: 'border-status-danger/20 bg-status-danger-soft text-status-danger',
  },
} as const;

export function SystemAnnouncement({
  runtime,
}: {
  runtime: { http: HttpClient; queryClient: QueryClient };
}) {
  const notice = useQuery(
    {
      queryKey: SYSTEM_ALERT_QUERY_KEY,
      queryFn: ({ signal }) => getSystemAlert(runtime.http, signal),
      staleTime: 60_000,
      refetchOnMount: 'always',
      refetchOnWindowFocus: true,
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
      retry: shouldRetryQuery,
    },
    runtime.queryClient,
  );
  // Do not present an old deployment warning as current after a failed refresh.
  if (notice.isError || !notice.data?.message.trim()) return null;
  const type = notice.data.type;
  const tone =
    type === 'success' || type === 'warning' || type === 'error'
      ? tones[type]
      : tones.info;
  const { Icon } = tone;
  return (
    <div
      role={type === 'warning' || type === 'error' ? 'alert' : 'status'}
      aria-label="系统公告"
      className={
        'mb-6 flex min-w-0 items-start gap-3 rounded-control border px-4 py-3 text-sm leading-6 ' +
        tone.classes
      }
    >
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <p className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
        {notice.data.message}
      </p>
    </div>
  );
}
