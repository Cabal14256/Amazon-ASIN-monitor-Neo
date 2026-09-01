import type { AuthDataRepository } from '@asin-monitor/db';

export const AUTH_DATA_REPOSITORY = Symbol('AUTH_DATA_REPOSITORY');
export type AuthRepositoryPort = AuthDataRepository;
