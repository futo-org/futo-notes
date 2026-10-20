## Native shells

Both native shells have a full Settings surface (Android: note-list top-bar
gear → Settings; iOS: nav-bar gear → Settings sheet — the cloud button still
opens the Sync sheet directly). Verified on emulator + simulator 2026-06-09. →
SettingsScreen.kt _(Android)_, SettingsView.swift _(iOS)_

- **Sync** group: a single **"Sync"** entry — a cloud icon, the
  connected-vs-local status, and a SYNCED / LOCAL badge — routes to the Sync
  screen. This one entry is the whole Sync surface: there is no separate
  account header above the group, and no separate "Server" row. Tapping it
  opens the Sync screen; when no server is connected yet, that screen points
  the user at the FUTO Notes server repo (see sync.md). The row said
  "Self-hosted sync" until hosted sync existed; it is now just "Sync", because
  self-hosting is one of the two things behind it. →
  `settings.sync.label`, SettingsScreen.kt _(Android)_, SettingsView.swift _(iOS)_
- **Sync screen, with hosted sync built in** _(iOS)_: a build carrying the
  `FUTO_HOSTED_SYNC` compilation condition — every Debug build, and the internal
  TestFlight archive — leads that Sync sheet with the hosted wizard ("Log in with
  FUTO", the subscribe / vault-password / recovery-key / unlock steps, the account
  card, and the two refused-write banners) and discloses today's server URL and
  password fields under **"Use my own server"**. The disclosed rows are the same
  `SelfHostedSyncSections` a flag-off build renders, so a self-hoster sees the
  identical screen either way, and with the flag off nothing about the Sync sheet
  changes. Behaviour is specified once, in [sync.md](../sync.md) "Hosted sync". →
  HostedSyncSections.swift, SyncView.swift, HostedSyncBuild.swift
- **Sync screen, with hosted sync built in** _(Android)_: the same, on the Sync
  screen reached from Settings → Sync, gated by `BuildConfig.HOSTED_SYNC` — every
  debug build, and a release build made with `FUTO_HOSTED_SYNC=true`. The
  disclosed rows are the same `SelfHostedSyncSections` a flag-off build renders.
  The screen scrolls, because the wizard's steps are taller than the self-hosted
  form it replaced. →
  HostedSyncSections.kt, SyncScreen.kt, HostedSyncBuild.kt
- **Appearance**: the Theme Light/Dark/Auto control from "All platforms"
  applies immediately, including to the open Settings sheet the user changed it
  from, in both directions (iOS: the scene's windows get an
  `overrideUserInterfaceStyle`, which every sheet, cover, alert and the editor
  WebView inherit — a root-level `.preferredColorScheme` left an
  already-presented sheet dark forever; persisted in UserDefaults
  `futo.themeMode` / Android SharedPreferences `theme_mode`; survives relaunch —
  verified via the crash-test relaunch). → Theme.swift `appearanceOverride`
  _(iOS)_
- **Language**: Android's dropdown reads and writes the operating system's
  per-app language setting on Android 13+, and stores the choice itself on older
  releases that have none. iOS's row opens the app's system Settings, where the
  operating system owns selection. Draft settlement follows the platform rules in
  [localization.md](../localization.md).
