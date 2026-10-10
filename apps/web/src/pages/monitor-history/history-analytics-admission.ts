import { ApiError, type HttpClient } from '../../lib/http';

interface WaitingRead {
  signal: AbortSignal;
  start(): void;
  cancel(): void;
}
const gates = new WeakMap<HttpClient, ReturnType<typeof createGate>>();

function createGate(http: HttpClient) {
  let active = 0;
  const waiting: WaitingRead[] = [];
  const client: Pick<HttpClient, 'request'> = {
    request: (path, options, schema) =>
      http.request(path, { ...options, waitForSettlement: true }, schema),
  };
  const drain = () => {
    while (active < 2 && waiting.length) {
      const next = waiting.shift()!;
      next.signal.removeEventListener('abort', next.cancel);
      if (next.signal.aborted) next.cancel();
      else next.start();
    }
  };
  return {
    read<T>(
      signal: AbortSignal,
      load: (client: Pick<HttpClient, 'request'>) => Promise<T>,
    ): Promise<T> {
      return new Promise((resolve, reject) => {
        const cancelled = () => reject(new ApiError('CANCELLED', '请求已取消'));
        const entry: WaitingRead = {
          signal,
          cancel: () => {
            const index = waiting.indexOf(entry);
            if (index !== -1) waiting.splice(index, 1);
            signal.removeEventListener('abort', entry.cancel);
            cancelled();
          },
          start: () => {
            active++;
            Promise.resolve()
              .then(() => {
                if (signal.aborted)
                  throw new ApiError('CANCELLED', '请求已取消');
                return load(client);
              })
              .then(resolve, reject)
              .finally(() => {
                active--;
                drain();
              });
          },
        };
        if (signal.aborted) return cancelled();
        waiting.push(entry);
        signal.addEventListener('abort', entry.cancel, { once: true });
        drain();
      });
    },
  };
}

/** The three history panels share actual-work admission across route/session
 * remounts on the same runtime; cancelled queued reads never reach HTTP. */
export function historyAnalyticsAdmission(http: HttpClient) {
  let gate = gates.get(http);
  if (!gate) {
    gate = createGate(http);
    gates.set(http, gate);
  }
  return gate;
}
