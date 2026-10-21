## Vault location & file-manager access

- The vault should be reachable from the OS file browser so users can open, back
  up, and inter-operate with their notes ("file over app"). The Rust core does
  direct `std::fs` path I/O, so SAF / content-URIs are not viable — a
  user-visible vault must be a real filesystem path.
- **Desktop:** the vault is a normal folder (`~/Documents/futo-notes`), always
  browsable; changeable in Settings. Rust resolves the active/default folder
  only through `vault_location.rs`; debug builds retain the separate
  `~/Documents/fake-notes` root. → [desktop-rust.md](../desktop-rust.md) "Vault
  and desktop safety boundaries"
- **iOS:** the vault lives in the app's Documents container
  (`Documents/futo-notes`) and is exposed in the Files app under
  "On My iPhone → FUTO Notes" via `UIFileSharingEnabled` +
  `LSSupportsOpeningDocumentsInPlace`. Sync state / crash logs are dotfiles
  inside the vault, which the Files app hides. Applies to all installs (it only
  reveals the existing folder — no migration). _(iOS)_
- **Android:** storage is chosen on first run (Obsidian-style picker) and is
  switchable later in Settings → Storage. On Android 11+ the picker offers two
  modes and Device storage is the pre-selected recommended default; on API < 30
  it offers only App storage because Device storage depends on All-files access:
  - **Device storage** — `Documents/FUTO Notes` on shared storage: visible in
    the stock Files app + survives uninstall. Needs the "All files access"
    (`MANAGE_EXTERNAL_STORAGE`) permission, requested behind a rationale screen
    shown before the system dialog. Android 11+ only.
  - **App storage** — `Android/data/<pkg>/files/futo-notes`: no permission, but
    invisible to the stock Files app on Android 11+ and deleted on uninstall.
    Switching modes migrates the whole vault (including the `.futo` sync state)
    and relaunches. The switch blocks editor/store writes—including image-picker
    and clipboard image files—and pauses live sync. It refuses to begin while a
    vault write is active, because an image write completes with a later editor
    insertion that must be confirmed by the WebView before the storage gate
    opens; the user can retry after that save finishes. A newly queued save is
    rejected once migration is latched.
    > **Gap:** _(Android)_ the editor stays interactive while a migration is
    > latched, but `acceptsEditorChange` drops every editor change for the
    > duration, so keystrokes typed in that window appear on screen and are never
    > written to the buffer or saved — they are lost when the editor is next
    > re-synced from the store. The drop is deliberate (it is what stops a save
    > racing the staging copy), but the user is given no signal that typing is not
    > being kept. Found by code trace during the github#33 investigation, not by
    > QA; the window is short, and nobody has measured how reachable it is in
    > practice. → EditorSession.kt `acceptsEditorChange`, NoteEditorScreen.kt That same synchronous latch makes an
    Activity `onStop` unable to abort live sync before the migration's graceful
    sync stop completes. Editor navigation captures the latest live editor
    body and persists-or-parks it before leaving the editor; Settings is reached
    only after that navigation commit. A dirty draft retained by an unexpected
    editor disposal is additionally flushed by the store under the migration
    gate before staging. Migration never queries or waits on the detached editor
    WebView. The engine stages the copy, verifies every relative path and file
    digest, fsyncs copied files and directories, and fsyncs the
    destination-parent chain after installation. Before each authority
    transition it records a fsynced, atomically replaced app-private journal.
    `PREPARED` makes the old root authoritative after a crash.
    `FINALIZING` is written before source cleanup. Its versioned journal records
    whether policy forbids removing the source (with backward-compatible V1
    decoding). The destination has already been fully verified at this point, so
    recovery promotes it when cleanup of a removable source was interrupted and
    retains the still-present source as a backup. A source-removal-forbidden
    Device migration instead safely rolls back to its still-present source if
    activation was not durably recorded.
    `ACTIVATED` makes the verified destination authoritative even if the
    SharedPreferences commit result is ambiguous. A late source edit yields
    `DESTINATION_CHANGED`, aborts activation, and keeps the old root visible.
    Because external writers to shared Device storage cannot be fenced, a
    successful switch away from Device storage retains that source as a backup
    after activation instead of deleting it through a check-then-delete window.
    Other cleanup failures may likewise retain the source as a backup. Recovery
    distinguishes a present or proven-absent source from storage that is
    unmounted, permission-denied, or otherwise uninspectable; an unavailable
    source never authorizes destination promotion. A failed copy/verification
    keeps the old mode/root active and reports the failure.
    Every retained draft must first produce a committed mutation or already
    match the bytes on disk; a skipped/missing/divergent flush aborts the switch
    instead of relaunching with an older draft. A non-empty destination is
    accepted only when its complete manifest already matches the source, so an
    unrelated pre-existing vault is never overwritten or cleaned up. An
    existing empty source directory is a valid switch, but a missing or
    non-directory active root is a failure (never interpreted as an empty
    vault). The move is transparent to sync because the object map is keyed by
    relative filename. →
    [sync.md](../sync.md), Android `storage/`, `MainActivity.performSwitch`,
    `NotesStorageTest`, `futo-notes-store::vault_migration`
- **No silent relocation of existing installs.** An Android install that predates
  the picker is grandfathered on its legacy internal location
  (`filesDir/futo-notes`); it gains Files-app access only by opting in via
  Settings (which migrates). An update must never repoint an existing vault out
  from under the user.
- **Dev/prod guard for Device storage:** the public Documents folder is not
  package-scoped, so debug builds use `Documents/FUTO Notes Dev` while release
  uses `Documents/FUTO Notes` (App/Internal modes already isolate via the `.dev`
  applicationId). → [Data safety](data-safety.md#data-safety)

> **Gap:** Android pre-11 (API < 30) devices can't use Device storage (All-files
> access is an API-30 mechanism) — they only get App storage, so their vault is
> not visible in a file manager. _(Android)_

> **Gap:** The vault folder is fixed per mode and not a user-pickable arbitrary
> directory on mobile (desktop allows a custom folder); iOS has no iCloud Drive
> vault option. Both are possible follow-ups. _(iOS / Android)_
