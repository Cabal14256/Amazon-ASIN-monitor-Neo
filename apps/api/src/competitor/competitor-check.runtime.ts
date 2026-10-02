import { CompetitorCheckRuntime } from '@asin-monitor/variant-check';
import type { OnModuleDestroy } from '@nestjs/common';

export class ApplicationCompetitorCheckRuntime
  extends CompetitorCheckRuntime
  implements OnModuleDestroy
{
  onModuleDestroy() {
    this.close();
  }
}
