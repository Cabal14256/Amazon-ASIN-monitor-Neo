import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { BackupSubmissionFilter } from './backup-submission.exception';
import { BackupService } from './backup.service';

@Controller('backup')
@UseGuards(AuthenticationGuard, PermissionsGuard)
@RequirePermissions('settings:write')
@UseFilters(BackupSubmissionFilter)
export class BackupController {
  constructor(@Inject(BackupService) private readonly backups: BackupService) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async create(@Req() request: FastifyRequest, @Body() body: unknown) {
    return {
      success: true,
      errorCode: 0,
      data: await this.backups.create(request.auth!, body),
    };
  }

  @Post('restore')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async restore(@Req() request: FastifyRequest, @Body() body: unknown) {
    return {
      success: true,
      errorCode: 0,
      data: await this.backups.restore(request.auth!, body),
    };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() request: FastifyRequest) {
    return {
      success: true,
      errorCode: 0,
      data: await this.backups.list(request.auth!),
    };
  }

  @Delete(':filename')
  @Header('Cache-Control', 'no-store')
  async remove(
    @Req() request: FastifyRequest,
    @Param('filename') filename: string,
  ) {
    return {
      success: true,
      errorCode: 0,
      data: await this.backups.remove(request.auth!, filename),
    };
  }

  @Get(':filename/download')
  async download(
    @Req() request: FastifyRequest,
    @Param('filename') filename: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.backups.download(request.auth!, filename);
    const abort = () => result.stream.destroy();
    request.raw?.once('aborted', abort);
    reply.raw?.once('close', abort);
    result.stream.once('close', () => {
      request.raw?.removeListener('aborted', abort);
      reply.raw?.removeListener('close', abort);
    });
    try {
      if (request.raw?.aborted || reply.raw?.destroyed) abort();
      reply.header('Cache-Control', 'no-store');
      reply.header('Content-Type', 'application/x-tar');
      reply.header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(
          result.filename.replace(/\.dump$/, '.tar'),
        )}"`,
      );
      return new StreamableFile(result.stream);
    } catch (error) {
      if (!result.stream.closed)
        await new Promise<void>((resolve) => {
          result.stream.once('close', resolve);
          result.stream.destroy();
        });
      throw error;
    }
  }

  @Get('scheduled-tasks')
  @Header('Cache-Control', 'no-store')
  async scheduledTasks(@Req() request: FastifyRequest) {
    return {
      success: true,
      errorCode: 0,
      data: await this.backups.scheduledTasks(request.auth!),
    };
  }

  @Get('config')
  @Header('Cache-Control', 'no-store')
  async getConfig(@Req() request: FastifyRequest) {
    return {
      success: true,
      errorCode: 0,
      data: await this.backups.getConfig(request.auth!),
    };
  }

  @Get('capabilities')
  @Header('Cache-Control', 'no-store')
  async capabilities(@Req() request: FastifyRequest) {
    return {
      success: true,
      errorCode: 0,
      data: await this.backups.capabilities(request.auth!),
    };
  }

  @Post('config')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async saveConfig(@Req() request: FastifyRequest, @Body() body: unknown) {
    return {
      success: true,
      errorCode: 0,
      data: await this.backups.saveConfig(request.auth!, body),
    };
  }
}
