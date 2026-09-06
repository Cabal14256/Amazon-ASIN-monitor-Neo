import type { Env } from '@asin-monitor/config';
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ENV } from '../config/config.module';
import { LoginService } from './login.service';

@Controller('auth')
export class LoginController {
  constructor(
    @Inject(LoginService) private readonly loginService: LoginService,
    @Inject(ENV) private readonly env: Env,
  ) {}
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (
      request.headers.origin &&
      request.headers.origin !== this.env.CORS_ORIGIN
    ) {
      throw new HttpException(
        { success: false, errorCode: 403, errorMessage: '不允许的请求来源' },
        403,
      );
    }
    const result = await this.loginService.login(body, {
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? 'unknown',
    });
    const cookie = {
      path: '/',
      sameSite: 'lax' as const,
      secure:
        this.env.NODE_ENV === 'production' || request.protocol === 'https',
      maxAge: Math.max(
        1,
        Math.floor((result.expiresAt.getTime() - Date.now()) / 1000),
      ),
      expires: result.expiresAt,
    };
    request.auth = result.principal; // Trusted post-commit actor for global audit hooks.
    reply.setCookie(this.env.AUTH_COOKIE_NAME, result.data.token, {
      ...cookie,
      httpOnly: true,
    });
    reply.setCookie(this.env.AUTH_HINT_COOKIE_NAME, '1', {
      ...cookie,
      httpOnly: false,
    });
    return { success: true, data: result.data, errorCode: 0 };
  }
}
