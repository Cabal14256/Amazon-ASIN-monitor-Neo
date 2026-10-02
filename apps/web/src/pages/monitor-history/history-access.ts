import { ApiError } from '../../lib/http';

interface HistoryReadAccessSnapshot {
  denial: ApiError | null;
  recovering: boolean;
  recoveryFailed: boolean;
}

/** One refusal covers list, intervals and detail, including their cached data. */
export function createHistoryReadAccess() {
  let snapshot: HistoryReadAccessSnapshot = {
    denial: null,
    recovering: false,
    recoveryFailed: false,
  };
  let denialRevision = 0;
  const listeners = new Set<() => void>();
  const publish = (next: HistoryReadAccessSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async read<T>(load: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      try {
        return await load();
      } catch (error) {
        if (
          !signal?.aborted &&
          error instanceof ApiError &&
          (error.kind === 'AUTH' ||
            [401, 403].includes(error.status ?? 0) ||
            [401, 403].includes(error.errorCode ?? 0))
        ) {
          denialRevision++;
          publish({ ...snapshot, denial: error });
        }
        throw error;
      }
    },
    async recover(readers: (() => Promise<unknown>)[]): Promise<boolean> {
      if (snapshot.recovering || !readers.length) return false;
      const startedRevision = denialRevision;
      publish({ ...snapshot, recovering: true, recoveryFailed: false });
      const results = await Promise.allSettled(
        readers.map((reader) => Promise.resolve().then(reader)),
      );
      const recovered =
        startedRevision === denialRevision &&
        results.every((result) => result.status === 'fulfilled');
      publish({
        denial: recovered ? null : snapshot.denial,
        recovering: false,
        recoveryFailed: !recovered,
      });
      return recovered;
    },
  };
}

export type HistoryReadAccess = ReturnType<typeof createHistoryReadAccess>;
