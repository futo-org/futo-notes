## Tauri shell

- Settings is a centered modal dialog with sections: License, Storage,
  Appearance, Language, Sync, Issue reporting, Updates, then Danger zone last,
  and a version footer. Its overlay fully covers and blocks floating editor UI.
  → SettingsScreen.svelte, src/styles/stacking.css (see settings-visual.md for
  the platform-split and shared content model)
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
  `src/lib/platform/tauri/appConfig.ts`, `notesRoot.ts`,
  `src/features/storage/notesDirectory.ts`, `apps/tauri/src-tauri/src/vault_location.rs`
- **Storage chooser:** **Change directory** uses the XDG FileChooser portal on
  Linux, so GNOME and Plasma show their own desktop chooser; macOS and Windows
  keep their native dialog backends. It works in sandboxed (Flatpak) builds too,
  where the chosen
  directory arrives as an XDG document-portal path, which is stored **verbatim**. The
  app registers nothing: the portal already grants a picked directory
  `PERSISTENT | REUSE_EXISTING` with `read,write,grant-permissions`, so the grant
  outlives the process and re-picking the same folder returns the same document id —
  no accumulation, and a stable vault path. →
  `apps/tauri/src-tauri/src/portal_vault.rs`, `vault_location::write_override_file`
- Confirmations are app modals rather than native message boxes, because the
  Linux portal backend has no message-box portal and optional `zenity`/`kdialog`
  helpers cannot be assumed installed. → confirmDialog.ts,
  ConfirmDialogHost.svelte
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
- A picked directory the app cannot use — a folder it cannot create, a folder it
  may not create files in, a refused relaunch — toasts "Could not use that folder."
  rather than leaving the pick to do nothing. Whether files may be created is asked
  of the OS (`access` on Unix, a directory open for `FILE_ADD_FILE` on Windows);
  nothing is written to find out, so Windows Controlled Folder Access, which only
  blocks real writes, passes the pick and locks the vault at its first write
  (docs/qa/windows-controlled-folder-access.md). →
  `src/features/storage/notesDirectory.ts`, `vault_location::ensure_can_create_files_in`
