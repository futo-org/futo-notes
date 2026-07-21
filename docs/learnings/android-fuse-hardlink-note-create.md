# Android FUSE storage rejects `hard_link` — note creation was silently broken

## Symptom

On Android, creating a new note (FAB) and moving a note into a folder failed
with `NoteException.Io: Permission denied (os error 13)`. No error toast
surfaced. On a fresh install the built-in first-run "Welcome" note seed hits the
same path, so a new Android user could land in an empty app with no way to
create their first note. Editing an existing note worked.

Surfaced 2026-07-20 by the first native-Android QA pass that exercised note
creation on a real device filesystem. Desktop (ext4/APFS), iOS (APFS), and the
Rust unit tests (ext4) all structurally could not see it — they support hard
links. Confirmed on the emulator in both storage modes (`Android/data/<pkg>/…`
and public `Documents/…`), both FUSE-backed (`/dev/fuse on /storage/emulated`).

## Root cause

The atomic no-replace file install used `fs::hard_link(source, destination)`.
Hard linking is a genuinely good primitive here: it is atomic, fails with
`EEXIST` instead of clobbering (that is how collision allocation detects a taken
name), and shares the inode so mtime carries across. But Android's FUSE-mediated
external storage rejects `link()` outright with `EPERM`, while `rename()` on the
same path succeeds. Editing worked because the replace path
(`install_temp`) already used `rename`, not `hard_link`.

Four sites shared the pattern: `create_new_atomic` (note create),
`futo-notes-store` move and recovered-note install, and parked-backup recovery.

## Fix

One shared primitive, `futo_notes_core::files::move_no_replace`, keeps the
`hard_link` fast path and falls back — only when `link` actually fails — to
an atomic no-replace rename (`RENAME_NOREPLACE` on Android/Linux and
`RENAME_EXCL` on Apple). The rename either moves the completed source or reports
that the destination exists; there is no check-then-replace window and no empty
placeholder for a scan or crash to observe. All four sites call it, which also
removed the duplicated "undo the link if dropping the source fails" rollback
that had been copy-pasted at each site.

## Guard against recurrence

- Never assume POSIX file primitives behave uniformly on Android's FUSE
  emulated storage. `link` is the known casualty; verify any new reliance on
  `flock`, `O_TMPFILE`, or reflink there too.
- File-op logic that must work on all three shells needs at least one pass on a
  real Android device filesystem — host `cargo test` on ext4/APFS is not
  sufficient coverage for the storage layer.
