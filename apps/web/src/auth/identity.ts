import type { LoginRequest } from '@asin-monitor/contracts';
import { ApiError } from '../lib/http';
import type { createTransportRuntime } from '../services/runtime';
import type { RouteAuthState } from './navigation';

type Runtime = ReturnType<typeof createTransportRuntime>;

/** Server-verified identity, separate from cookie/localStorage hints. */
export class IdentityStore {
  private state: RouteAuthState = { status: 'loading' };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private active?: {
    controller: AbortController;
    promise: Promise<RouteAuthState>;
  };
  private unsubscribe?: () => void;
  private running = false;
  private verifiedKey?: string;

  constructor(private readonly runtime: Runtime) {}

  getSnapshot = (): RouteAuthState => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: RouteAuthState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private cancel() {
    this.generation++;
    this.active?.controller.abort();
    this.active = undefined;
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.unsubscribe = this.runtime.subscribeSession((event) => {
      if (event === 'dispose') {
        this.stop();
        return;
      }
      this.cancel();
      this.verifiedKey = undefined;
      if (event === 'reset') this.publish({ status: 'anonymous' });
      else {
        this.publish({ status: 'loading' });
        void this.refresh();
      }
    });
    void this.refresh();
  }
  stop() {
    this.running = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.cancel();
    this.runtime.pauseRealtime();
    this.publish({ status: 'loading' });
  }

  /** A failed refresh never falls back to cached identity or a local hint. */
  async ensure(): Promise<RouteAuthState> {
    this.start();
    while (this.active) await this.active.promise;
    return this.state;
  }

  refresh(): Promise<RouteAuthState> {
    if (this.active) return this.active.promise;
    if (!this.running) return Promise.resolve(this.state);
    const generation = ++this.generation;
    const revision = this.runtime.session.revision;
    const controller = new AbortController();
    this.runtime.pauseRealtime();
    this.publish({ status: 'loading' });
    const current = () =>
      this.running &&
      generation === this.generation &&
      revision === this.runtime.session.revision;
    const promise = this.runtime.auth
      .currentUser({ signal: controller.signal })
      .then((result) => {
        if (!current()) return this.state;
        if (result.success !== true || !result.data)
          throw new ApiError('INVALID_RESPONSE', '身份响应不完整');
        if (result.data.user.status !== 'ACTIVE') {
          this.runtime.reset();
          return this.state;
        }
        const key = JSON.stringify([
          result.data.user.id,
          result.data.sessionId,
        ]);
        if (this.verifiedKey !== undefined && this.verifiedKey !== key)
          this.runtime.clearUserWork();
        this.verifiedKey = key;
        this.publish({ status: 'authenticated', identity: result.data });
        this.runtime.connectVerifiedSession();
        return this.state;
      })
      .catch((error: unknown) => {
        if (!current()) return this.state;
        if (
          error instanceof ApiError &&
          (error.kind === 'AUTH' ||
            error.status === 403 ||
            error.errorCode === 403)
        )
          this.runtime.reset();
        else this.publish({ status: 'error' });
        return this.state;
      })
      .finally(() => {
        if (this.active?.controller === controller) this.active = undefined;
      });
    this.active = { controller, promise };
    return promise;
  }
  async login(
    input: Omit<LoginRequest, 'rememberMe'> & { rememberMe?: boolean },
  ) {
    await this.runtime.auth.login(input);
    // The login event has already discarded the old identity/cache and started
    // verification. Do not keep the returned Token or trust a readable hint.
    return this.refresh();
  }
  logout() {
    return this.runtime.auth.logout();
  }
}
