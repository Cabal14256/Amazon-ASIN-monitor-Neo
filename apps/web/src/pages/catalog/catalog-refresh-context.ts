import { createContext } from 'react';

/** The current mounted catalog, with its query/session generation checks. */
export const CatalogRefreshContext = createContext<
  (() => Promise<void>) | null
>(null);
