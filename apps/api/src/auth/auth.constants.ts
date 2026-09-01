import type {
  AuthDataRepository,
  AuthSessionRepository,
} from '@asin-monitor/db';

export const AUTH_DATA_REPOSITORY = Symbol('AUTH_DATA_REPOSITORY');
export type AuthRepositoryPort = AuthDataRepository;

export const AUTH_SESSION_REPOSITORY = Symbol('AUTH_SESSION_REPOSITORY');
export type AuthSessionRepositoryPort = AuthSessionRepository;
