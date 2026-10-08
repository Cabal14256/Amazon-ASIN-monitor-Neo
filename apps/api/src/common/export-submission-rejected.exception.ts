import {
  createExportTaskRequestSchema,
  type CreateExportTaskRequest,
} from '@asin-monitor/contracts';
import { HttpException } from '@nestjs/common';

/** Only a validated public identity and fixed message cross the 5xx boundary. */
export class ExportSubmissionRejectedException extends HttpException {
  constructor(
    taskId: string,
    exportType: CreateExportTaskRequest['exportType'],
  ) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        taskId,
      )
    )
      throw new Error('EXPORT_REJECTION_IDENTITY_INVALID');
    createExportTaskRequestSchema.shape.exportType.parse(exportType);
    super(
      {
        success: false,
        errorCode: 503,
        errorMessage: '导出未入队，请在任务中心核对状态后重试',
        data: { taskId, exportType, status: 'rejected' },
      },
      503,
    );
  }
}
