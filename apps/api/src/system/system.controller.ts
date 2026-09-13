import type { Env } from '@asin-monitor/config';
import type { SystemAlert } from '@asin-monitor/contracts';
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ENV } from '../config/config.module';

/** Public Legacy announcement, also available before signing in. */
@Controller('system')
export class SystemController {
  constructor(@Inject(ENV) private readonly env: Env) {}

  @Get('alert')
  getAlert(@Res({ passthrough: true }) reply: FastifyReply): {
    success: true;
    data: SystemAlert;
    errorCode: 0;
  } {
    reply.header('Cache-Control', 'no-store');
    const message = this.env.GLOBAL_ALERT_MESSAGE;
    return {
      success: true,
      data: {
        message,
        type: message ? this.env.GLOBAL_ALERT_TYPE : 'info',
      },
      errorCode: 0,
    };
  }
}
