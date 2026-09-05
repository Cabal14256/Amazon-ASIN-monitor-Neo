import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import { Readable } from 'node:stream';
import { auditBody, auditText } from './audit-data';
import { auditAction, type AuditAction } from './audit-mapping';
import type { AuditService } from './audit.service';

const CONTEXT = Symbol('auditContext');
type AuditRequest = FastifyRequest & {
  [CONTEXT]?: {
    action: AuditAction;
    body: Record<string, unknown> | null;
    path: string;
    ipAddress: string | null;
    error: string | null;
    recorded?: boolean;
    report?: (status?: number, error?: string) => void;
    stream?: Readable;
    streamError?: () => void;
    handlerStarted?: boolean;
    handlerSettled?: boolean;
    responseFinished?: boolean;
    disconnected?: boolean;
    transportError?: boolean;
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
  if (action)
    request[CONTEXT] = {
      action,
      body,
      path,
      ipAddress: auditText(request.ip, 50),
      error: null,
    };
}

function reportTransportFailure(
  request: AuditRequest,
  reply: FastifyReply,
): void {
  const state = request[CONTEXT];
  if (!state?.handlerSettled) return;
  if (state.responseFinished) state.report?.(reply.statusCode);
  else if (state.transportError) state.report?.(500, '响应处理失败');
  else if (
    state.disconnected ||
    (reply.raw.destroyed && !reply.raw.writableFinished)
  )
    state.report?.(
      state.error ? (reply.statusCode >= 400 ? reply.statusCode : 500) : 499,
      state.error ?? '客户端连接中断',
    );
}

/** Preserve body before mutation; normal responses keep their final HTTP status. */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<AuditRequest>();
    capture(request);
    return next.handle();
  }
}

export function registerAuditHooks(
  app: NestFastifyApplication,
  audit: AuditService,
): void {
  const fastify = app.getHttpAdapter().getInstance();
  function watchResponse(request: AuditRequest, reply: FastifyReply): void {
    capture(request);
    const state = request[CONTEXT];
    if (!state || state.recorded || state.report) return;
    const onClose = () => {
      if (!reply.raw.writableFinished) {
        state.disconnected = true;
        reportTransportFailure(request, reply);
      }
    };
    const onError = () => {
      state.transportError = true;
      reportTransportFailure(request, reply);
    };
    state.report = (status = reply.statusCode, error) => {
      if (state.recorded) return;
      state.recorded = true;
      reply.raw.removeListener('close', onClose);
      reply.raw.removeListener('error', onError);
      if (state.stream && state.streamError)
        state.stream.removeListener('error', state.streamError);
      delete state.report;
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
        ipAddress: state.ipAddress,
        userAgent: auditText(request.headers['user-agent'], 500),
        requestData: state.body,
        responseStatus: status,
        errorMessage:
          error ?? state.error ?? (status >= 400 ? `HTTP ${status}` : null),
      });
    };
    reply.raw.once('close', onClose);
    reply.raw.once('error', onError);
    if (reply.raw.destroyed) onClose();
  }
  // Nest interceptors run after guards, so their completion cannot cover an
  // authentication rejection. Wrap the route lifecycle, including every guard
  // and the exception filter, and defer a disconnect until that work settles.
  fastify.addHook('onRoute', (route: RouteOptions) => {
    const handler = route.handler;
    route.handler = async function (request, reply) {
      watchResponse(request, reply);
      const state = (request as AuditRequest)[CONTEXT];
      if (state) state.handlerStarted = true;
      try {
        return await handler.call(this, request, reply);
      } finally {
        if (state) state.handlerSettled = true;
        reportTransportFailure(request, reply);
      }
    };
  });
  fastify.addHook(
    'preValidation',
    async (request: AuditRequest, reply: FastifyReply) =>
      watchResponse(request, reply),
  );
  fastify.addHook(
    'onError',
    async (request: AuditRequest, reply: FastifyReply) => {
      watchResponse(request, reply);
      const state = request[CONTEXT];
      if (state) state.error = '响应处理失败';
    },
  );
  fastify.addHook(
    'onSend',
    async (request: AuditRequest, reply: FastifyReply, payload: unknown) => {
      watchResponse(request, reply); // Includes parse/Guard failures before interceptor.
      const state = request[CONTEXT];
      if (
        state &&
        !state.recorded &&
        !state.stream &&
        payload instanceof Readable
      ) {
        state.stream = payload;
        state.streamError = () => {
          state.error = '响应流中断';
        };
        payload.once('error', state.streamError);
      }
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
      // Parser failures have no handler to wait for. A started handler can
      // still be doing work after an explicit reply.send(), so await its exit.
      if (state && !state.handlerStarted) state.handlerSettled = true;
      reportTransportFailure(request, reply);
      return payload;
    },
  );
  fastify.addHook(
    'onResponse',
    async (request: AuditRequest, reply: FastifyReply) => {
      const state = request[CONTEXT];
      if (state) state.responseFinished = true;
      reportTransportFailure(request, reply);
    },
  );
}
