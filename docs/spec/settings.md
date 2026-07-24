# Settings — Spec

## All platforms

- **Theme**: Light / Dark / Auto. Auto follows the system setting; selecting a
  theme applies immediately (no restart) and persists across restarts. On
  desktop, Auto tracks the OS theme via the window/portal theme-change event and
  the event's reported value wins — the webview's own `matchMedia` cannot observe
  the Linux desktop theme, so it is not the source of truth for Auto. →
  SettingsScreen.kt (SharedPreferences `theme_mode`) _(Android)_;
  theme.ts / createAppBootstrap.svelte.ts / SettingsScreen.svelte _(Tauri)_
- The app version is shown.

## Native shells

Both native shells have a full Settings surface (Android: drawer → Settings;
iOS: nav-bar gear → Settings sheet — the cloud button still opens the Sync
sheet directly). Verified on emulator + simulator 2026-06-09. →
SettingsScreen.kt _(Android)_, SettingsView.swift _(iOS)_

- **Sync** group: a single **"Self-hosted sync"** entry — a cloud icon, the
  connected-vs-local status, and a SYNCED / LOCAL badge — routes to the Sync
  screen. This one entry is the whole Sync surface: there is no separate
  account header above the group, and no separate "Server" row. Tapping it
  opens the Sync screen; when no server is connected yet, that screen points
  the user at the FUTO Notes server repo (see sync.md). →
  SettingsScreen.kt _(Android)_, SettingsView.swift _(iOS)_
- **Appearance**: the Theme Light/Dark/Auto control from "All platforms"
  applies immediately (iOS: `.preferredColorScheme` + the editor WebView
  theme follows; persisted in UserDefaults `futo.themeMode` / Android
  SharedPreferences `theme_mode`; survives relaunch — verified via the
  crash-test relaunch).
- **Storage**: a notes-directory path readout. On Android, changing Device/App
  storage shows a blocking migration state and relaunches only after the whole
  vault is verified and an app-private migration journal is durably activated.
  The journal is the authority across preference-commit ambiguity and process
  death: `PREPARED` selects the old root; `FINALIZING` records that source
  cleanup has begun and selects the destination on recovery only when the source
  is absent; `ACTIVATED` selects the verified destination and may retain an
  uncleared source as a backup if final cleanup could not finish. A Device
  source is always retained as that backup because other apps can still write
  it outside FUTO Notes' migration gate. Recovery promotes a `FINALIZING`
  destination only after proving the source absent; unmounted or permission-
  denied storage is unavailable, not absent. A late source edit aborts
  activation and keeps the current mode active. Failure before activation
  surfaces an actionable toast; a different non-empty destination is never
  merged into or deleted. The editor remains composed behind the blocking
  overlay so its live draft can be flushed before the Rust-owned whole-vault
  migration begins. Startup reads the journal and storage preferences on
  `Dispatchers.IO` after the first composition. →
  `MainActivity.performSwitch`, Android `storage/`,
  `futo-notes-store::vault_migration`
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
  LOCAL. iOS presents a `.confirmationDialog`; Android presents the shared
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
- **Storage:** the displayed active/default roots come from the Tauri platform
  facade. Both changing and resetting the root confirm first with a warning
  dialog naming the restart (the change dialog also notes existing notes are
  not moved). Choosing a custom root requires an absolute path, creates it before
  persistence, saves it through `notes_dir_override_save`, invalidates the
  frontend root cache, and then relaunches. Reset saves a `null` override and
  relaunches. The relaunch is a full process restart, **not** a
  `window.location.reload()`: the Rust filesystem watcher binds the vault root
  once at startup, so only a restart rebinds it to the new vault (a webview
  reload leaves external-change detection pointed at the old root). →
  `src/lib/platform/tauri/appConfig.ts`, `notesRoot.ts`, SettingsScreen.svelte
- **Sync**: server URL + password inline with a Connect button and a
  "Last sync: …" line ("never" before the first sync). Once connected the
  section shows the locked URL plus **Sync now**, **Forget password**, and
  **Reset connection** (confirmed) — clicking the read-only server URL also
  opens the Reset-connection confirm. When connected without a saved password
  (keyring unavailable or forgotten), a "Vault password — required after
  restart" field appears for on-demand re-entry (see sync.md). →
  SyncSettingsSection.svelte, createSyncSettings.svelte.ts
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
