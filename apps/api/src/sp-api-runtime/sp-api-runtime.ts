import { SpApiRuntime } from '@asin-monitor/sp-api';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
export type { SpApiRuntimeOptions } from '@asin-monitor/sp-api';

/** Nest owns the lifecycle; the complete runtime is also usable by BullMQ. */
export class ApplicationSpApiRuntime
  extends SpApiRuntime
  implements OnModuleInit, OnModuleDestroy
{
  onModuleInit(): Promise<void> {
    return this.initialize();
  }
  onModuleDestroy(): void {
    this.close();
  }
}
