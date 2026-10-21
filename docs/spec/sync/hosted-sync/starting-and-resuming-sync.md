### Starting and resuming hosted sync

- **Reaching a set-up, unlocked vault starts syncing.** Whichever door got there
  — vault password, recovery key, or a paired device — the engine hands the vault
  key and the session token it already holds to `SyncSession` and one ordinary
  cycle runs: the same `requestSync` path a self-hosted connect and every later
  auto-sync go through, not a second one written for hosted. The connect carries
  no password. **Within the process that ran the wizard it makes no request** —
  the session and the collection are already resolved — but on a cold process it
  is not free: it validates the saved token with `current_user` and claims the
  collection, so it can fail with a transport error on a device that is offline.
  A device with no vault key is refused rather than half-connected.
  → `hosted/vault.rs` `connect_sync`, `session/connect.rs` `hosted`,
  `e2ee_hosted_connect`, `syncServiceE2ee.ts` `connectHostedE2ee` _(desktop)_
- **Whether this vault is hosted is a local read.** `has_saved_vault` answers from
  the OS secret store alone, with no request of any kind: true iff this device
  holds **both** the vault key and the session token. It is what a shell asks at
  a cold start, before it is willing to spend a round trip and while it may have
  no network at all — neither `current_step` nor `connect_sync` can answer it
  offline. Either secret alone is not a session to resume. → `hosted/vault.rs`
  `has_saved_vault`, `HostedSetupClient.hasSavedVault` _(iOS, Android)_,
  `e2ee_hosted_has_saved_vault` _(desktop)_
- **Reaching `ready` starts the sync, and a restart resumes it without Settings.**
  The wizard fires its connect the first time it observes `ready` in a model's
  life and again after any door lands there, un-awaited, so the account card is
  not held behind a cycle; the account is re-read once that cycle ends, so the
  storage figure is what the vault now weighs. At a cold start the shell asks
  both local questions — is there a stored password, and does
  `has_saved_vault` say this device holds a hosted vault — and connects the one
  that answers; neither costs a request, so a launch with no network still
  knows which kind of vault this is, and a force-quit and relaunch resumes sync
  with Settings never opened. **A device that answers to both resumes hosted.**
  That is the one ambiguous state and it is a one-time migration heal, not a
  change of precedence: with no hosted vault the password still wins, which is
  what keeps a self-hosted device self-hosted. Both shells stop offering the
  self-hosted fields once hosted sync is set up, so no route a person can take
  produces both secrets any more — a device holding both was stranded by a
  build from before "Exactly one sync credential exists at a time" below, and
  resuming hosted runs the clear that ends the ambiguity, so the branch retires
  itself rather than needing a flag to switch it off. Justin's call, 2026-09-16;
  it is deliberately not the rejected "invert the precedence", which changed the
  rule for every case and broke the reverse direction identically. → `SyncManager.restoreBranch` _(iOS, Android;
  shared cases in `tests/conformance/sync-session-mode.json`)_ `NotSignedIn` and `VaultLocked` mean the wizard
  is unfinished and read as not connected, never as a failure; a transport failure
  keeps both secrets and takes the muted live line, and the next foreground or
  session heal retries. → SyncManager.swift / SyncManager.kt `connectHosted` +
  `restoreSession`, HostedSetupModel `connectEffect`

- **A restart resumes the hosted session at launch _(desktop)_**, not on the
  first visit to Settings. The boot credential load asks Rust — a local secret
  store read with no request of any kind — whether this vault holds both a vault
  key and a session token, and if it does it connects inside the same credential
  lock, so `isE2eeConfigured()` is already true when auto-sync's first cycle is
  released. A build without the hosted flow never asks. → `hosted/vault.rs`
  `has_saved_vault`, `e2ee_hosted_has_saved_vault`, `syncServiceE2ee.ts`
  `resumeHostedSessionOnBoot`
- **A launch with no network leaves the vault configured and retries the
  connect on the next sync trigger _(desktop)_**, rather than reporting it
  unconfigured and skipping it until Settings is opened. The retry is the
  ordinary `ensureConnected` on the way into a cycle, carried by auto-sync's
  existing initial and background retry ladders. → `syncServiceE2ee.ts`
  `isE2eeConfigured` + `ensureConnected`

- **Exactly one sync credential exists at a time: starting a hosted session
  clears the stored self-hosted sync password.** The password is app-global
  rather than scoped per vault, and every shell restores the password session
  before asking `has_saved_vault` — so a device that had ever connected to
  someone's own server reconnected there at every launch and the hosted branch
  never ran, with the hosted secrets untouched and the sync screen still
  connecting, which presents exactly like the hosted restore being broken (iOS
  simulator, 2026-09-16, `docs/qa/hosted-sync-ios.md`). The rule makes the
  presence of a password a correct answer to "which mode is this device in?"
  rather than a guess, and reads as **whichever mode you set up last wins**:
  finishing hosted setup clears the password, while setting up self-hosted sync
  leaves the hosted secrets to the sign-out that owns them and the password
  branch takes precedence from there. Justin's call, 2026-09-16; the rejected
  alternatives were an explicit mode field in `AppState` (correct, but a schema
  change plus migration) and inverting the branch precedence (a guess, and it
  breaks the reverse case identically). It is one rule in the engine, not three
  shell copies: `connect_sync` clears the password through the same secret-store
  port it already reads the vault key and token through, at the point where all
  three hosted facts — session, vault key, collection — are in hand. Before the
  engine is handed the session and not after, so opening the hosted screen on a
  self-hosted device costs nobody a password they still need, and a connect that
  then fails because the device is offline still leaves the next launch resuming
  *this* vault. → `hosted/secrets.rs` `VaultSecrets::delete_sync_password`,
  `hosted/vault.rs` `connect_sync`, KeychainVaultSecretStore.swift _(iOS)_,
  KeystoreVaultSecretStore.kt _(Android)_, `sync/password_store.rs` +
  `syncServiceE2ee.ts` `connectHostedE2ee` _(desktop)_

- **Finishing hosted setup replaces a live self-hosted session.** The switch
  action does what it says: the self-hosted session is torn down and the hosted
  one started, rather than the connect being skipped because a session is
  already running. The guard that skips a redundant connect is mode-aware —
  it exists so the wizard's repeated connects (it fires one whenever it sees an
  unlocked vault) cannot stack a second live loop for the **same** mode, and a
  live *password* session is not that. Before it was mode-aware, completing the
  wizard over a live password session ran to a normal-looking account card
  reading **`0 B of 10 GB used`** with no cycle behind it, and the next launch
  went back to the old server (iOS simulator, 2026-09-16). Justin's call the
  same day. The teardown is the real one — Rust stops the live loop and demotes
  the vault, exactly as an explicit disconnect does — because dropping the
  client reference alone leaves an orphaned SSE loop pulling into a vault this
  device no longer syncs that way; it deliberately does **not** clear the stored
  password, which stays the business of the hosted connect below. _(desktop)_
  needs no teardown of its own: it holds one engine session and
  `SyncSession::connect_hosted` stops the previous live loop before swapping it,
  but the shell must drop its "the stream is already running" flag or the hosted
  session gets no stream at all. → `SyncManager.hostedConnectEntry` _(iOS,
  Android; shared cases in `tests/conformance/sync-session-mode.json`)_,
  `syncServiceE2ee.ts` `connectHostedE2ee` _(desktop)_
