/** Storage events reach peer tabs only; notify other mounted flows in this tab. */
export const CATALOG_GATE_CHANGED = 'neo:catalog-gate-changed';

export function notifyCatalogGateChanged(key: string): void {
  if (typeof window !== 'undefined')
    window.dispatchEvent(
      new CustomEvent<string>(CATALOG_GATE_CHANGED, { detail: key }),
    );
}
