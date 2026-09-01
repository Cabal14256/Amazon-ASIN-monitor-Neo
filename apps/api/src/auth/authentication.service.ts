import {
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import jwt, {
  JsonWebTokenError,
  NotBeforeError,
  TokenExpiredError,
} from 'jsonwebtoken';

import type { Env } from '@asin-monitor/config';
import type { UserStatus } from '@asin-monitor/contracts';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import {
  AUTH_DATA_REPOSITORY,
  type AuthRepositoryPort,
} from './auth.constants';
import type { AuthenticatedUser, AuthPrincipal } from './auth.types';

interface AuthTokenClaims {
  sessionId: string;
  userId: string;
}

function unauthorized(message: string): UnauthorizedException {
  return new UnauthorizedException({
    success: false,
    errorMessage: message,
    errorCode: 401,
  });
}

function forbidden(message: string): ForbiddenException {
  return new ForbiddenException({
    success: false,
    errorMessage: message,
    errorCode: 403,
  });
}

function normalizeUserStatus(
  status: string,
  lockedUntil: Date | null,
  now = new Date(),
): UserStatus {
  if (status === 'LOCKED' || (lockedUntil !== null && lockedUntil > now)) {
    return 'LOCKED';
  }
  const normalized = status.trim().toUpperCase();
  if (
    normalized === 'ACTIVE' ||
    normalized === 'INACTIVE' ||
    normalized === 'LOCKED' ||
    normalized === 'SUSPENDED' ||
    normalized === 'PENDING'
  ) {
    return normalized;
  }
  if (normalized === '1') return 'ACTIVE';
  return 'INACTIVE';
}

function userStatusMessage(status: UserStatus): string {
  switch (status) {
    case 'LOCKED':
      return '账户已锁定';
    case 'SUSPENDED':
      return '用户已被停用';
    case 'PENDING':
      return '账户待激活';
    case 'INACTIVE':
    default:
      return '用户已被禁用';
  }
}

function asClaims(decoded: string | jwt.JwtPayload): AuthTokenClaims {
  if (
    typeof decoded === 'string' ||
    typeof decoded.userId !== 'string' ||
    !decoded.userId ||
    typeof decoded.sessionId !== 'string' ||
    !decoded.sessionId
  ) {
    throw new JsonWebTokenError('missing auth claims');
  }
  return { userId: decoded.userId, sessionId: decoded.sessionId };
}

@Injectable()
export class AuthenticationService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(AUTH_DATA_REPOSITORY)
    private readonly repository: AuthRepositoryPort,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  private readToken(request: FastifyRequest): string | undefined {
    const cookieToken = request.cookies[this.env.AUTH_COOKIE_NAME];
    if (cookieToken) return cookieToken;

    const authorization = request.headers.authorization;
    if (authorization?.startsWith('Bearer ')) {
      const bearer = authorization.slice(7).trim();
      if (bearer) return bearer;
    }
    return undefined;
  }

  private clearCookies(request: FastifyRequest, reply: FastifyReply): void {
    const forwardedProto = String(request.headers['x-forwarded-proto'] ?? '')
      .split(',')[0]
      ?.trim()
      .toLowerCase();
    const options = {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: request.protocol === 'https' || forwardedProto === 'https',
      path: '/',
    };
    reply.clearCookie(this.env.AUTH_COOKIE_NAME, options);
    reply.clearCookie(this.env.AUTH_HINT_COOKIE_NAME, {
      ...options,
      httpOnly: false,
    });
  }

  private verifyToken(token: string): AuthTokenClaims {
    try {
      return asClaims(
        jwt.verify(token, this.env.JWT_SECRET, { algorithms: ['HS256'] }),
      );
    } catch (error) {
      if (error instanceof TokenExpiredError) {
        throw unauthorized('认证令牌已过期');
      }
      if (
        error instanceof JsonWebTokenError ||
        error instanceof NotBeforeError
      ) {
        throw forbidden('无效的认证令牌');
      }
      throw error;
    }
  }

  async authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthPrincipal> {
    const token = this.readToken(request);
    if (!token) throw unauthorized('未提供认证令牌');

    try {
      const claims = this.verifyToken(token);
      const session = await this.repository.findSessionById(claims.sessionId);
      if (!session) {
        throw unauthorized('会话不存在或已过期');
      }
      if (session.userId !== claims.userId || session.status !== 'ACTIVE') {
        throw forbidden('会话已失效');
      }
      if (session.expiresAt !== null && session.expiresAt <= new Date()) {
        await this.repository.revokeSession(session.id);
        throw unauthorized('会话已过期');
      }

      await this.repository.touchSession(session.id);
      const user = await this.repository.findUserById(claims.userId);
      if (!user) {
        throw unauthorized('用户不存在');
      }

      const status = normalizeUserStatus(user.status, user.lockedUntil);
      if (status !== 'ACTIVE') {
        throw forbidden(userStatusMessage(status));
      }
      const normalizedUser: AuthenticatedUser = {
        ...user,
        status,
        forcePasswordChange: user.forcePasswordChange === true,
      };
      return {
        userId: normalizedUser.id,
        sessionId: session.id,
        user: normalizedUser,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        if (
          error instanceof UnauthorizedException ||
          error instanceof ForbiddenException
        ) {
          this.clearCookies(request, reply);
        }
        throw error;
      }
      this.logger.error('鉴权流程异常', 'AuthenticationService', {
        reason: 'auth_dependency_error',
        name: error instanceof Error ? error.name : 'UnknownError',
      });
      throw new ServiceUnavailableException({
        success: false,
        errorMessage: '鉴权服务暂时不可用',
        errorCode: 503,
      });
    }
  }
}
