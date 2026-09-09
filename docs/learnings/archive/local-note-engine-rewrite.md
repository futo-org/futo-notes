# Local note engine rewrite

Historical rewrite lessons. Current behavior and ownership are defined by `docs/spec/` and
the implementation. Follow-ups below describe the state at the end of this rewrite, not a
current issue inventory. The original accounting and execution log are available with:

```bash
git show 3b1c43c139181b91b7384b478b5edec454b80190:docs/learnings/archive/local-note-engine-rewrite.md
```

## Behavioral cut line

### Preserve

- The vault is a visible tree of durable Markdown files: a note ID is its relative path without the final lowercase `.md`; the filename leaf is the title verbatim.
- Atomic content replacement, exact bytes, modification-time semantics, safe relative paths, collision suffixing, case/Unicode-only renames, conditional background flushes, hidden-file exclusion, and non-destructive folder deletion.
- Folder rename/move and note rename/move rewrite resolvable wikilinks without touching ambiguous aliases; failures never delete notes that did not move.
- First-run welcome seeding, one-way `.txt` migration, Android vault-location migration, dev/prod root isolation, and full-reset ordering.
- Immediate shell render, background indexing, on-device BM25 behavior, empty-query/recent-note behavior, durable external-edit pickup, desktop trash recovery, and the current Swift/Kotlin list semantics.
- Existing browser, Rust, Android, iOS-build, conformance, and cross-platform shell gates as the acceptance boundary.

### Replace and delete

- Free-function note CRUD spread across `futo-notes-core::files` and `futo-notes-model::crud`, plus shell-owned relink/mutation sequences.
- The parallel Tauri note/folder/search command owners and `legacy_filesystem_commands.rs` compatibility surface.
- Note I/O inside the general TypeScript `PlatformFS`, the `fileSystem.ts` forwarding layer, TS-owned `.txt` migration, MiniSearch persistence/fallback coordination, and per-call search notifications.
- Independent FFI `NoteStore` and `SearchEngine` lifecycles and the duplicated Swift/Kotlin mutation/index/reload choreography.
- Internal tests that assert those private layers, callback orders, fallback selection, mocks, or command shapes.

### New ownership model

- `futo-notes-core::files`: small durable-file primitives and hostile-path rejection needed by local storage and the untouched sync consumer.
- `futo-notes-model`: pure filename, tag, preview, image, and wikilink decisions only.
- One shared Rust local-note store: owns vault bootstrap/migrations, snapshots, CRUD/folder transactions, relinking, modification results, and the single search index lifecycle.
- Tauri and UniFFI: transport projections of that store. The desktop projection adds OS trash and watcher event delivery; Swift/Kotlin/TypeScript own only reactive presentation state and background-thread hops.
- Recovery boundary: each mutation computes affected paths first, publishes a pre-write hook for desktop watcher suppression, performs atomic/recoverable disk work, updates the index once, and returns one canonical mutation result to every shell.


## Safety invariants

- No user-controlled path can escape the vault, name the vault root for deletion, exceed the shared depth/name limits, or create a cross-platform-illegal path.
- A content write either replaces the target atomically or leaves the previous bytes recoverable; temporary files never become visible notes.
- Rename collision handling never overwrites a distinct file, including case-only and Unicode-normalization collisions on case-sensitive hosts.
- Conditional flush never resurrects an already-missing note and never overwrites content that changed after the editor snapshot.
- Folder deletion removes the directory only after every contained note has moved and its resolvable backlinks have been rewritten.
- Watcher suppression is registered before mutation, is one-shot, and consumes both sides of a rename atomically.
- Search is never an independent source of truth: startup reconciliation and every committed mutation derive it from the Markdown tree.
- Debug builds and storage migrations never silently repoint or overwrite a production vault.


## Follow-up queue

- Add an explicit crash/fault-injection seam for failures between collision parking, final rename, and backup cleanup; do not claim crash-window closure from happy-path atomic-write tests.
- Replace ignored size/performance probes with a repeatable 5k-note scan/reconcile benchmark after the new owner exists.
- Add a native iOS test target for note-store projection behavior; until then, Rust contracts plus a full Swift build and simulator smoke are the executable evidence.
- Keep sync-specific ingress healing and object-map behavior in the sync rewrite ledger; this rewrite may preserve the `futo-notes-core::files` callable contract for that consumer but will not change sync policy.
