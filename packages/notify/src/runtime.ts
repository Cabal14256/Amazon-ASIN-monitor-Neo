import {
  PgNotificationConfigSource,
  type PgNotificationSourceOptions,
} from './pg-config-source';
import type { NotificationLogger } from './ports';
import { FeishuNotifications } from './service';
import { NodeFeishuTransport } from './transport';

/** Shared production construction for API/Worker owners. No connection or
 * notification is made until an explicitly requested send operation. */
export function createFeishuNotifications(
  options: PgNotificationSourceOptions & { logger: NotificationLogger },
): FeishuNotifications {
  return new FeishuNotifications({
    source: new PgNotificationConfigSource(options),
    transport: new NodeFeishuTransport(),
    logger: options.logger,
  });
}
