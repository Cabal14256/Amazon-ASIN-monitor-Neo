import type { Env } from '@asin-monitor/config';
import {
  HttpException,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { ENV } from '../config/config.module';

@Injectable()
export class FeishuConfigGuard implements CanActivate {
  constructor(
    @Inject(AuthenticationGuard)
    private readonly authentication: AuthenticationGuard,
    @Inject(ENV) private readonly env: Env,
  ) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    context
      .switchToHttp()
      .getResponse<FastifyReply>()
      .header('Cache-Control', 'no-store');
    const authenticated = await this.authentication.canActivate(context);
    if (
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      request.headers.origin &&
      request.headers.origin !== this.env.CORS_ORIGIN
    )
      throw new HttpException(
        { success: false, errorCode: 403, errorMessage: '不允许的请求来源' },
        403,
      );
    return authenticated;
  }
}
