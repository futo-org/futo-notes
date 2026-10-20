### Sync state and vault identity

- The persisted sync state (`.e2ee-state.json`) is tagged with the server
  collection it describes; connecting to a **different** collection (vault
  reset, account recreation, server wipe) resets the cursor + object map and
  re-reconciles from scratch. Without this, the stale `max_version` can sit
  beyond the new collection's head and every pull silently comes back empty —
  the client never sees remote changes again (observed 2026-06-04 on all three
  clients). Untagged pre-existing `.e2ee-state.json` files are UNKNOWN
  provenance and reset the same way — trusting them once (the
  original behavior) re-persisted a possibly-stale cursor tagged with the new
  collection, permanently burying the corruption for exactly the cohort the
  tag was meant to heal; a stale object map is equally bad on the push side
  (entries claiming the server holds a note make the push skip it). The reset
  costs one bootstrap pull from cursor 0, which hash-dedups
  against local files. → futo-notes-sync `checkpoint.rs`
- The one-time legacy import of a pre-port `.app-state.json` object map is
  TAGGED with the vault's `e2eeCollectionId` (written next to the map in the
  same file), so reconnecting to that same collection KEEPS the imported map
  instead of resetting it — a note edited offline before the port lands as a
  clean update to its existing object (same object_id, PUT at the next
  version) rather than a conflict copy or a re-POSTed duplicate. Importing
  then connecting to a _different_ collection still resets, and an older
  pre-port file that predates `e2eeCollectionId` carries no tag and resets as
  UNKNOWN provenance (the bootstrap pull from cursor 0 then hash-dedups). →
  futo-notes-sync `checkpoint.rs`
- **Clients use one canonical vault (collection) per account even though the
  server preserves plural collection rows.** The server must retain every
  pre-existing collection during upgrades — deleting extras would destroy
  opaque user data — so `POST /api/collections` may create independent rows.
  On connect, the client selects the earliest collection (creation time, then
  id); when the list is empty it creates a row and then **re-lists before
  claiming key material**. Two devices connecting concurrently therefore both
  converge on the earliest row instead of each claiming the row its own POST
  returned. Key material remains first-write-wins: a racing `PUT …/key` 409
  makes the loser fetch and adopt the authoritative key. Extra empty rows from
  a setup race remain harmless and are never selected while an earlier vault
  exists. This prevents the silent split-brain reproduced by
  `concurrent_connect_converges_to_one_vault` without a destructive server
  migration. → futo-notes-sync `session/connect.rs`; futo-notes-server
  `collections/routes.ts`, `db/migrations/009_restore_plural_collections.ts`
- **Clients re-point to the surviving vault automatically — cold start AND while
  running.** The client adopts the authoritative key the server returns from
  `PUT …/key` (so concurrent connects converge on one key, not just one
  collection id). A client pinned to a collapsed/deleted vault heals: the server
  signals a gone vault with **404**, which the client maps to
  `SyncErrorKind::CollectionGone` (message prefixed `collection-gone:`).
  - **Cold start:** native re-picks the vault on every `connect()` (it has no
    `resume()`); desktop `resume()` surfaces `CollectionGone`, which
    `ensureConnected` catches to fall back to `connectE2ee`.
  - **Already running:** the active-session pull path
    (`pull::pull_with_checkpoint`, including bootstrap with `since = 0`) surfaces
    `CollectionGone`, and the shared **live loop
    stops (terminal)** instead of spinning against the dead vault. Desktop's
    `syncE2eeAuto` catches it and re-points (`stopLiveSync` → `connectE2ee`);
    native `SyncManager` catches it — the typed `SyncError.CollectionGone` from
    `sync_now`, or the `collection-gone` string from the live loop's `on_error` —
    and re-runs `connectAndSync`.

  After re-pointing, the reset→reconcile→push re-uploads local notes to the
  survivor — no data loss for anything a device still holds. → futo-notes-sync
  `SyncSession` (terminal live error on collection-gone); syncServiceE2ee
  `{ensureConnected,syncE2eeAuto}`; SyncManager.{swift,kt} `healSession`

- Moving the whole vault folder to a new location (e.g. the Android Device/App
  storage switch → [app.md](../../app.md) "Vault location") is transparent to sync:
  the object map is keyed by **relative** filename (not absolute path) and the
  `.e2ee-state.json` travels inside the vault, so the session picks up at
  the new root with no re-upload — provided the move carries the dotfiles.
  Android storage migration synchronously closes a session-operation gate, then
  drains credential restore/heal, connect, manual sync, and live-resume work
  before gracefully cancelling and joining the live task and awaiting the Rust
  session's cycle gate. It never aborts an in-flight cycle before that cycle
  installs its advanced in-memory/checkpoint state. It then takes the store's
  exclusive vault gate, so sync/editor/store/image writes cannot race the staged
  copy and manifest verification. →
  `SyncSession::stop_live_and_wait`, `SyncManager.quiesceForStorageMigration`,
  `NotesStore.migrateVault`, Android `storage/StorageMigrationGateTest`
