import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { auditBody, auditText } from './audit-data';
import { auditAction, type AuditAction } from './audit-mapping';
import type { AuditService } from './audit.service';

const CONTEXT = Symbol('auditContext');
type AuditRequest = FastifyRequest & {
  [CONTEXT]?: {
    action: AuditAction;
    body: Record<string, unknown> | null;
    path: string;
    error: string | null;
  };
};

function capture(request: AuditRequest): void {
  if (request[CONTEXT]) return;
  const path = request.routeOptions.url;
  if (!path) return;
  const body = auditBody(request.body);
  const action = auditAction(
    request.method,
    path,
    request.params as Record<string, unknown>,
    body ?? {},
  );
  if (action) request[CONTEXT] = { action, body, path, error: null };
}

/** 在业务代码改写 body 之前留存脱敏快照；最终状态由 onResponse 采集。 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() === 'http')
      capture(context.switchToHttp().getRequest<AuditRequest>());
    return next.handle();
  }
}

export function registerAuditHooks(
  app: NestFastifyApplication,
  audit: AuditService,
): void {
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook(
    'onSend',
    async (request: AuditRequest, _reply: FastifyReply, payload: unknown) => {
      capture(request); // Guard / validation failures can precede the Nest interceptor.
      const state = request[CONTEXT];
      if (state && typeof payload === 'string' && payload.length <= 65_536) {
        try {
          const data: unknown = JSON.parse(payload);
          if (
            data &&
            typeof data === 'object' &&
            'success' in data &&
            data.success === false
          ) {
            // Error envelopes can echo request secrets. Persist a fixed failure marker.
            state.error = '操作失败';
          }
        } catch {
          /* Binary / streaming responses are not buffered for auditing. */
        }
      }
      return payload;
    },
  );
  fastify.addHook(
    'onResponse',
    async (request: AuditRequest, reply: FastifyReply) => {
      const state = request[CONTEXT];
      if (!state) return;
      delete request[CONTEXT];
      audit.record({
        ...state.action,
        userId: auditText(request.auth?.userId, 50),
        username: auditText(
          request.auth?.user.username ??
            (state.action.action === 'LOGIN' ? state.body?.username : null),
          50,
        ),
        method: request.method,
        path: auditText(state.path, 500),
        ipAddress: auditText(request.ip, 50),
        userAgent: auditText(request.headers['user-agent'], 500),
        requestData: state.body,
        responseStatus: reply.statusCode,
        errorMessage:
          state.error ??
          (reply.statusCode >= 400 ? `HTTP ${reply.statusCode}` : null),
      });
    },
  );
}
