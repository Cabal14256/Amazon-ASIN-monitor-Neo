import { logger } from './logger';

export function taskNotificationWarning(): () => void {
  let lastWarning = -Infinity;
  return () => {
    if (Date.now() - lastWarning < 60_000) return;
    lastWarning = Date.now();
    logger.warn('任务已保存，实时通知发布失败', {
      reason: 'task_notification_publish_failed',
    });
  };
}
