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

import { PermissionCacheService } from '../auth/permission-cache.service';
import { AppLogger } from '../logger/app-logger.service';
import {
  RATE_LIMIT_WINDOW_MS,
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

@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RateLimitService) private readonly rateLimiter: RateLimitService,
    @Inject(PermissionCacheService)
    private readonly permissionCache: PermissionCacheService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  private async getRole(request: FastifyRequest) {
    if (!request.auth) return 'DEFAULT' as const;
    try {
      return selectRateLimitRole(
        await this.permissionCache.getRoles(request.auth.userId),
      );
    } catch {
      this.logger.warn(
        'HTTP 限流角色读取失败，使用默认配额',
        'RateLimitInterceptor',
        { reason: 'role_lookup_failed' },
      );
      return 'DEFAULT' as const;
    }
  }

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const path = requestPath(request);
    if (
      !this.rateLimiter.enabled ||
      request.method === 'OPTIONS' ||
      EXCLUDED_PATHS.has(path) ||
      !(path === '/api/v1' || path.startsWith('/api/v1/')) ||
      this.rateLimiter.isWhitelisted(request.ip)
    ) {
      return next.handle();
    }

    const policy =
      this.reflector.getAllAndOverride<RateLimitPolicy>(RATE_LIMIT_POLICY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'role';
    const role = await this.getRole(request);
    const decision = await this.rateLimiter.consume({
      clientIdentifier: request.ip,
      policy,
      role,
    });
    const resetSeconds = Math.max(1, Math.ceil(decision.resetAfterMs / 1_000));
    reply.header('RateLimit-Limit', decision.limit);
    reply.header('RateLimit-Remaining', decision.remaining);
    reply.header('RateLimit-Reset', resetSeconds);
    reply.header(
      'RateLimit-Policy',
      `${decision.limit};w=${RATE_LIMIT_WINDOW_MS / 1_000}`,
    );
    if (!decision.allowed) {
      reply.header('Retry-After', resetSeconds);
      this.logger.warn('HTTP 限流触发', 'RateLimitInterceptor', {
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
