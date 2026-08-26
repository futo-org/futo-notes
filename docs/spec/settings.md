# Settings — Spec

## All platforms

- **Theme**: Light / Dark / Auto. Auto follows the system setting; selecting a
  theme applies immediately (no restart) and persists across restarts. On
  desktop, Auto tracks the OS theme via the window/portal theme-change event and
  the event's reported value wins — the webview's own `matchMedia` cannot observe
  the Linux desktop theme, so it is not the source of truth for Auto. →
  SettingsScreen.kt (SharedPreferences `theme_mode`) _(Android)_;
  theme.ts / createAppBootstrap.svelte.ts / SettingsScreen.svelte _(Tauri)_
- **Language** follows [localization.md](localization.md). Desktop and Android
  provide a System-first language dropdown and apply changes immediately. iOS
  provides a row that opens the app's system Settings instead of an in-app
  dropdown. The selection is local to the device and never syncs.

> **Gap:** The language controls, persistence, and immediate application described
> here are not wired into any Settings surface yet; only the shared localization
> foundation exists.

- The app version is shown.

## Native shells

Both native shells have a full Settings surface (Android: note-list top-bar
gear → Settings; iOS: nav-bar gear → Settings sheet — the cloud button still
opens the Sync sheet directly). Verified on emulator + simulator 2026-06-09. →
SettingsScreen.kt _(Android)_, SettingsView.swift _(iOS)_

- **Sync** group: a single **"Self-hosted sync"** entry — a cloud icon, the
  connected-vs-local status, and a SYNCED / LOCAL badge — routes to the Sync
  screen. This one entry is the whole Sync surface: there is no separate
  account header above the group, and no separate "Server" row. Tapping it
  opens the Sync screen; when no server is connected yet, that screen points
  the user at the FUTO Notes server repo (see sync.md). →
  SettingsScreen.kt _(Android)_, SettingsView.swift _(iOS)_
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
  per-app language setting. iOS's row opens the app's system Settings, where the
  operating system owns selection. Draft settlement and restoration follow the
  platform rules in [localization.md](localization.md).
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
  blocking overlay never depends on an attached editor WebView.
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
  `describeStorageAdoption`), `futo-notes-store::vault_migration` (`inspect`);
  both directions and the occupied-target confirmation are guarded end-to-end on
  a device by `just test-android-storage` (`tests/android-storage-migration.mjs`)
- **About**: an open-source link (GitLab) and the app version.
- **Issue reporting**: "Share crash reports" toggle with a nested **"Send
  crashes automatically"**, plus a **"Report an issue"** link that opens the
  FUTO Notes GitHub issue tracker
  (`https://github.com/futo-org/futo-notes/issues`). See app.md for the crash
  dialog flow.
- **Danger zone — Full reset**: same modal-confirmation contract as the Tauri
  shell below — tapping **Full reset** opens a confirmation dialog
  ("Permanently delete all notes and app data? This cannot be undone."); only
  confirming there deletes everything under the vault root (notes, folders,
  `.crashlogs`) behind a blocking "Deleting all notes…" overlay, with live
  sync paused and the connection + stored password dropped so a racing sync
  cannot resurrect files; the next launch reseeds the welcome note and stays
  LOCAL. On iOS the disconnect is awaited before the vault reset begins,
  guarded by `FullResetTests`. iOS presents a `.confirmationDialog`; Android presents the shared
  `ConfirmDialog` (Material 3 `AlertDialog`). (Modal confirm verified on both
  2026-06-30; the earlier two-tap arm/confirm was removed because a stray
  double-tap wiped everything too easily.)
  The Danger zone is **always the last section** in Settings — below every
  other section (including Updates) — so the destructive action never sits
  above routine settings.
- Debug builds add a "Test crash" row to exercise the crash pipeline.

## Tauri shell

