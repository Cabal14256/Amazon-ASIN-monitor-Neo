export type NotificationFailure =
  | 'cancelled'
  | 'closed'
  | 'timeout'
  | 'capacity'
  | 'invalid-input'
  | 'invalid-config'
  | 'dependency';
export class NotificationError extends Error {
  constructor(readonly reason: NotificationFailure) {
    super(`Notification ${reason}`);
    this.name = 'NotificationError';
  }
}
export function signalError(signal: AbortSignal): NotificationError {
  return signal.reason instanceof NotificationError
    ? signal.reason
    : new NotificationError('cancelled');
}
export function ensureActive(signal: AbortSignal): void {
  if (signal.aborted) throw signalError(signal);
}
/** Always observe late results while returning promptly on cancellation. */
export function abortable<T>(
  task: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signalError(signal));
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    task.then(
      (value) => {
        cleanup();
        if (!signal.aborted) resolve(value);
      },
      (error) => {
        cleanup();
        reject(signal.aborted ? signalError(signal) : error);
      },
    );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export function notificationDelay(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signalError(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
