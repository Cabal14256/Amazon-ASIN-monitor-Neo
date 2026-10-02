import { HttpException } from '@nestjs/common';

const failures = {
  'status-intervals-disabled': {
    status: 503,
    message: '状态区间读取已关闭，请联系管理员启用后再试',
  },
  'monitor-history-timeout': {
    status: 504,
    message: '查询超时，请尝试缩小时间范围或稍后重试',
  },
} as const;

/** Only fixed application messages may cross the generic 5xx masking boundary. */
export class RecoverableQueryException extends HttpException {
  constructor(readonly reason: keyof typeof failures) {
    const { status, message } = failures[reason];
    super({ success: false, errorCode: status, errorMessage: message }, status);
  }
}
