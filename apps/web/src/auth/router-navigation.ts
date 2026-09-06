import { DEFAULT_PAGE, findPage } from './pages';

/** Only access-policy destinations enter here; preserve query/hash verbatim. */
export function routerDestination(target: string) {
  return {
    to: findPage(target.split(/[?#]/, 1)[0])?.path ?? DEFAULT_PAGE,
    href: target,
    replace: true as const,
  };
}
