### Case and normalization collisions

- **A pure case-only / NFC-vs-NFD rename keeps its requested form.** Renaming
  `note` → `Note` (or a composed↔decomposed accent) on a
  case/normalization-insensitive filesystem (default APFS on macOS/iOS, NTFS)
  is routed through a hidden temp name (`src` → `.sf-tmp-…` → `dst`) so the
  kernel actually rewrites the stored bytes, and the false uniqueness bump
  (which used to land the rename at `Note-2.md`) is skipped. A byte-identical
  rename is still a fast no-op (F3). → futo-notes-model `crud::rename_note`
  (`collides_but_differs` + `files::rename_through_temp`); regression tests
  `case_only_rename_keeps_requested_case`, `case_only_rename_in_folder_and_move`,
  `rename_through_temp_case_only`
- **Two distinct notes whose filenames collide on a case/normalization-
  insensitive FS no longer lose a note.** On apply (both incremental and
  bootstrap calls to `pull::pull_with_checkpoint`) a path collision is detected
  over the UNION of this pull's downloads, the persisted object_map, and on-disk
  files sharing the collision key (`nfc(name).to_lowercase()`). The object with the
  lexicographically smallest `object_id` keeps the canonical name; every other
  colliding object is materialized as `name (conflict <oid32>).md`, where
  `<oid32>` is the full 32 hexadecimal digits of the loser's UUID object_id. The
  winner key (`object_id`) and the loser name are pure functions of immutable,
  globally-unique inputs that every union member carries — so resolution is
  idempotent (editing the winner can't flip it), convergent (every client mints
  the identical loser name and the fleet lands on `{canonical, name (conflict
<oid32>)}`), and safe even when the rival is already on disk / in the map and
  is NOT in the current incremental batch (F4 same-name; F5 NFC-vs-NFD). →
  futo-notes-sync sync module, futo-notes-core
  `files::collision_key` and
  `conflict_names::collision_conflict_filename`; regression tests
  `three_uuid_v7_name_rivals_keep_all_three_bodies`,
  `collision_destination_already_on_disk_is_never_replaced`,
  `f4_same_filename_two_clients_no_note_lost`,
  `f5_nfc_nfd_collision_no_note_lost`, the `collision_*` unit tests
- Conflict-copy naming remains a fixed point for defensive non-server object-id
  shapes too: a short token that would not be recognizable as the normal
  `<oid32>` form is namespaced as `object-<short>`, and stripping a generated
  suffix that leaves an empty stem substitutes `Untitled`. Re-parking therefore
  replaces one generated suffix rather than stacking suffixes or returning the
  input name unchanged. → futo-notes-core
  `conflict_names::{object_id_short,split_conflict_name_parts}` and its property
  tests
- **The bootstrap pull from cursor 0 never lets local silently overwrite an
  unseen remote.** When a local file diverges from a server object on a fresh
  empty map (no common ancestor ⇒ no safe 3-way merge), the remote is adopted on
  the canonical name and the local edits are parked in a deterministic `name
(conflict <remote-oid32>).md` copy that the next push uploads as its own new
  object — instead of recording a divergence entry that the next push pushed
  over the never-reconciled remote (F6). → futo-notes-sync `sync/mod.rs`
  (`pull::pull_with_checkpoint(state, root, 0, ...)`) +
  `sync/pull/` (`preserve_unmapped_target`)
