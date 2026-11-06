export class UnknownTaskLookupTimeoutError extends Error {
  constructor() {
    super('Task status is not confirmed yet');
  }
}

function retryable(error: unknown): boolean {
  const candidate = error as {
    response?: { status?: unknown };
    status?: unknown;
    statusCode?: unknown;
  } | null;
  const status =
    candidate?.response?.status ?? candidate?.status ?? candidate?.statusCode;
  return (
    typeof status !== 'number' ||
    status === 404 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}

/** An uncertain enqueue must keep its task ID while the first status read settles. */
export async function retryUnknownTaskLookup<T>(
  lookup: () => Promise<T>,
  graceMs: number,
  intervalMs: number,
): Promise<T> {
  if (graceMs <= 0) return lookup();
  const deadline = Date.now() + graceMs;
  for (;;) {
    try {
      return await lookup();
    } catch (error) {
      if (!retryable(error)) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new UnknownTaskLookupTimeoutError();
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(intervalMs, remaining)),
      );
    }
  }
}
