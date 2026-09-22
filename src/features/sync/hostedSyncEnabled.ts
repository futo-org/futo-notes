import { isTauri } from '$lib/platform';

/**
 * Whether this build shows the hosted sync flow ("Log in with FUTO").
 *
 * Off is not a variant of the screen — it is today's self-hosted screen,
 * rendered by the same `SyncSettingsSection` it has always been rendered by,
 * so a store release before launch cannot grow a dead button (ADR 0003,
 * decision 13; parent spec user story 36).
 *
 * On for the desktop dev build, and for any build that opts in with
 * `VITE_HOSTED_SYNC=true` — which is how the cross-platform harness gets a
 * packaged binary with the flow on. The same shape as `testHooksEnabled()`,
 * deliberately: one env-driven build decision should not have two idioms.
 *
 * `isTauri` is part of the flag rather than a check at each call site because
 * the whole flow is `e2ee_hosted_*` Tauri commands; in the browser harness
 * there is nothing behind any of these screens.
 */
export function hostedSyncEnabled(): boolean {
  if (!isTauri) return false;
  return import.meta.env.DEV || import.meta.env.VITE_HOSTED_SYNC === 'true';
}
