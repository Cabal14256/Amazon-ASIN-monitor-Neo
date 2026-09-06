import type { Env } from '@asin-monitor/config';
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ENV } from '../config/config.module';
import { AccountService } from './account.service';
import { AuthenticationGuard } from './authentication.guard';

@Controller('auth')
@UseGuards(AuthenticationGuard)
export class AccountController {
  constructor(
    @Inject(AccountService) private readonly accounts: AccountService,
    @Inject(ENV) private readonly env: Env,
  ) {}
  private checkOrigin(request: FastifyRequest) {
    if (
      request.headers.origin &&
      request.headers.origin !== this.env.CORS_ORIGIN
    )
      throw new HttpException(
        { success: false, errorCode: 403, errorMessage: '不允许的请求来源' },
        403,
      );
  }
  @Put('profile')
  async profile(@Body() body: unknown, @Req() request: FastifyRequest) {
    this.checkOrigin(request);
    return {
      success: true,
      errorCode: 0,
      data: await this.accounts.updateProfile(request.auth!, body),
    };
  }
  @Post('change-password')
  @HttpCode(200)
  async changePassword(@Body() body: unknown, @Req() request: FastifyRequest) {
    this.checkOrigin(request);
    return {
      success: true,
      errorCode: 0,
      message: await this.accounts.changePassword(request.auth!, body),
    };
  }
}
