import { PgFeishuNotificationConfigReader } from '@asin-monitor/db';
import { ensureActive, NotificationError } from './errors';
import { notificationCountry, notificationDomain } from './input';
import type { NotificationConfigSource } from './ports';
import type { NotificationDomain } from './types';

type Pool = ConstructorParameters<typeof PgFeishuNotificationConfigReader>[0];
export interface PgNotificationSourceOptions {
  primaryPool: Pool;
  competitorPool: Pool;
  authority: () => 'postgresql' | 'legacy-mysql';
}
/** D6 readers remain isolated; each attempt observes current enabled state and
 * credentials. The caller's API/Worker owns and closes the underlying pools. */
export class PgNotificationConfigSource implements NotificationConfigSource {
  private readonly readers: Record<
    NotificationDomain,
    PgFeishuNotificationConfigReader
  >;
  constructor(private readonly options: PgNotificationSourceOptions) {
    if (options.primaryPool === options.competitorPool)
      throw new NotificationError('invalid-config');
    this.readers = {
      primary: new PgFeishuNotificationConfigReader(
        options.primaryPool,
        'primary',
      ),
      competitor: new PgFeishuNotificationConfigReader(
        options.competitorPool,
        'competitor',
      ),
    };
  }
  async read(domain: NotificationDomain, region: string, signal: AbortSignal) {
    notificationDomain(domain);
    notificationCountry(region);
    ensureActive(signal);
    if (this.options.authority() !== 'postgresql')
      throw new NotificationError('dependency');
    const result = await this.readers[domain].read(region, signal);
    ensureActive(signal);
    if (this.options.authority() !== 'postgresql')
      throw new NotificationError('dependency');
    return result;
  }
  close() {
    this.readers.primary.close();
    this.readers.competitor.close();
  }
}
