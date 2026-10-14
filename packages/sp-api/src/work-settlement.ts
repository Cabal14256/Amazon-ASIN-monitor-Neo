/** Internal ownership of started work, separate from a caller's abort race.
 * Signals carry only a WeakMap association; cancellation never drains this set.
 */
export class WorkSettlement {
  private readonly pending = new Map<Promise<unknown>, Promise<void>>();

  track(work: Promise<unknown>): void {
    if (this.pending.has(work)) return;
    const settled = work.then(
      () => {
        this.pending.delete(work);
      },
      () => {
        this.pending.delete(work);
      },
    );
    this.pending.set(work, settled);
  }

  async drain(): Promise<void> {
    // Settling work can register another real operation. Recheck after each
    // batch, rather than taking one snapshot or racing an aborted signal.
    while (this.pending.size) await Promise.all(this.pending.values());
  }
}

const scopes = new WeakMap<AbortSignal, WorkSettlement>();

export function createWorkSettlement(signal: AbortSignal): WorkSettlement {
  const settlement = new WorkSettlement();
  scopes.set(signal, settlement);
  return settlement;
}

export function inheritWorkSettlement(
  parent: AbortSignal | undefined,
  child: AbortSignal,
): void {
  const settlement = parent && scopes.get(parent);
  if (settlement) scopes.set(child, settlement);
}

export function trackWorkSettlement(
  signal: AbortSignal | undefined,
  work: Promise<unknown>,
): void {
  if (signal) scopes.get(signal)?.track(work);
}
