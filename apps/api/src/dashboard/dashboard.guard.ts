import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { DashboardService } from './dashboard.service';

@Injectable()
export class DashboardGuard implements CanActivate {
  constructor(
    @Inject(AuthenticationGuard)
    private readonly authentication: AuthenticationGuard,
    @Inject(DashboardService) private readonly service: DashboardService,
  ) {}
  canActivate(context: ExecutionContext) {
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    reply.header('Cache-Control', 'no-store');
    return this.service.admit(reply, () =>
      this.authentication.canActivate(context),
    );
  }
}
