# Text-first editor: shared-core acceptance and renderer handoff

Milestone [#283](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/283), handoff
issue #317. For desktop (portable WASM under a text view of the renderer's choice — CodeMirror 6
or a custom view; both are fine), Android (Kotlin) and iPhone (Swift) renderer owners. The shared Rust engine owns Markdown source, interpretation, editing,
selection affinity and in-session history; Store owns identity and debounced markdown saves (no recovery log).
Renderers hold display text only and draw the engine's descriptions. **Shipping renderers,
defaults, bridge schemas, AppState and sync are unchanged.** The portable-core specs in
`docs/spec/editor/portable-core/` are the behavioral authority; this file is the map.
Source/evidence attribution: [MR !558](https://gitlab.futo.org/futo-notes/futo-notes/-/merge_requests/558).

For the current Linedown projection, client readiness and adoption steps, see
[editor engine adoption](editor-engine-adoption.md).

Not renderer, IME, physical-keyboard or cutover acceptance: transport tests do not
establish renderer usability.

## 1. Behavior and evidence

The [portable-core specs](../spec/editor/portable-core.md) describe each behavior and link
its implementation and tests. Literal command cases live in
`crates/futo-notes-editor/tests/fixtures/engine/` and are exercised by the Rust engine;
compiled WASM consumers replay the block, fence and list fixtures through a real store
worker. Native FFI contract tests live in `crates/futo-notes-ffi/tests/`. These tests do
not establish renderer, IME, physical-keyboard or cutover acceptance.

## 2. Host contract

Three layers, same semantics:

- **Portable (desktop):** `PortableSession` (`src/portable.rs`), exposed as `WasmSession`
  (`src/wasm.rs`, `src/wasm/`). The page applies each edit at once and returns it with an
  ordered `HostRequest` (`Append`, `Resume`); the host sends requests to a separate worker
  that owns the real Store (`crates/futo-notes-store/src/editor_session/portable.rs`) and
  answers with `HostAck`. The page never waits for an ack.
- **Native (Android/iPhone):** `NativeEditorSession` (`crates/futo-notes-ffi/src/editor/`),
  generated to Swift/Kotlin through UniFFI. It retains the opening Store for its lifetime
  and serializes calls on one attachment. `detach` checkpoints the Markdown before releasing.
- **Engine (Rust embedders, tests):** `EditorSession` and friends re-exported from
  `crates/futo-notes-editor/src/lib.rs`.

Public surface (portable/WASM names; FFI mirrors the input `_utf16` calls with typed errors): input
`replace`, `replace_utf16`, `replace_many_utf16`, `replace_os_utf16`, `compose_utf16`,
`commit_composition_utf16`, `cancel_composition`, `undo`, `redo`; structure
`block_command_utf16`, `paragraph_key_utf16`; tables `inspect_table`, `table_command`,
`table_key` (`inspect_table_utf16` and `table_command_utf16` for UTF-16 ranges); view `project`,
`select_with_affinity`, `toggle_format`, `active_formats`; clipboard `copy_markdown`,
`cut_markdown`, `paste_markdown`; `inspect_link`, `set_link`, `edit_link`; `update_note_ids` (native
`refresh_note_ids`), `wikilink_completion`, `accept_wikilink_completion`; `image_claim`,
`insert_image`; `tags`, `header_tags`, `add_header_tag`, `remove_header_tag`; the
[find API](../spec/editor/portable-core/find.md); portable page `status`, `resume`,
`acknowledge`, `draft_text`, `apply_relink_offer`; Store and native saving `save_status`,
`save_delay`, `save_if_due`, `checkpoint`, `take_coordinated_changes`.

Projection blocks carry list `indent`, `level`, literal `marker`, `ordered`, `checked` and
`first`, plus optional code `language`. Native style plans carry `ListRow` with its marker
kind and literal `text`, including `Plain`, and `Tag` spans. See the
[adoption guide](editor-engine-adoption.md#projection-changes-clients-must-consume) for the
field meanings and the current source definitions.

**Coordinates.** Source offsets are UTF-8 bytes and are not editing coordinates. Display
coordinates are UTF-8 bytes; the explicitly named UTF-16 entry points accept platform units.
Native input carries exact UTF-16 units (malformed included) with checked
fixed-width ranges, rejecting oversized values on 32-bit runtimes. Portable/WASM table and
find `*_utf16` variants take native units for input; FFI table, find, clipboard, completion
and link calls take byte ranges, so native hosts convert with `utf16_to_display`; results
stay byte ranges, converted with `display_to_utf16`. Reject surrogate splits. A replacement
addresses the old display; its returned selection addresses the new one. Ranges carry no
anchor/focus direction; the adapter owns direction and history policy.

**Revisions.** Every edit, selection, projection and find call names the revision it
addresses; a stale one returns `StaleRevision` and changes nothing. Apply returned
`ViewChange` values (semantic replacements, correspondence, selection, affinity) together, once.

**Correspondence.** A projection's `correspondence` is runs in display and source order that
tile both spaces: `{source, display, kind}`. `Literal` runs have equal lengths and map byte
for byte (offset arithmetic; adjacent literal stretches are one run); `Hidden` runs have an
empty display range (markers, hidden syntax); `Replaced` runs are one indivisible piece shown
as other text (such as a divider glyph) whose interior maps only to its whole source range,
even when lengths match. `Correspondence::source_bounds`/`display_at` do the mapping; where
pieces meet at one display offset, `source_at` chooses the caret.

**Request and reply semantics.** The portable page applies every edit to its own engine
and shows it at once; the returned `HostRequest` carries a session token and the next
monotonic sequence, and any number may be outstanding. A reply binds to exactly one request;
duplicate, old-incarnation and unknown replies change nothing. A successful reply advances
`accepted` and releases no view change (the page already shows the edit); an impossible
revision is `InvalidAcknowledgement`. An error reply pauses the page: input is refused
(`Paused`), while projection, queries and copy stay available, so the draft is always
copyable. `resume` asks the worker for its state; its reply returns the outstanding requests
the worker lacks, renumbered after the resume and in order. A failed engine call (stale
revision, invalid range) changes nothing and issues no request.

**Errors.** `HostAck.error` is `{kind, message}`: `kind` is `Deleted`, `StaleToken` or
`Rejected` (branch on it; `message` is for logs). Structured values: editor kinds (`StaleRevision`, `StaleClaim`, `InvalidText`,
`CompositionActive`, `ReplayMismatch`) and checkpoint mutations. A failed save does not pause input;
the draft stays copyable and the save retries.

**Ids and lifetimes.** Opening a session binds one note and vault guard. Rename/move
retargets the live session; a committed delete terminates it (late input, saves, resume
and cached requests cannot revive it). Image claims and find scans name their session
incarnation and go stale (`StaleClaim`, rejected scan) if the note is reopened. Stale attachments reject every call.

## 3. Threading and lifetime guide

- **Store and FFI calls block.** Native: call on the I/O worker, never the UI thread.
  Desktop: the Store worker does all filesystem I/O.
- **Display first, stream requests.** The page applies the edit and shows it at once, then
  sends its request to the worker without waiting; the worker replays requests in sequence
  order and takes only the attachment lock, so a save or rename on the worker never delays
  typing. Send requests in order (walkthrough 1, 2).
- **Save scheduling.** An edit sets the 500 ms idle and 2 s max-wait deadlines before the
  engine applies. Schedule with `save_delay()` (optional Store-clock duration:
  none = nothing pending, zero = due); never compare a raw deadline to a platform clock.
- **Find scans** run anywhere: take `find_scan_request` after input settles (carries
  incarnation, revision, generation, text, soft breaks, table `barriers`), run `FindScanRequest.run()`
  in Rust, native `editor_find_scan`, or WASM `find_scan` on any worker/thread, then
  `find_apply_scan` on the session
  thread. A result for another session incarnation, revision or query generation, or after
  close, is rejected with no state change. Typing never triggers a scan.
- **Note ids.** The Store delivers vault ids to a live session on open (call
  `refresh_note_ids` only on later vault changes); delivery never
  changes source, selection, history or a composition.
- **Composition conventions:**

  | Command                      | While composing                   |
  | ---------------------------- | --------------------------------- |
  | `paste_markdown`, tag edits  | staged until the composition ends |
  | `table_key`, `table_command` | `CompositionActive`               |
  | `find_step`                  | no-op                             |

- **Sessions are single-owner.** Native calls serialize through the attachment lock; do
  not share a portable session across threads.

### Desktop host commands

`editor_open`, `editor_request`, `editor_checkpoint`, `editor_close`, `editor_note_ids` and
the `editor:saved` event (`apps/tauri/src-tauri/src/editor_host.rs`) relay the page's
requests to a worker-owned Store host; see
[text-first-editor-desktop-host.md](text-first-editor-desktop-host.md).

## 4. Compatibility

- No recovery log: nothing writes or reads `.futo-editor-recovery` (dropped 2026-11-02, maintainer decision; ADR-0012).
- No change to bridge schemas, AppState, sync or shipping defaults.
- Persistent Undo across reopening is not included.
- Shared crates `futo-notes-tags` and `futo-notes-image` were split out for wasm32 and
  re-export from their old paths. The `markdown` crate is gone from the engine (its
  `to_mdast` can panic). WASM test builds enable `test-clock`
  (`scripts/test-editor-wasm.mjs`); never ship with it.

## 5. Renderer responsibilities (engine deliberately leaves these to hosts)

Check each off in your renderer; the engine supplies data, not pixels.

- [ ] Wikilink labels: draw the resolved label over the `[[...]]` source display range as
      a caret-proof atom; keep the caret outside it. Display text keeps source spelling.
- [ ] Image and divider atoms: render, resolve a platform URL for vault images (display
      only), caret stops only before/after, delete through ordinary input. Picker, asset
      writing and decoding stay with existing infrastructure.
- [ ] Front matter panel from the block description's `metadata` flag (selection inside
      snaps to the body start). HTML and footnote-looking lines are ordinary text under
      Linedown; see [foreign content](../spec/editor/portable-core/foreign-content.md).
- [ ] Find bar, highlight painting and the localized "N of M" label from `FindReport`;
      reveal the returned range; `stale` until a scan lands.
- [ ] Completion menu UI, selection and dismissal memory (Escape for the same run).
- [ ] Tables: draw the grid, drive `table_key`/`table_command`; do not route cell input
      specially; table cells hold one line and Shift+Enter acts as Enter. Tables in containers
      show as ordinary text. See the [table spec](../spec/editor/portable-core/tables.md).
- [ ] Caret, selection direction/history policy, IME/composition adapter (see #294).
- [ ] Copyable-failure UI: Copy Draft, labelled precisely (candidate vs accepted source).

## 6. Verification at handoff

CI runs `cargo test -p futo-notes-editor -p futo-notes-store -p futo-notes-core`,
`node scripts/test-editor-wasm.mjs` (blocking in `ci/test-rust.yml`, also in the release
gate), FFI tests in `crates/futo-notes-ffi/tests/`, and the Swift/Kotlin contract-surface
tests in the iOS and Android test trees. These are integration checks, not renderer acceptance;
consult the client adoption guide and
the current test results for each renderer.

## 7. Deferred (open issues, not accepted capabilities)

- **#303 rich HTML paste** and **#311 rendered block movement** (maintainer, 2026-10-30);
  issues stay open. Plain/Markdown paste (#302) and single-cell table paste are accepted.
- Table alignment commands, row/column reordering, multi-cell/grid paste; tables inside
  containers. Existing alignment and untouched table bytes stay exact.
- **#294** device dictation, correction and crash work: parked; physical IME unproven.
- Physical iPhone latency measurement (follow-up to #316).
- Renderer integration, UI, cutovers and later parallel hardening belong to renderer owners.

## 8. Work and latency limits

The current [long-region spec](../spec/editor/portable-core/long-regions.md) and its tests
state the engine's locality and correctness bounds. Structure-changing edits can re-read a
larger region; a renderer must not assume every command has constant cost. Counted work is
not device latency. Run the current native performance and interaction checks before a
renderer cutover; transport tests alone do not establish physical-device behavior.

## Appendix: adapter walkthrough

Five scenarios that challenge the adapter contract (streamed requests, composition during
streaming, coordinate changes, copyable failure, worker responsiveness) are in
[text-first-editor-host-walkthrough.md](text-first-editor-host-walkthrough.md).