- Settings is a sheet/modal (mobile: bottom sheet over the current screen)
  with sections: Storage, Appearance, Sync, Issue reporting, Updates, then
  Danger zone last, and a version footer. The sheet fully covers and blocks
  floating editor UI, including the selection toolbar. → SettingsScreen.svelte,
  src/styles/editor-selection-toolbar.css, tests/editor-ux.spec.ts "Selection
  toolbar > stacks below blocking overlays" (see settings-visual.md for the
  platform-split and shared content model)
- **Storage:** the section is described by `vault_status`, which answers for a
  vault that has gone missing as well as a healthy one, so it never depends on
  reading the vault it is there to fix. Both changing and resetting the root
  confirm first with a warning dialog naming the restart (the change dialog also
  notes existing notes are not moved). Choosing a custom root requires an absolute
  path, creates it before persistence, saves it through
  `notes_dir_override_save`, invalidates the frontend root cache, and then
  relaunches. Reset saves a `null` override and relaunches. The relaunch is a full
  process restart, **not** a `window.location.reload()`: the Rust filesystem
  watcher binds the vault root once at startup, so only a restart rebinds it to
  the new vault (a webview reload leaves external-change detection pointed at the
  old root). →
  `src/lib/platform/tauri/appConfig.ts`, `notesRoot.ts`, SettingsScreen.svelte,
  `apps/tauri/src-tauri/src/vault_location.rs`
- **Storage in a sandbox:** **Change directory** works in sandboxed (Flatpak)
  builds too. The folder picker routes through the FileChooser portal, so the chosen
  directory arrives as an XDG document-portal path, which is stored **verbatim**. The
  app registers nothing: the portal already grants a picked directory
  `PERSISTENT | REUSE_EXISTING` with `read,write,grant-permissions`, so the grant
  outlives the process and re-picking the same folder returns the same document id —
  no accumulation, and a stable vault path. →
  `apps/tauri/src-tauri/src/portal_vault.rs`, `vault_location::write_override_file`
- Nothing may re-register a picked vault to "make it persistent": the document portal
  refuses a descriptor pointing into its own FUSE mount
  (`org.freedesktop.portal.Error.InvalidArgument: Invalid fd passed`), so the attempt
  fails for exactly the paths it would be for. →
  `portal_vault::tests::re_registering_a_document_portal_path_is_refused`
- The grant the chooser issues carries no document-`delete` permission, which the
  vault does not need: creating, atomically replacing, renaming and unlinking notes
  and folders all work through the granted directory. That permission governs deleting
  the _document entry_, which the app never does.
- Every path shown for a sandboxed vault — in Storage and in the change
  confirmation — is the folder the user actually picked, resolved back through
  `Documents.Info`, never `/run/user/<uid>/doc/<id>/…`. Asking for that name is
  read-only and grants nothing. → `vault_display_path`, `portal_vault::display_path`
- Images in a sandboxed vault render through `asset://` like any other vault: the
  asset-protocol scope includes `/run/user/*/doc/**`. → tauri.conf.json
- A picked directory the app cannot use — a folder it cannot create, a refused
  relaunch — toasts "Could not use that folder: …" rather than leaving the pick to do
  nothing. → SettingsScreen.svelte
