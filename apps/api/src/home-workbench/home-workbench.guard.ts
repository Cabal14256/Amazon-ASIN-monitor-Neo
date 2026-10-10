import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { HomeWorkbenchService } from './home-workbench.service';

@Injectable()
export class HomeWorkbenchGuard implements CanActivate {
  constructor(
    @Inject(AuthenticationGuard)
    private readonly authentication: AuthenticationGuard,
    @Inject(HomeWorkbenchService)
    private readonly service: HomeWorkbenchService,
  ) {}
  canActivate(context: ExecutionContext) {
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    reply.header('Cache-Control', 'no-store');
    return this.service.admit(reply, () =>
      this.authentication.canActivate(context),
    );
  }
}
