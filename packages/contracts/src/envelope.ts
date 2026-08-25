import { z } from 'zod';

/**
 * 统一 REST 信封，对齐旧系统 src/types/api-compat.d.ts 的 API.Result / API.PageInfo。
 * 旧字段全部可选（部分历史端点缺 success 或混用 message），保持兼容。
 */
export const resultSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    success: z.boolean().optional(),
    errorMessage: z.string().optional(),
    errorCode: z.number().optional(),
    message: z.string().optional(),
    data: dataSchema.optional(),
  });

export interface Result<T = unknown> {
  success?: boolean;
  errorMessage?: string;
  errorCode?: number;
  message?: string;
  data?: T;
}

export const pageInfoSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    list: z.array(itemSchema).optional(),
    total: z.number().optional(),
    current: z.number().optional(),
    pageSize: z.number().optional(),
  });

export interface PageInfo<T = unknown> {
  list?: T[];
  total?: number;
  current?: number;
  pageSize?: number;
}

/** 分页查询通用入参（对齐旧 ProTable 约定） */
export const pageQuerySchema = z.object({
  current: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;