- **A vault that has gone missing** — an unmounted drive, a revoked sandbox grant
  — is a recoverable state, not a wedged app: the root is never recreated in
  place, every note command fails with the vault-unavailable error, and the
  Storage section explains it ("This folder is no longer reachable. Choose it
  again, or reset to the default location.") and keeps both **Change directory**
  and **Reset to default** usable. `isCustom` is read from the vault's _location_,
  never from a successful vault read, so **Reset to default** cannot be hidden by
  the failure it is there to undo. → `vault_location::VAULT_UNAVAILABLE`,
  StorageSettingsSection.svelte
- A **default** folder the app cannot create (e.g. blocked by Windows Controlled
  Folder Access) is unusable in the same way, and the Storage section says "FUTO
  Notes isn't allowed to create this folder, so nothing can be saved. Choose another
  folder. On Windows, this is usually Controlled folder access: you can instead allow
  FUTO Notes in Windows Security, then restart FUTO Notes." with **Change directory**
  usable. Allowing it while the app runs takes effect on that restart: the note
  list and watcher bind the vault only at launch. →
  `vault_location::status_of`, StorageSettingsSection.svelte
- A folder that **exists but refuses writes** (Controlled Folder Access over an
  existing folder, a read-only mount) still lists and reads, so it loads normally.
  It becomes unusable the first time it refuses to let a file or folder be created
  directly in it — a top-level note or folder, a setting, the open tabs, an image;
  nothing probes the vault. A refused create inside a subfolder (one read-only
  folder, a root-owned `.crashlogs`) fails only that write, and a refused rename
  or delete (another process holding the file) or an unreadable file does not
  count. On Windows, "file not found" on such a create counts too: that is how
  Controlled Folder Access answers a blocked create. The Storage section then
  says "FUTO Notes isn't allowed to change this folder, so nothing can be saved.
  Choose another folder. On Windows, this is usually Controlled folder access: you
  can instead allow FUTO Notes in Windows Security, then restart FUTO Notes." →
  `vault_fs::access_refused`, StorageSettingsSection.svelte
- _(Desktop)_ The vault status is read at launch and again whenever a vault command
  fails — a note command or external-file import, a settings, open-tabs or
  crash-log write (a sync cycle ends with one), an image save — so a vault that
  refuses a write or goes missing mid-session is caught at that failure. It only ever turns
  unusable within a launch; every way back is a restart. → `src/features/storage/vaultAvailability.svelte.ts`,
  `onVaultCommandFailed` in `src/lib/platform/tauri/vaultCommands.ts`
- _(Desktop)_ While the vault is unusable (any case above), a banner stays at the
  top of the window for the rest of the launch — "FUTO Notes can't save anything."
  then "It isn't allowed to create its notes folder at {folderPath}." (default
  cannot be created), "It can't find your notes folder at {folderPath}." (custom
  missing) or "It isn't allowed to change your notes folder at {folderPath}."
  (refused a write) — with **Choose another folder**, the same flow as **Change
  directory**. It is never a toast: every edit is locked while it is up, and the
  lock only makes sense next to it. The folder is always named (github#44). →
  VaultUnavailableBanner.svelte
- _(Desktop)_ While the vault is unusable, it is read-only in the UI: notes open
  and read, but the editor body, title and tags take no edits (text typed before
  the lock stays visible in the editor so it can be copied out; leaving the note
  discards it, and the first refused save can hold the user once, before the lock
  lands); **New note** and **New folder**
  are disabled and Cmd/Ctrl+N and the app menu's **New Note** do nothing; every
  folder and note row action (New note, New folder, Rename, Move, Delete) is
  disabled, inline rename and drag-to-move do not start; the note menu's **Move**
  and **Delete** and the Images view's **Delete** are disabled. **Copy file path**
  stays. → NoteWorkspace.svelte, `src/app/createNewNote.ts`,
  `createSidebarFolderWorkflows.svelte.ts`, FolderTreeFolderRow.svelte,
  FolderTreeNoteRow.svelte
- A setting that cannot be saved — the Settings toggles, Sync's **Reset
  connection** and **Forget password**, the crash dialog's **Don't Send** — still
  applies for the session and toasts "Setting changed, but it couldn't be saved."
  (a language: "Language changed, but the preference could not be saved.") instead
  of surfacing as a crash. The crash dialog still sends the reports the user chose
  to send; an unsaved "Send crashes automatically" only means the dialog asks again
  next time. → `savePreferences` in `src/shared/state/appState.ts`,
  SettingsScreen.svelte, `createSyncSettings.svelte.ts`, `createCrashReporting.svelte.ts`
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
- **Sync, with hosted sync built in**: a debug build (or one made with
  `VITE_HOSTED_SYNC=true`) replaces that section with the hosted wizard —
  "Log in with FUTO", the subscribe / vault-password / recovery-key / unlock
  steps, the account card, and the two refused-write banners — and discloses the
  self-hosted section above behind **"Use my own server"**. The disclosed panel
  is that same component, so what a self-hoster sees is identical either way.
  With the flag off nothing about this section changes. Behavior is specified
  once, in [sync.md](../sync.md) "Hosted sync". → HostedSyncSettingsSection.svelte,
  createHostedSyncSettings.svelte.ts, `hostedSyncEnabled.ts`
- **Language**: a System-first dropdown applies the language immediately and
  persists it locally. System is resolved at launch and foreground entry; save
  failure and removed-language behavior follow
  [localization.md](../localization.md). → `desktopLocalization.svelte.ts`,
  `LanguageSettingsSection.svelte`, `createAppBootstrap.svelte.ts`
- **Issue reporting**: a "Share crash reports" toggle (anonymous crash logs), a
  nested **"Send crashes automatically"** option, and a **"Send feedback"** row
  that discloses the feedback form inside the same card: its chevron turns
  down, the form appears below the row, and clicking the row again collapses it
  (there is no Cancel button); see app.md for the crash dialog flow, and
  "Feedback" below for the form. → IssueReportingSettingsSection.svelte,
  FeedbackForm.svelte, tests/issue-reporting-settings.spec.ts
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
  `app_self_update_supported`, [desktop-rust.md](../desktop-rust.md)
- **Danger zone — Full reset**: permanently removes all notes and app data.
  Tapping **Full reset** opens a confirmation dialog ("Permanently delete all
  notes and app data? This cannot be undone."); only confirming deletes, with
  a blocking "Deleting all notes…" overlay, then reloads. Live sync is stopped
  and the E2EE connection + stored password are dropped before the vault is
  wiped, so a racing sync cannot push the wipe or resurrect files. The native
  shells implement the same contract (see "Native shells" above). →
  SettingsScreen.svelte (`confirmDialog`), app/resetAllNotes.ts `resetAllNotes`,
  notes.svelte.ts `deleteAllNotes`
