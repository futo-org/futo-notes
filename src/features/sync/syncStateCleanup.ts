import {
  commitLegacySyncStateScrub,
  getLegacySyncState,
  updateAppState,
} from '$shared/state/appState';
import { getPlatformFS, isTauri } from '$lib/platform';

/**
 * PKT-17: once the Rust import has persisted `.e2ee-state.json`, the legacy
 * `e2eeObjectMap` / `e2eeMaxVersion` in `.app-state.json` are dead (`load`
 * prefers `.e2ee-state.json`), so stop re-injecting them and let the next save
 * scrub them. The trigger is the ACTUAL existence of `.e2ee-state.json`, not
 * "a connect/resume returned": `e2ee_resume` (the path the pre-port cohort hits
 * on boot) does NOT persist — only `e2ee_connect` and a completed sync cycle
 * do — so clearing on resume alone could drop the map if the app dies before
 * the first cycle.
 *
 * BEST-EFFORT: this is called AFTER a connect/sync that has already committed,
 * so it must never turn a completed operation into a reported failure — every
 * path (the read, the scrub write) is swallowed and logged. A retained holdover
 * is fully recoverable (re-captured next boot, re-scrubbed next cycle).
 */
export async function scrubLegacySyncStateIfConsumed(): Promise<void> {
  if (!isTauri || getLegacySyncState() === undefined) return;
  try {
    const persisted = await (await getPlatformFS()).readAppData('.e2ee-state.json');
    if (persisted == null) return;
    if (!(await commitLegacySyncStateScrub())) {
      console.warn('[e2ee] legacy sync-state scrub write failed; will retry next cycle');
    }
  } catch (e) {
    console.warn('[e2ee] legacy sync-state scrub deferred; will retry next cycle:', e);
  }
}

/** Clears the "last synced" time Settings shows, so a disconnected or
    signed-out vault can never display a stale one. Shared by self-hosted
    disconnect and hosted sign-out — sign-out "demotes this vault's sync
    state exactly as disconnect does" (ADR 0003 decision 9), and this is
    part of that state. */
export async function clearLastSyncedAt(): Promise<void> {
  await updateAppState({ lastSyncedAt: null });
}
