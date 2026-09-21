# AGENTS.md — futo-notes-ffi

The UniFFI facade: the single seam between the shared Rust engine and the native iOS and Android
shells. UniFFI generates Swift and Kotlin bindings from the types exported here, so **this crate's
public surface is the mobile API contract**. Desktop does not use it — Tauri calls the crates
directly.

It is a projection, not a layer with opinions. `src/notes/rules.rs` forwards to `futo-notes-model`,
`src/notes/store.rs` wraps `futo-notes-store`, `src/sync/client.rs` wraps `futo-notes-sync`. If you find
yourself writing a decision here, it belongs in one of those crates.

## Layout

- **`src/notes/contract.rs`** and **`src/sync/contract.rs`**: the wire types and the error enums crossing
  the boundary.
- **`src/notes/rules.rs`**: deterministic note rules, thin forwarders to `futo-notes-model`.
- **`src/notes/store.rs`**: `NoteStore` — the vault workflows.
- **`src/sync/client.rs`**, **`src/sync/events.rs`**: `SyncClient`, `SyncEventListener`, status and summary
  types.
- **`src/localization.rs`**: ICU language-tag maximization and plural category, so the native catalogs
  pluralize the same way everywhere.
- **`src/bin/uniffi-bindgen.rs`**: the bundled binding generator the build scripts invoke.

## Traps

- **Errors crossing the boundary are `uniffi::Error` enums** — `NoteError` and `SyncError` — never
  a bare `String` that a shell has to parse. Non-fatal validation results are the other pattern:
  `validate_title` returns `Vec<TitleIssue>`, a `uniffi::Record`, because a title with problems is
  an answer rather than a failure.
- **FFI builds use the `release-ffi` profile.** Plain `release` sets `panic = "abort"`, which breaks
  UniFFI's unwinding across the boundary, and strips the symbols Play needs. `release-ffi` inherits
  release with `panic = "unwind"` and `strip = "none"`.
- **The bindings are generated and gitignored** — Swift into `apps/ios/Sources/Generated/` plus
  `FutoNotesFfi.xcframework`, Kotlin into `apps/android/app/src/main/java/uniffi/` plus the per-ABI
  `.so` in `jniLibs/`. Never hand-edit them and never commit them (AGENTS.md M8/M16).
- **Stale bindings lie.** Any change here means rebuilding before native testing:
  `just build-rust-ios` / `just build-rust-android`. `just ios-native` and `just android-native` do
  it for you; opening Xcode or Gradle directly does not (AGENTS.md M9). On macOS an APFS-cloned
  `target/` can hand cargo pre-branch artifacts — zero "Compiling" lines on a branch that touched a
  crate is the tell.
- **No search or ML dependencies.** `scripts/check-rust-dependency-boundaries.mjs` fails if
  `futo-notes-inference`, `ort`, or `ort-sys` reach this crate's shipped tree. It runs only in CI's
  Rust workspace job — no `just check` fires it — so run it by hand after touching a `Cargo.toml`.
- **A new capability needs both shells.** Exporting a function that only Swift or only Kotlin calls
  leaves the other platform silently behind (the shell-side version of AGENTS.md M10).

## Verification (required)

```bash
cargo test -p futo-notes-ffi      # the contract tests in tests/
just build-rust-ios               # regenerates the Swift bindings + xcframework
just build-rust-android           # regenerates the Kotlin bindings + jniLibs
```

`tests/note_contract.rs` and `tests/sync_contract.rs` assert that the exported functions stay thin
projections of the canonical crates — a rule reimplemented here fails them.
`tests/open_note_flush.rs` is the one that composes `classify_open_note` with
`NoteStore::flush_draft` on a real vault: both verbs are exhaustively tested in their own crates,
and issue #89 lived in the gap between them, where the verdict handed back pulled disk content as
the new baseline and turned the flush's park arm into a fast-forward write that destroyed a peer's
edit. Anything touching the open-or-flush path belongs in that file. Then run the owning
shell's chain: `apps/ios/AGENTS.md` or `apps/android/AGENTS.md`.
