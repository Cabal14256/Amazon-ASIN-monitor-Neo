import {
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { UserQueryService } from './user-query.service';

@Controller('users')
@UseGuards(AuthenticationGuard, PermissionsGuard)
@RequirePermissions('user:read')
export class UserQueryController {
  constructor(
    @Inject(UserQueryService) private readonly users: UserQueryService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Query() query: Record<string, unknown>) {
    return { success: true, errorCode: 0, data: await this.users.list(query) };
  }
  @Get(':userId')
  @Header('Cache-Control', 'no-store')
  async detail(@Param('userId') userId: string) {
    return {
      success: true,
      errorCode: 0,
      data: await this.users.detail(userId),
    };
  }
}
