import { VariantCheckRuntime } from '@asin-monitor/variant-check';
import type { OnModuleDestroy } from '@nestjs/common';
export class ApplicationVariantCheckRuntime
  extends VariantCheckRuntime
  implements OnModuleDestroy
{
  onModuleDestroy() {
    this.close();
  }
}
