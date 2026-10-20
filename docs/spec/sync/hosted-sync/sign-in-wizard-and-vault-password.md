### Sign-in wizard, vault password and recovery key

- **The sync screen leads with "Log in with FUTO"; "Use my own server"
  discloses today's URL and password fields, unchanged.** The disclosed panel is
  literally the same `SyncSettingsSection` _(desktop)_ /
  `SelfHostedSyncSections` _(iOS, Android)_ the flag-off build renders, not a
  second copy of it, so self-hosting cannot drift from it. The offer disappears
  once hosted sync is set up. On iOS this is the Sync sheet reached from
  Settings → Sync, and on Android the Sync screen reached the same way; "Use my
  own server" is a disclosure row on both. →
  HostedSyncSettingsSection.svelte _(desktop)_, HostedSyncSections.swift +
  SyncView.swift _(iOS)_, HostedSyncSections.kt + SyncScreen.kt _(Android)_
- **Which step the wizard is on is computed from server facts, never
  remembered.** Rust's `current_step` reads whether there is a session, whether
  the vault has key material, whether this device holds the vault key, and — only
  when there is no vault — whether the account may write. Quitting halfway and
  reopening therefore lands on the right screen by construction; no shell keeps
  a wizard position, and none may start. → `hosted/vault.rs` `current_step`,
  `createHostedSyncSettings.svelte.ts`; guarded by "the step is read from the
  state machine, never remembered here" in `HostedSetupModelTest.kt` (Android),
  the surviving reference shell suite for the hosted wizard
- **Two shapes.** No vault yet: sign in → subscribe → choose a vault password →
  save the recovery key → sync. Vault exists: sign in → unlock → sync. Subscribe
  cannot be skipped in the first shape because writing the vault key is
  entitlement-gated. → `tests/cross-platform-sync.mjs` (`hosted no vault shape
  reaches a first sync`, `hosted vault exists unlocks by vault password`,
  `hosted vault exists unlocks by recovery key`), which drive the real desktop
  app against a server in stand-in test mode
- **Sign-in, checkout, and the customer portal open in the system browser
  through the app's existing opener** _(desktop)_**, in an
  `ASWebAuthenticationSession` sheet over the app** _(iOS)_**, or in a Chrome
  Custom Tab over the app** _(Android)_, and the app polls the server for the
  outcome. There is no URL scheme, universal link, or return deep
  link anywhere in the flow, so the iOS session is created with no callback
  scheme at all: dismissing it is its only self-completion, and that cancels the
  wait. The sheet is not ephemeral, so an existing FUTO session in the shared web
  credential store makes a second sign-in one tap. A Custom Tab keeps the
  browser's own cookies for the same reason _(Android)_; a device with no Custom
  Tabs provider gets a plain `ACTION_VIEW`, which is the same journey with
  different chrome, and a device with no browser at all says so. Abandoning the
  browser window, the sheet, or the tab leaves no error and no half state — the
  screen is exactly where it was. A Custom Tab has no dismissal callback, so
  Android reads the person's return from the activity's pause/resume pair
  _(Android)_. → `openExternalUrl.ts` _(desktop)_, AuthSheet.swift _(iOS)_,
  CustomTabsAuthSheet.kt _(Android)_, `HostedSetup::await_sign_in`
  > **Gap:** Android cannot reliably take the browser down once the outcome
  > arrives. iOS dismisses its own sheet; a Custom Tab belongs to the browser,
  > and the app's attempt to pop it by re-launching itself is refused as a
  > background activity start ("Background activity launch blocked",
  > `goo.gle/android-bal`) whenever it has had no visible window for a while. It
  > succeeds when the app is still visible and is refused otherwise, so the
  > server's completion page asks the person to go back to FUTO Notes; their
  > return lands on the step the engine reports, and is not mistaken for a
  > dismissal. Closing this needs either a return deep link, which ADR 0003
  > decision 1 rules out, or a foreground-service exemption.
- **A vault password is at least 12 characters, with a strength estimate and no
  composition rules.** The minimum is read from Rust
  (`e2ee_hosted_min_vault_password_length`) so the button and the engine cannot
  disagree. The screen says the password is separate from the FUTO password and
  is never sent anywhere. The estimate is a local length-and-variety measure that
  refuses to call a long repeated character anything but weak; no password
  dictionary ships. **Choosing the first vault password and choosing a new one
  are one screen with two headings**, so the minimum, the meter, and the repeat
  field cannot drift apart between them. → `vaultPasswordStrength.ts` +
  VaultPasswordStep.svelte _(desktop)_, VaultPasswordStrength.swift +
  VaultPasswordStepView.swift _(iOS)_, VaultPasswordStrength.kt +
  VaultPasswordStep.kt _(Android)_
- **The recovery key is shown exactly once and cannot be shown again.** Rust
  returns it from `create_vault` and keeps no copy; a second create is refused
  with `vaultAlreadyExists`. The shell holds it in the wizard object alone —
  never persisted, never re-fetchable — so continuing past the screen ends it.
  The screen offers Copy and **Save file** _(desktop)_ / **Share**, the system
  share sheet _(iOS, Android)_, says plainly that FUTO cannot recover the vault
  without it, and gates Continue on an "I've saved my recovery key" checkbox.
  There is no type-back. What is saved or shared is the key and nothing else, so
  it pastes straight back into the unlock field. **The same screen shows a
  replacement key**, with one extra line saying the old one has stopped working.
  → `hosted/vault.rs` `create_vault` / `new_recovery_key`,
  RecoveryKeyStep.svelte _(desktop)_, RecoveryKeyStepView.swift _(iOS)_,
  RecoveryKeyStep.kt _(Android)_
