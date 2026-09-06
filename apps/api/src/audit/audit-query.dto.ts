import {
  neoAuditLogIdParamsSchema,
  neoAuditLogListQuerySchema,
  neoAuditStatisticsQuerySchema,
  type NeoAuditLogListQuery,
  type NeoAuditStatisticsQuery,
} from '@asin-monitor/contracts';

export class AuditLogQueryDto implements NeoAuditLogListQuery {
  static readonly schema = neoAuditLogListQuerySchema;
  declare current: number;
  declare pageSize: number;
  declare userId?: string;
  declare username?: string;
  declare action?: string;
  declare resource?: string;
  declare resourceId?: string;
  declare startTime?: string;
  declare endTime?: string;
}
export class AuditStatisticsQueryDto implements NeoAuditStatisticsQuery {
  static readonly schema = neoAuditStatisticsQuerySchema;
  declare startTime?: string;
  declare endTime?: string;
}
export class AuditLogIdDto {
  static readonly schema = neoAuditLogIdParamsSchema;
  declare id: number;
}
