/**
 * What the sync screen says when the server would refuse a write.
 *
 * One function because two things read it: the settings section a person looks
 * at, and `window.__testSync.hostedAccount()`, which is how the cross-platform
 * suite asserts on the banner a scenario produced. Written twice it would be
 * two rules, and the one the tests proved would not be the one that shipped.
 *
 * The same rule exists in Swift and Kotlin — the shells each read their own
 * billing status — and the three are registered together in
 * `scripts/drift-registry.json` as `hosted-sync-banner-rule`.
 */

import type { BillingStatusOutput } from '$lib/platform/tauri/hostedSync';

export type HostedBanner = 'none' | 'syncPaused' | 'vaultFull';

/**
 * A banner is a fact about the account, read the same way the account card
 * reads everything else. Sync paused wins over a full vault: a lapsed
 * subscription refuses the write whatever the quota says, so telling someone to
 * buy more storage would be the wrong instruction.
 *
 * `onAccountScreen` is false anywhere before the wizard has finished: a banner
 * about refused writes on the screen where a person is still choosing a vault
 * password would be answering a question nobody has asked yet.
 *
 * A quota of zero means "unknown", not "full" — the number is the plan's
 * ceiling, and a reading that has not arrived must not be rendered as a vault
 * that cannot take another byte.
 */
export function hostedBanner(
  billing: BillingStatusOutput | null,
  onAccountScreen: boolean,
): HostedBanner {
  if (!onAccountScreen || !billing) return 'none';
  if (!billing.entitled) return 'syncPaused';
  if (billing.storageQuotaBytes > 0 && billing.bytesUsed >= billing.storageQuotaBytes) {
    return 'vaultFull';
  }
  return 'none';
}
