/** Release the attempt on abort even if a writer never settles its own promise. */
export function abortableExport<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(
        (value) => {
          signal.removeEventListener('abort', abort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
  });
}
