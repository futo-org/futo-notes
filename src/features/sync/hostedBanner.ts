/**
 * What the sync screen says when the server would refuse a write.
 *
 * One function because three things read it: the settings section a person
 * looks at, `window.__testSync.hostedAccount()`, which is how the
 * cross-platform suite asserts on the banner a scenario produced, and
 * `window.__testSync.hostedRefusalBanner()`, which asks the same question of
 * a refused cycle alone. Written more than once it would be more than one rule,
 * and the one the tests proved would not be the one that shipped.
 *
 * The same rule exists in Swift and Kotlin — the shells each read their own
 * billing status — and the three are registered together in
 * `scripts/drift-registry.json` as `hosted-sync-banner-rule`.
 */

import type { BillingStatusOutput } from '$lib/platform/tauri/hostedSync';
import type { WriteRefusalOutput } from './syncContract.generated';

export type HostedBanner = 'none' | 'syncPaused' | 'vaultFull';

/**
 * Two ways to learn the same thing, and a banner either of them earns.
 *
 * `billing` is a reading of the account, taken when the sync screen opens.
 * `writeRefusal` is the last cycle's own answer — Rust's reading of the 402 or
 * 507 the server actually returned (`futo_notes_sync::WriteRefusal`), which
 * arrives the moment the refused cycle ends and needs no billing call at all.
 * Neither is a latch: the next cycle replaces the refusal and the next Settings
 * open replaces the reading, so buying room clears the banner on its own.
 *
 * Sync paused wins over a full vault, whichever input says so: a lapsed
 * subscription refuses the write whatever the quota says, so telling someone to
 * buy more storage would be the wrong instruction.
 *
 * `onAccountScreen` is false anywhere before the wizard has finished: a banner
 * about refused writes on the screen where a person is still choosing a vault
 * password would be answering a question nobody has asked yet — and it is what
 * keeps a refusal from one account's cycle off the sign-in screen of the next.
 *
 * A quota of zero means "unknown", not "full" — the number is the plan's
 * ceiling, and a reading that has not arrived must not be rendered as a vault
 * that cannot take another byte.
 */
export function hostedBanner(
  billing: BillingStatusOutput | null,
  onAccountScreen: boolean,
  writeRefusal: WriteRefusalOutput | null = null,
): HostedBanner {
  if (!onAccountScreen) return 'none';
  if (writeRefusal === 'subscriptionRequired' || billing?.entitled === false) return 'syncPaused';
  if (writeRefusal === 'quotaExceeded') return 'vaultFull';
  if (billing && billing.storageQuotaBytes > 0 && billing.bytesUsed >= billing.storageQuotaBytes) {
    return 'vaultFull';
  }
  return 'none';
}
