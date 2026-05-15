import type { Router } from 'expo-router';

export const LAPSE_PAYWALL_ROUTE = '/paywall-lapse';

/**
 * Push the lapse-mode paywall as a dismissible modal. No-op when the user is
 * already on the lapse paywall to prevent stacked-modal pushes from banner +
 * capture taps firing in quick succession.
 *
 * `pathname` comes from `usePathname()` at the call site so we can guard
 * without coupling this helper to the router internals.
 */
export function openLapsePaywall(router: Router, pathname: string): void {
  if (pathname.startsWith(LAPSE_PAYWALL_ROUTE)) return;
  router.push(LAPSE_PAYWALL_ROUTE);
}