- **A vault that has gone missing** — an unmounted drive, a revoked sandbox grant
  — is a recoverable state, not a wedged app: the root is never recreated in
  place, every note command fails with `Notes folder unavailable`, the shell
  toasts "Notes folder unavailable — choose a folder in Settings", and the
  Storage section explains it ("This folder is no longer reachable. Choose it
  again, or reset to the default location.") and keeps both **Change directory**
  and **Reset to default** usable. `isCustom` is read from the vault's _location_,
  never from a successful vault read, so **Reset to default** cannot be hidden by
  the failure it is there to undo. → `vault_location::VAULT_UNAVAILABLE`,
  StorageSettingsSection.svelte
- A vault whose external changes are found by polling rather than by inotify says
  nothing about it in the UI; the only user-visible consequence is that an external
  edit can take a few seconds to appear (see desktop-rust.md). If the watcher fails
  to start at all, the shell toasts "External file changes will not be detected
  until you restart". → startNativeShell.ts
- Re-picking a folder reuses its existing document id, so an ordinary re-pick keeps
  the saved sync password. Only a folder re-picked after its grant was **revoked**
  comes back under a new document id — the E2EE sync password is keyed on the vault
  path, so **sync asks for the vault password once more** after that recovery.
  Accepted rather than worked around: the alternative is an identifier persisted
  inside the vault plus a rule for whether a re-picked folder inherits it, and a
  wrong answer would hand one vault's password to another. → `sync/password_store.rs`
- **Sync**: server URL + password inline with a Connect button and a
  "Last sync: …" line ("never" before the first sync). Once connected the
  section shows the locked URL plus **Sync now**, **Forget password**, and
  **Reset connection** (confirmed) — clicking the read-only server URL also
  opens the Reset-connection confirm. When connected without a saved password
  (keyring unavailable or forgotten), a "Vault password — required after
  restart" field appears for on-demand re-entry (see sync.md). →
  SyncSettingsSection.svelte, createSyncSettings.svelte.ts
- **Language**: a System-first dropdown applies the language immediately and
  persists it locally. System is resolved at launch and foreground entry; save
  failure and removed-language behavior follow
  [localization.md](localization.md).
- **Issue reporting**: a "Share crash reports" toggle (anonymous crash logs), a
  nested **"Send crashes automatically"** option, and a **"Report an issue"**
  link that opens `https://github.com/futo-org/futo-notes/issues`; see app.md
  for the crash dialog flow.
- Dev builds additionally show a **Sync error test** section (fabricated
  sync-failure scenarios that exercise the failure-message UI) and a **Test
  crash** button in the Danger zone; neither ships in release builds
  (`import.meta.env.DEV`). → DevSyncErrorSettingsSection.svelte,
  DangerSettingsSection.svelte
- **Updates (desktop self-update)**: an "Updates" section with a single
  state-driven button — Check for updates → Restart & update to vX →
  Downloading…N% → Restart now to finish — backed by the Tauri updater plugin
  (minisign-verified; endpoint + pubkey in tauri.conf.json). The section shows
  only where the running install can self-update: dev builds always (so the
  button is reachable for manual testing), release builds only on AppImage /
  macOS / Windows (NOT deb/rpm, which update via the system package repo), gated
  by the Rust `app_self_update_supported` command. Installing relaunches into
  the new version. The button and the global update banner (see app.md) share one state
  machine (`updateChecker`), so a check in either surface reflects in the other.
  An **Automatically check for updates** toggle (persisted in app state, default
  on) gates the section: off stops the hourly background poll, clears any pending
  update (so the banner also disappears), and hides the manual button; on resumes
  checks. The toggle locks while an update is downloading/installing or staged
  awaiting restart — those bytes are already on disk and can't be un-staged.
  → SettingsScreen.svelte, updater.ts, updateChecker.svelte.ts,
  `apps/tauri/src-tauri/src/updater_commands.rs`
  `app_self_update_supported`, [desktop-rust.md](desktop-rust.md)
- **Danger zone — Full reset**: permanently removes all notes and app data.
  Tapping **Full reset** opens a confirmation dialog ("Permanently delete all
  notes and app data? This cannot be undone."); only confirming deletes, with
  a blocking "Deleting all notes…" overlay, then reloads. Live sync is stopped
  and the E2EE connection + stored password are dropped before the vault is
  wiped, so a racing sync cannot push the wipe or resurrect files. The native
  shells implement the same contract (see "Native shells" above). →
  SettingsScreen.svelte (`confirmDialog`), app/resetAllNotes.ts `resetAllNotes`,
  notes.svelte.ts `deleteAllNotes`
