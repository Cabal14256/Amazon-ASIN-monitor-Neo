import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

export class BackupSubmissionException extends HttpException {
  constructor(readonly taskId: string) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        taskId,
      )
    )
      throw new Error('BACKUP_SUBMISSION_ID_INVALID');
    super(
      {
        success: false,
        errorCode: 500,
        errorMessage: '任务提交结果未确认，请查询此任务状态后再操作',
        data: { taskId, status: 'unknown' },
      },
      500,
    );
  }
}

/** Only this fixed submission outcome bypasses the global 5xx payload mask. */
@Catch(BackupSubmissionException)
export class BackupSubmissionFilter implements ExceptionFilter {
  catch(error: BackupSubmissionException, host: ArgumentsHost) {
    host
      .switchToHttp()
      .getResponse<FastifyReply>()
      .header('Cache-Control', 'no-store')
      .status(500)
      .send(error.getResponse());
  }
}
