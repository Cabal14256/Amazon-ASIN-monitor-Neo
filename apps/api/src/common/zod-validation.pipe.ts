import {
  BadRequestException,
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import type { ZodType } from 'zod';

interface SchemaCarrier {
  schema?: ZodType;
}

/**
 * zod 请求校验管道。
 * 用法：DTO 类上声明 `static schema: ZodType`，管道按 metatype 查表校验。
 * P2 起所有端点 DTO 必须从 @asin-monitor/contracts 引 schema，禁止就地新写。
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const schema = (metadata.metatype as (SchemaCarrier & object) | undefined)?.schema;
    if (!schema) {
      return value;
    }
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        success: false,
        errorMessage: '请求参数校验失败',
        errorCode: 400,
        data: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    return result.data;
  }
}
