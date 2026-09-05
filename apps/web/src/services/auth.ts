import {
  currentUserResultSchema,
  loginResultSchema,
  messageResultSchema,
  sessionListResultSchema,
  updateProfileResultSchema,
  type ChangePasswordRequest,
  type LoginRequest,
  type UpdateProfileRequest,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient, type RequestOptions } from '../lib/http';
import type { SessionStore } from '../lib/session';

/** Same seven REST contracts for Legacy dual-run and Neo; UI/context comes next. */
export class AuthApi {
  private authenticating = false;
  constructor(
    private readonly http: HttpClient,
    private readonly session: SessionStore,
    private readonly onLogout: () => void,
    private readonly onLogin: () => void = () => {},
  ) {}
  private async transition<T>(action: () => Promise<T>): Promise<T> {
    if (this.authenticating)
      throw new ApiError('CAPACITY', '登录或注销操作正在进行');
    this.authenticating = true;
    try {
      return await action();
    } finally {
      this.authenticating = false;
    }
  }
  async login(
    body: Omit<LoginRequest, 'rememberMe'> & { rememberMe?: boolean },
    signal?: AbortSignal,
  ) {
    return this.transition(async () => {
      const revision = this.session.revision;
      const result = await this.http.request(
        '/api/v1/auth/login',
        { method: 'POST', json: body, signal, authFailure: 'ignore' },
        loginResultSchema,
      );
      if (result.success && result.data && revision === this.session.revision) {
        this.session.markAuthenticated(body.rememberMe ?? false);
        this.onLogin();
      }
      return result;
    });
  }
  currentUser(options: Pick<RequestOptions, 'signal' | 'timeoutMs'> = {}) {
    return this.http.request(
      '/api/v1/auth/current-user',
      { timeoutMs: 5000, ...options },
      currentUserResultSchema,
    );
  }
  async logout(signal?: AbortSignal) {
    return this.transition(async () => {
      const revision = this.session.revision;
      try {
        return await this.http.request(
          '/api/v1/auth/logout',
          { method: 'POST', signal },
          messageResultSchema,
        );
      } finally {
        if (revision === this.session.revision) this.onLogout();
      }
    });
  }
  sessions(signal?: AbortSignal) {
    return this.http.request(
      '/api/v1/auth/sessions',
      { signal },
      sessionListResultSchema,
    );
  }
  revokeSession(sessionId: string, signal?: AbortSignal) {
    return this.http.request(
      '/api/v1/auth/sessions/revoke',
      { method: 'POST', json: { sessionId }, signal },
      messageResultSchema,
    );
  }
  changePassword(body: ChangePasswordRequest, signal?: AbortSignal) {
    return this.http.request(
      '/api/v1/auth/change-password',
      { method: 'POST', json: body, signal },
      messageResultSchema,
    );
  }
  updateProfile(body: UpdateProfileRequest, signal?: AbortSignal) {
    return this.http.request(
      '/api/v1/auth/profile',
      { method: 'PUT', json: body, signal },
      updateProfileResultSchema,
    );
  }
}
