import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';

import { AuthenticationService } from '../auth/authentication.service';
import { PermissionCacheService } from '../auth/permission-cache.service';
import { AppLogger } from '../logger/app-logger.service';
import {
  RATE_LIMIT_WINDOW_MS,
  type RateLimitDecision,
  type RateLimitPolicy,
  RateLimitService,
  selectRateLimitRole,
} from './rate-limit.service';

export const RATE_LIMIT_POLICY = Symbol('RATE_LIMIT_POLICY');

export const StrictRateLimit = () =>
  SetMetadata(RATE_LIMIT_POLICY, 'strict' satisfies RateLimitPolicy);

const EXCLUDED_PATHS = new Set(['/health', '/api/v1/health', '/metrics']);

function requestPath(request: FastifyRequest): string {
  return request.url.split('?', 1)[0] ?? request.url;
}

function shouldBypass(
  request: FastifyRequest,
  rateLimiter: RateLimitService,
): boolean {
  const path = requestPath(request);
  return (
    !rateLimiter.enabled ||
    request.method === 'OPTIONS' ||
    EXCLUDED_PATHS.has(path) ||
    !(path === '/api/v1' || path.startsWith('/api/v1/')) ||
    rateLimiter.isWhitelisted(request.ip)
  );
}

async function resolveRole(
  userId: string | undefined,
  permissionCache: PermissionCacheService,
  logger: AppLogger,
  context: string,
) {
  if (!userId) return 'DEFAULT' as const;
  try {
    return selectRateLimitRole(await permissionCache.getRoles(userId));
  } catch {
    logger.warn('HTTP 限流角色读取失败，使用默认配额', context, {
      reason: 'role_lookup_failed',
    });
    return 'DEFAULT' as const;
  }
}

function applyHeaders(
  reply: FastifyReply,
  decision: RateLimitDecision,
): number {
  const resetSeconds = Math.max(1, Math.ceil(decision.resetAfterMs / 1_000));
  reply.header('RateLimit-Limit', decision.limit);
  reply.header('RateLimit-Remaining', decision.remaining);
  reply.header('RateLimit-Reset', resetSeconds);
  reply.header(
    'RateLimit-Policy',
    `${decision.limit};w=${RATE_LIMIT_WINDOW_MS / 1_000}`,
  );
  return resetSeconds;
}

function sendBlocked(
  reply: FastifyReply,
  decision: RateLimitDecision,
  logger: AppLogger,
  context: string,
): void {
  reply.header('Retry-After', applyHeaders(reply, decision));
  logger.warn('HTTP 限流触发', context, {
    backend: decision.backend,
    policy: decision.policy,
    role: decision.role,
  });
  reply.status(HttpStatus.TOO_MANY_REQUESTS).send({
    success: false,
    errorMessage: '请求过于频繁，请稍后再试',
    errorCode: 429,
  });
}

/** Fastify onRequest 调用点：先于 Nest Guards，覆盖认证失败和未匹配 API。 */
@Injectable()
export class RateLimitRequestHook {
  constructor(
    @Inject(AuthenticationService)
    private readonly authentication: AuthenticationService,
    @Inject(RateLimitService) private readonly rateLimiter: RateLimitService,
    @Inject(PermissionCacheService)
    private readonly permissionCache: PermissionCacheService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async handle(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    if (shouldBypass(request, this.rateLimiter)) return false;
    const role = await resolveRole(
      this.authentication.identifyUserId(request),
      this.permissionCache,
      this.logger,
      'RateLimitRequestHook',
    );
    const decision = await this.rateLimiter.consume({
      clientIdentifier: request.ip,
      policy: 'role',
      role,
    });
    if (!decision.allowed) {
      sendBlocked(reply, decision, this.logger, 'RateLimitRequestHook');
      return true;
    }
    applyHeaders(reply, decision);
    return false;
  }
}

@Injectable()
export class StrictRateLimitInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RateLimitService) private readonly rateLimiter: RateLimitService,
    @Inject(PermissionCacheService)
    private readonly permissionCache: PermissionCacheService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const policy =
      this.reflector.getAllAndOverride<RateLimitPolicy>(RATE_LIMIT_POLICY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'role';
    if (policy !== 'strict' || shouldBypass(request, this.rateLimiter)) {
      return next.handle();
    }
    const role = await resolveRole(
      request.auth?.userId,
      this.permissionCache,
      this.logger,
      'StrictRateLimitInterceptor',
    );
    const decision = await this.rateLimiter.consume({
      clientIdentifier: request.ip,
      policy,
      role,
    });
    applyHeaders(reply, decision);
    if (!decision.allowed) {
      reply.header(
        'Retry-After',
        Math.max(1, Math.ceil(decision.resetAfterMs / 1_000)),
      );
      this.logger.warn('HTTP 限流触发', 'StrictRateLimitInterceptor', {
        backend: decision.backend,
        policy: decision.policy,
        role: decision.role,
      });
      throw new HttpException(
        {
          success: false,
          errorMessage: '请求过于频繁，请稍后再试',
          errorCode: 429,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return next.handle();
  }
}
