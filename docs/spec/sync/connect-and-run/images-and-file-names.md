### What syncs: images and file names

- An edit made on one device appears on another device after a sync cycle.
- **Embedded images sync with their notes.** A note's `.md` and the image
  files it references (`is_image_filename`: png/jpg/jpeg/gif/webp/svg/bmp/ico/
  avif/heic) are both scanned, encrypted, and uploaded, so an `![](image-…png)`
  reference is never delivered to a peer pointing at a file that doesn't exist.
  Image binaries ride the SAME object map and note frame as text notes — their
  bytes are base64-encoded into the frame's UTF-8 `content` at read/encrypt
  time and decoded back to disk on apply — so no separate blob protocol or
  wire-format change is needed; the only cost is the base64 expansion inside
  the already-encrypted blob. Because every device mints a unique random image
  filename, two devices never produce a same-name/different-bytes image, so the
  3-way text merge is skipped for blobs (it would corrupt base64) in favor of
  the conflict-copy path, which preserves the image extension. Verified
  desktop↔desktop and into native Android (emulator, file:// vault render),
  2026-06-30. **Regression-guarded** by the `image sync roundtrip`
  cross-platform scenario (full client stack + real server: image binary
  arrives byte-for-byte AND a re-sync does not re-upload it). If you
  re-introduce a `.md`-only scan/filter or a text-only read/write on the blob
  path, that scenario fails. → futo-notes-sync `sync::vault` (base64 read/write
  over the vault descriptor); tests/cross-platform-sync.mjs `imageSyncRoundtrip`
- **The image set has ONE definition (canonical 10: png/jpg/jpeg/gif/webp/svg/
  bmp/ico/avif/heic).** Sync classifies blob-vs-note with
  `futo_notes_core::image::{is_image_filename,is_syncable_filename}` — the same
  set `futo-notes-model` and `@futo-notes/editor` expose, conformance-locked by
  `tests/conformance/image.json`; native pickers receive it through
  `futo-notes-ffi::image_extensions`. (Historically `core::invariants` kept an
  independent 13-entry copy with `.tiff/.tif/.heif`; D4 unified them.) →
  futo-notes-core `image.rs`; tests/conformance/image.json
- **Legacy image blobs (pre-D4 `.tiff/.tif/.heif`, or any non-syncable
  extension) are left untouched, never destroyed or mis-materialized.** The
  shared incoming pull path (`pull::pull_with_checkpoint`, including bootstrap
  with `since = 0`) ignores such a server object — never write it as a note,
  never map it, never count it, never tombstone it, never error the cycle; a
  push never tombstones a non-syncable map entry (the local scan no longer
  surfaces it, so without the guard it would look "deleted locally" and be
  erased on the server and every peer). → futo-notes-sync sync module
- **Every incoming name is screened before it is written, and a name local
  creation legitimately produces is HEALED rather than dropped.** A single
  classifier (`classify_incoming_sync_path`) runs before collision planning for
  both the shared pull path (`pull::pull_with_checkpoint`, including bootstrap
  with `since = 0`) and the edit-wins delete restore:
  (a) a Windows-reserved device name (`CON`), a leading/
  trailing dot, or a trailing space — all of which macOS/Linux creation
  produces but Windows cannot hold — is HEALED to the same safe name
  `sanitize_title` would mint (`CON`→`CON_`, `.env`→`env`, `note.`→`note`),
  written under that name, and NOT reported as a failure (the note is never
  lost); (b) a name that is genuinely unsafe or physically impossible —
  traversal, a component past `NAME_MAX`, excess depth — is
  REJECTED: skipped, never written, surfaced as a permanent `rejected` failure
  (not the retryable `download`), never cursor-capped, never aborting the cycle;
  (c) a name no portable filesystem can hold — one containing `< > : " | ? *` or
  a control character, which macOS/Linux hold happily and Windows cannot — is
  IGNORED: skipped, never written, and deliberately NOT a failure. Such a name
  cannot escape the vault, so refusing it is a portability decision, not a
  safety one; the file is left strictly alone on whichever devices already hold
  it. The only trace is a local journal decision (`ignored` /
  `unportable_incoming_name`), never a user-facing message.
  The sanitizer removes alternating outer dots and whitespace to a fixed point,
  so a dot-space-only component such as `". .. ."` heals to the safe fallback
  `Untitled`, never to `.` or `..`. The traversal screen still runs on the
  HEALED component as well as the raw one as defense in depth. The heal is
  deterministic and idempotent, so two clients pick the same safe name and a
  second sync round does not rename it again. The ONLY
  length rejection is the filesystem's `NAME_MAX` (255 bytes) — the UI title
  budget (`MAX_TITLE_LENGTH`) is deliberately NOT enforced here, so a valid
  201–251-byte file a peer legitimately holds still syncs (the boundary stays
  no stricter than production). → futo-notes-core
  `files::classify_incoming_sync_path` (+ `sanitize_title`,
  `is_windows_reserved_name`, `NAME_MAX`), applied via
  futo-notes-sync sync module; guarded by the core `incoming_*` tests and the
  `incoming_dot_space_components_heal_to_the_safe_fallback` +
  `healed_incoming_paths_are_traversal_free` properties in
  `crates/futo-notes-core/src/files/paths.rs`, plus
  `an_unportable_remote_name_is_ignored_without_a_failure`
- **A local file whose name no portable filesystem can hold is never uploaded,
  and never mistaken for a deletion.** The same classifier screens the push
  side (plus the push-only `\` rule in the next bullet): the file is dropped
  from the upload list and journaled (`ignored` / `unportable_local_name`), with
  no failure and no user-facing signal. It MUST remain in the local scan
  (`local_files`) while it is dropped, because `missing_local_files` reads "in
  the object map, absent from the local scan" as a local delete — filtering it
  out of the scan instead would tombstone the note on the server and every peer.
  A copy uploaded by an older client (push never validated names) is left on the
  server as-is and simply stops receiving updates; it is never deleted. These
  files are also absent from the note list on every shell, because the local
  note scan has always skipped them — the app leaves them strictly alone.
  → futo-notes-sync `sync/push/mod.rs` `uploadable_files`; guarded by
  `an_unportable_name_is_never_uploaded_and_is_journaled_not_failed` +
  `an_unportable_name_is_not_mistaken_for_a_local_delete`
- **The local scan names each file by the path that resolves back to it.** On
  Unix a `\` is an ordinary character inside a filename, so `a\b.md` is
  scanned as `a\b.md`, never as `a/b.md`: that lossy name read another file or
  none, and failing to read it failed every push. Such a file's content is never
  uploaded (a Windows peer would read the `\` as a folder) and is journaled
  like any unportable name, but it stays in the scan, so neither it nor a note
  synced under that name is mistaken for a local delete. Pull still accepts a
  server name holding `\`; for a note already synced under one, local edits
  stay on this device while a local delete still reaches the server. A
  filename that is not UTF-8 has no name: it is left out of the scan and
  journaled (`ignored` / `local_name_not_utf8`), and that can never read as a
  delete, because every synced name is UTF-8. → futo-notes-core
  `files::vault_fs::relative_name`, applied in futo-notes-sync `sync/vault.rs`
  `local_scan` and `sync/push/mod.rs` `uploadable_files`; guarded by
  `a_backslash_filename_is_scanned_as_itself_and_never_uploaded`,
  `a_backslash_filename_is_never_mistaken_for_a_local_delete` +
  `a_non_utf8_filename_is_not_scanned_and_does_not_fail_the_push`
  > **Gap:** _(Windows)_ pull writes a server name holding `\` as folders, so
  > the scan names that file `a/b.md` and reads `a\b.md` as a local delete:
  > the note is re-created as `a/b.md` and tombstoned under its old name. Only
  > a legacy or foreign client can upload such a name.
- **A local path a receiver rejects for excess folder depth or a component
  beyond 255 bytes is never uploaded.** It remains in the local scan so an
  older uploaded copy is not mistaken for a deletion. Each skipped file enters
  `failures` as `rejected`, and the shell names the file. Other valid files in
  the same cycle still sync. → futo-notes-sync `sync/push/mod.rs`
  `uploadable_files`; guarded by
  `local_paths_rejected_by_receivers_are_skipped_and_reported` and the
  `overdeep local path is reported before upload` cross-platform scenario.
- **A healed incoming name is a LOCAL alias, not pushed back to the server.**
  The healing client writes + maps the object under the safe name but does not
  re-upload it, so the server object keeps its original path until someone edits
  it. Until every client runs the healing version, one object can therefore
  display under different names across the fleet (e.g. `CON.md` on an old client,
  `CON_.md` on a healed one) — the CONTENT still converges (same object id, same
  bytes) and no duplicate is created; only the displayed filename differs. →
  futo-notes-sync sync module
