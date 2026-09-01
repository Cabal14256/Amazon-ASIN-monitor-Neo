import type { UserStatus } from '@asin-monitor/contracts';
import type { AuthUserRecord } from '@asin-monitor/db';

export interface AuthenticatedUser
  extends Omit<AuthUserRecord, 'forcePasswordChange' | 'status'> {
  forcePasswordChange: boolean;
  status: UserStatus;
}

export interface AuthPrincipal {
  sessionId: string;
  userId: string;
  user: AuthenticatedUser;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthPrincipal;
  }
}
