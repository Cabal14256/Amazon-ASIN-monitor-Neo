import type { IdentityStore } from '../../auth/identity';
import type { createTransportRuntime } from '../../services/runtime';
import {
  removeUnprotectedAsinBatchReceipt,
  type AsinBatchReceipt,
} from '../asin/asin-batch-receipt';
import { catalogSafetyKey } from './catalog-safety-gate';

/** A RouteGate verification screen can outlive the catalog component. Keep the
 * receipt until the server confirms whether its displaying session changed. */
export function retireBatchReceiptAfterIdentityChange(
  identity: Pick<IdentityStore, 'getSnapshot' | 'subscribe'>,
  runtime: Pick<ReturnType<typeof createTransportRuntime>, 'subscribeSession'>,
  receipt: AsinBatchReceipt,
  displayedOwner: string,
  removed: () => void,
) {
  if (!navigator.locks) return;
  const originalUser = JSON.parse(receipt.owner)[1] as string;
  const source = JSON.parse(displayedOwner)[0] as string;
  let finished = false;
  let queued = false;
  let unsubscribeIdentity = () => {};
  let unsubscribeRuntime = () => {};
  const finish = () => {
    finished = true;
    unsubscribeIdentity();
    unsubscribeRuntime();
  };
  const changed = (): boolean | undefined => {
    const latest = identity.getSnapshot();
    if (latest.status === 'loading' || latest.status === 'error') return;
    return (
      latest.status === 'anonymous' ||
      JSON.stringify([
        source,
        latest.identity.user.id,
        latest.identity.sessionId ?? null,
      ]) !== displayedOwner
    );
  };
  const examine = () => {
    if (finished || queued) return;
    const different = changed();
    if (different === undefined) return;
    if (!different) {
      finish();
      return;
    }
    queued = true;
    void navigator.locks
      .request(catalogSafetyKey(originalUser, 'asin'), async () => {
        queued = false;
        if (finished) return;
        const stillDifferent = changed();
        // Verification may have restarted while this old user's lock was busy.
        // Continue the subscription; terminal identity, not elapsed time, decides.
        if (stillDifferent === undefined) return;
        if (
          stillDifferent &&
          removeUnprotectedAsinBatchReceipt(originalUser, receipt)
        )
          removed();
        finish();
      })
      .catch(finish);
  };
  unsubscribeIdentity = identity.subscribe(examine);
  unsubscribeRuntime = runtime.subscribeSession((event) => {
    if (event === 'dispose') finish();
  });
  examine();
}
