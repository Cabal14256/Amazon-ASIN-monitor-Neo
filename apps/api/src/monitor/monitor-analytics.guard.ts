import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { MonitorAnalyticsService } from './monitor-analytics.service';

@Injectable()
export class MonitorAnalyticsGuard implements CanActivate {
  constructor(
    @Inject(AuthenticationGuard)
    private readonly authentication: AuthenticationGuard,
    @Inject(MonitorAnalyticsService)
    private readonly service: MonitorAnalyticsService,
  ) {}
  canActivate(context: ExecutionContext): Promise<boolean> {
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    reply.header('Cache-Control', 'no-store');
    return this.service.admit(reply, () =>
      this.authentication.canActivate(context),
    );
  }
}
