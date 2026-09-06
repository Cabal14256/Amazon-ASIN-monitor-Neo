import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  UseGuards,
  type Type,
} from '@nestjs/common';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  AuditLogIdDto,
  AuditLogQueryDto,
  AuditStatisticsQueryDto,
} from './audit-query.dto';
import { AuditQueryService } from './audit-query.service';

// Explicit metadata also works with TS transpilers that omit decorator type metadata.
function validated<T>(
  value: unknown,
  metatype: Type<T>,
  type: 'query' | 'param',
): T {
  return new ZodValidationPipe().transform(value, { metatype, type }) as T;
}

@Controller('audit-logs')
@UseGuards(AuthenticationGuard, PermissionsGuard)
@RequirePermissions('audit:read')
export class AuditQueryController {
  constructor(
    @Inject(AuditQueryService) private readonly queries: AuditQueryService,
  ) {}

  @Get()
  async list(@Query() query: unknown) {
    return {
      success: true,
      errorCode: 0,
      data: await this.queries.list(
        validated(query, AuditLogQueryDto, 'query'),
      ),
    };
  }
  @Get('statistics/actions')
  async actions(@Query() query: unknown) {
    return {
      success: true,
      errorCode: 0,
      data: await this.queries.actions(
        validated(query, AuditStatisticsQueryDto, 'query'),
      ),
    };
  }
  @Get('statistics/resources')
  async resources(@Query() query: unknown) {
    return {
      success: true,
      errorCode: 0,
      data: await this.queries.resources(
        validated(query, AuditStatisticsQueryDto, 'query'),
      ),
    };
  }
  @Get(':id')
  async detail(@Param() params: unknown) {
    return {
      success: true,
      errorCode: 0,
      data: await this.queries.detail(
        validated(params, AuditLogIdDto, 'param').id,
      ),
    };
  }
}
