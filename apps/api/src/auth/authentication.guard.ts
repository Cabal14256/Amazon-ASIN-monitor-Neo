import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AuthenticationService } from './authentication.service';

@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    @Inject(AuthenticationService)
    private readonly authentication: AuthenticationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    request.auth = await this.authentication.authenticate(
      request,
      http.getResponse<FastifyReply>(),
    );
    return true;
  }
}
