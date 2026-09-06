import type { Env } from '@asin-monitor/config';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ENV } from '../config/config.module';
import { AuthenticationGuard } from './authentication.guard';
import { SessionService } from './session.service';

@Controller('auth')
@UseGuards(AuthenticationGuard)
export class SessionController {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ENV) private readonly env: Env,
  ) {}
  private checkOrigin(request: FastifyRequest): void {
    if (
      request.headers.origin &&
      request.headers.origin !== this.env.CORS_ORIGIN
    ) {
      throw new HttpException(
        { success: false, errorCode: 403, errorMessage: '不允许的请求来源' },
        403,
      );
    }
  }
  @Get('sessions')
  async list(@Req() request: FastifyRequest) {
    return {
      success: true,
      errorCode: 0,
      data: await this.sessions.list(request.auth!.userId),
    };
  }
  @Post('sessions/revoke')
  @HttpCode(200)
  async revoke(@Body() body: unknown, @Req() request: FastifyRequest) {
    this.checkOrigin(request);
    await this.sessions.revoke(request.auth!.userId, body);
    return { success: true, errorCode: 0, message: '已踢出会话' };
  }
  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.checkOrigin(request);
    await this.sessions.logout(request.auth!.userId, request.auth!.sessionId);
    const options = {
      path: '/',
      sameSite: 'lax' as const,
      secure:
        this.env.NODE_ENV === 'production' || request.protocol === 'https',
    };
    reply.clearCookie(this.env.AUTH_COOKIE_NAME, {
      ...options,
      httpOnly: true,
    });
    reply.clearCookie(this.env.AUTH_HINT_COOKIE_NAME, {
      ...options,
      httpOnly: false,
    });
    return { success: true, errorCode: 0, message: '登出成功' };
  }
}
