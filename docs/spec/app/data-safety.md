## Data safety

- Dev/debug builds must never overwrite the production app or notes: a distinct
  bundle id (`com.futo.notes.dev`) and a distinct notes root
  (`~/Documents/fake-notes` on desktop). → AGENTS.md M3,
  `apps/tauri/src-tauri/src/vault_location.rs`
- Production native mobile builds use the production package/bundle id
  `com.futo.notes`; native debug builds use `com.futo.notes.dev` so local
  installs keep separate app data and credentials.
- Creating a note never replaces an existing file: the vault installs it through
  an atomic no-replace primitive — a hard link, else a `RENAME_NOREPLACE` rename.
  A filesystem that supports neither, such as Android 9/10 shared storage
  (sdcardfs), falls back to an exclusive create plus copy, which still refuses to
  replace but is not atomic, so a crash mid-create can leave a truncated new
  note. → `futo_notes_core::files::atomic_write::move_no_replace`