- **Storage**: a notes-directory path readout. On Android, **Storage location**
  opens the picker as a Settings sub-screen — Back or its **Cancel** button
  returns to Settings and changes nothing (see nav.md). Changing Device/App
  storage shows a blocking migration state and relaunches only after the whole
  vault is verified and an app-private migration journal is durably activated.
  The journal is the authority across preference-commit ambiguity and process
  death: `PREPARED` selects the old root; `FINALIZING` records that source
  cleanup has begun after the destination was fully verified; recovery selects
  that destination when a removable source is absent or still present, retaining
  a present source as a backup. A source-removal-forbidden Device migration
  instead rolls back to its still-present source until activation is durably
  recorded. `ACTIVATED` selects the verified destination and may retain an
  uncleared source as a backup if final cleanup could not finish. A Device
  source is always retained as that backup because other apps can still write
  it outside FUTO Notes' migration gate. Unmounted or permission-denied storage
  is unavailable, not absent or present, and still fails closed. A late source
  edit aborts activation and keeps the current mode active. Failure before
  activation surfaces an actionable toast; a different non-empty destination
  is never merged into or deleted. Leaving the editor captures and
  persists-or-parks its latest live body before Settings can open; the migration
  then flushes any retained draft under the vault gate before staging. The
  blocking overlay never depends on an attached editor WebView. Every copied
  file keeps its modified time wherever the destination filesystem can carry
  one, so a storage change leaves Last Modified ordering and each note's
  displayed age unchanged; the copy is never failed over a timestamp.
  → `vault_migration::copy_file`
  Changing location and moving notes are separate operations, decided by what the
  target already holds: an **empty** target gets the whole-vault copy above, while
  a target that **already holds files** is opened as a vault — nothing is copied,
  merged, or deleted, and the previous folder keeps every note it has. Opening
  asks first, via a confirmation naming both note counts, how recently the target
  changed, and where the current notes stay, because the target is often a backup
  an earlier switch left behind and its age is the only signal that its notes are
  older. Opening an occupied folder is refused while sync is connected: the
  E2EE checkpoint lives in the vault root, so adopting a foreign one would
  reconcile a different note set against the current watermark; a migration
  carries that checkpoint along and stays allowed. Confirming retires any
  migration journal before the new location is persisted, because the journal
  outranks the preference at startup: a completed Device migration deliberately
  leaves an `ACTIVATED` record behind while its retained source awaits cleanup, and
  a surviving record would name the old destination as the verified root and
  silently revert the choice on the next launch. A journal that cannot be retired
  keeps the current folder and says so. A target that is not a directory, is
  unreadable, or is nested with the current folder is refused. Startup reads the
  journal and storage preferences on `Dispatchers.IO` after the first
  composition. → `MainActivity.performSwitch`,
  `MainActivity.adoptExistingStorage`, Android `storage/` (`storageSwitchPlan`,
  `storageAdoptionMessage`), `futo-notes-store::vault_migration` (`inspect`);
  both directions and the occupied-target confirmation are guarded end-to-end on
  a device by `just test-android-storage` (`tests/android-storage-migration.mjs`)
- **About**: an open-source link (GitLab) and the app version.
- **Issue reporting**: "Share crash reports" toggle with a nested **"Send
  crashes automatically"**, plus a **"Send feedback"** row that pushes the
  feedback form. See app.md for the crash dialog flow, and "Feedback" below for
  the form. → iOS `FeedbackView.swift`, Android `FeedbackScreen.kt`
- **Danger zone — Full reset**: same modal-confirmation contract as the Tauri
  shell below — tapping **Full reset** opens a confirmation dialog
  ("Permanently delete all notes and app data? This cannot be undone."); only
  confirming there deletes everything under the vault root (notes, folders,
  `.crashlogs`) behind a blocking "Deleting all notes…" overlay, with live
  sync paused and the connection + stored password dropped so a racing sync
  cannot resurrect files; the next launch reseeds the welcome note and stays
  LOCAL. Both native shells stop admitting store and sync work before awaiting
  sync shutdown and draining admitted mutations. Reset retires all live and
  retained draft owners, queued flushes, and stale projections; callbacks from
  retired editors cannot recreate wiped notes after admission resumes. Wipe
  failures are visible. → `FullResetTests`, `EditorDraftCoordinatorTests`,
  `EditorLifecycleFlushTest`, native `NotesStore`.
  iOS presents a `.confirmationDialog`; Android presents the shared
  `ConfirmDialog` (Material 3 `AlertDialog`). (Modal confirm verified on both
  2026-06-30; the earlier two-tap arm/confirm was removed because a stray
  double-tap wiped everything too easily.)
  The Danger zone is **always the last section** in Settings — below every
  other section (including Updates) — so the destructive action never sits
  above routine settings.
- Debug builds add a "Test crash" row to exercise the crash pipeline.
