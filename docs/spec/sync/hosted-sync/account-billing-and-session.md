### Account, billing and session

- **The account card reads one billing endpoint** and shows the email, the
  subscription state in words ("Active", "Payment failed. In 4 days, sync
  pauses.", "Expired"), storage used against the quota, "Manage subscription",
  "Change vault password", "New recovery key", and Sign out. The app writes no billing state: cancellation, invoices, and
  cards live behind the portal link, which is a fresh one-shot URL minted per
  press. → `subscriptionState.ts` + HostedAccountCard.svelte _(desktop)_,
  SubscriptionState.swift + HostedAccountCardView.swift _(iOS)_,
  SubscriptionState.kt + HostedAccountCard.kt _(Android)_
- **A refused write is a banner, not an error.** An account that may no longer
  write shows **Sync paused** with a Subscribe button and says that notes from
  other devices still arrive; a full vault shows **Vault is full** with the
  portal button. Sync paused wins when both are true, because a lapsed
  subscription refuses the write whatever the quota says. Reads are never gated.
  → `hostedBanner.ts` _(desktop)_, HostedSetupModel.swift _(iOS)_,
  HostedSetupModel.kt _(Android)_; `tests/cross-platform-sync.mjs` (`hosted
  lapsed subscription pauses writes and keeps reads`, `hosted full vault raises
  the vault full banner`) proves both banners and the read still arriving on the
  real desktop app
- **The refused cycle raises the banner itself, before anyone opens the account
  screen.** The engine reports a `402` or `507` on the write half of a cycle as
  one named verdict on that cycle — the same precedence, decided once in Rust —
  and each shell keeps the newest one beside its billing reading, so the banner
  is up the moment the refused cycle ends rather than on the next billing read.
  It is never a latch: the first cycle that is not refused clears it, which is
  how buying room makes the banner go away with nothing reset.
  → `futo_notes_sync::WriteRefusal` + `SyncSummary.write_refusal`
  (`sync/outcome.rs`), projected as `writeRefusal` through both shell
  contracts; `hostedWriteRefusal.svelte.ts` _(desktop)_,
  `SyncManager.lastWriteRefusal` _(iOS, Android)_; the two cross-platform
  scenarios above assert the banner with no billing call in between
- **A refused write says what actually happened on the sync status line.** It
  reads "Sync paused" / "Vault is full" with the explanation, not "Sync
  completed with errors" — nothing is broken, the account simply may not write,
  and the generic wording sent people looking for a server fault. The Subscribe
  and portal buttons live on the banner on the sync screen. → ADR 0003 decision
  8; `syncManager.svelte.ts` `syncErrorForSource` _(desktop)_,
  `SyncManager.applyOutcome` _(iOS, Android)_,
  `sync.errors.writePausedSubscription` / `writePausedQuota`
- **Changing the vault password and issuing a new recovery key ask for no
  current secret.** This device already holds the vault key, and a device set up
  by scanning a QR code never knew the vault password, so requiring it would
  lock that device out of both actions. The new vault password is typed twice on
  the same screen the wizard uses to choose the first one; the new recovery key
  appears on the wizard's own save screen, and the old one stops working the
  moment it does. → `hosted/vault.rs` `change_vault_password` /
  `new_recovery_key`, `e2ee_hosted_change_vault_password` /
  `e2ee_hosted_new_recovery_key`; `tests/hosted_scenarios/mod.rs`
  (`a_new_vault_password_replaces_the_old_one`,
  `a_new_recovery_key_invalidates_the_old_one`)
- **Each re-wraps one envelope and sends both.** Changing the vault password
  rebuilds the password envelope and carries the recovery envelope back
  unchanged; a new recovery key does the reverse. A `PUT` of key material
  replaces the whole of it, so leaving the other envelope out would delete a
  working door rather than leave it alone (server ADR 0006, rule 2). Neither
  changes the vault key itself, which is why notes already stored stay readable.
  → `tests/hosted_scenarios/mod.rs`
  (`changing_the_vault_password_keeps_the_recovery_key_working`)
- **A re-wrap is guarded by the revision the person was looking at.** The engine
  remembers the `key_updated_at` of the key material it last read and sends it as
  `previous_key_updated_at`; a server that has moved on answers `409` with the
  authoritative material. That surfaces as `vaultKeyChangedElsewhere` — "your
  vault's key was changed on another device, try again" — and nothing is
  overwritten. The engine adopts what the refusal carried, so the person's own
  second press lands with no re-read to ask for. Re-reading at the moment of the
  write instead would quietly overwrite the other device's change.
  → `server/mod.rs` `rewrap_key`, `hosted/vault.rs` `rewrap`;
  `tests/hosted_scenarios/mod.rs`
  (`a_stale_key_revision_is_refused_and_clears_on_retry`,
  `a_stale_recovery_key_revision_is_refused`)
- **A device that does not hold the vault key can do neither**, and is told so
  (`vaultLocked`) rather than shown a screen that cannot work.
  → `tests/hosted_scenarios/mod.rs`
  (`a_locked_device_cannot_change_the_vault_password`)
- **A vault-password change on one device reaches no other device.** The vault
  key is unchanged, so every other device keeps the key it already holds, stays
  on the account card rather than being sent back to a wizard, and keeps
  syncing — it is never told anything happened. → `tests/hosted_scenarios/mod.rs`
  (`changing_the_vault_password_leaves_another_device_untouched`,
  `changing_the_vault_password_leaves_another_device_syncing` — the second runs
  against a real stand-in server only, because the in-test hosted stub mounts the
  setup routes and has no object API to sync against)
- **Sign out is one action**: it revokes the session on the server (best
  effort), deletes the vault key and the session token from the OS secret store,
  and demotes this vault's sync state exactly as disconnect does — desktop
  clears the shown "last synced" time on both paths, through the same
  `clearLastSyncedAt` call. It asks for confirmation first. The notes on disk
  are untouched. There is no locked-but-signed-in halfway state. →
  `hosted/vault.rs` `sign_out`, `syncServiceE2ee.ts` `disconnectE2ee` /
  `forgetHostedE2ee`
- **An expired hosted session is a trip to the browser, never a vault reset.**
  `invalid_session` surfaces as "log in again"; the vault key, the object map,
  the pull cursor, and every note stay exactly where they are. → `hosted/mod.rs`
  `HostedError::SignInAgain`, `hostedSyncErrors.ts` _(desktop)_,
  HostedSyncErrors.swift _(iOS)_, HostedSyncErrors.kt _(Android)_
- **The device keeps the 32-byte vault key and the session token in the OS
  secret store, keyed per notes root; the vault password is never stored.** A
  device set up by password and one set up by recovery key are indistinguishable
  afterwards, and neither is asked for a password again. On iOS that store is the
  Keychain, under the same config-separated service the sync password uses, so a
  debug build can never read the production vault's key. On Android it is the
  Keystore-backed `SecureStore`, whose AES-256/GCM key never leaves the Keystore
  and whose prefs live under the build's own application id, so a debug build
  cannot read the production vault's key either; a write that the Keystore does
  not keep is an error rather than a device that looks set up. → Keychain.swift +
  KeychainVaultSecretStore.swift _(iOS)_, SecureStore.kt +
  KeystoreVaultSecretStore.kt _(Android)_
- **An address that does not offer hosted sign-in says so** rather than opening a
  browser onto a route that is not there. The capability document is probed
  before the first hand-off is minted. → `e2ee_hosted_probe`
