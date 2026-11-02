# Text-first editor: shared-core acceptance and renderer handoff

Milestone [#283](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/283), handoff
issue #317. For desktop (CodeMirror 6 + portable WASM), Android (Kotlin) and iPhone (Swift)
renderer owners. The shared Rust engine owns Markdown source, interpretation, editing,
selection affinity and in-session history; Store owns recovery, identity and saves.
Renderers hold display text only and draw the engine's descriptions. **Shipping renderers,
defaults, bridge schemas, AppState and sync are unchanged.** The portable-core specs in
`docs/spec/editor/portable-core/` are the behavioral authority; this file is the map.
Source/evidence attribution: [MR !558](https://gitlab.futo.org/futo-notes/futo-notes/-/merge_requests/558).

Not renderer, IME, physical-keyboard or cutover acceptance: transport tests do not
establish renderer usability.

## 1. Story to evidence map

Specs: `docs/spec/editor/portable-core/`. Tests: `crates/futo-notes-editor/tests/` (E,
with `.mjs` consumers), `crates/futo-notes-store/src/tests/editor_session/` (S),
`crates/futo-notes-ffi/tests/` (F). Parent stories 55-60 map to sections 2-3 and the
#290, #291 and #315 rows.

| Issue | Capability | Spec | Main test |
|---|---|---|---|
| #284 | Edit, save, recover a plain note | interpretation-and-input | E `plain_note.rs`, `unicode.rs` (#289 Unicode, selections) |
| #285 | Storage failure / power loss protection | recovery | S `durability.rs`, `storage.rs` |
| #286 | Torn, invalid, incompatible logs | recovery | S `recovery/` |
| #287 | Crash-then-sync/restore drafts | recovery | S `recovery/outside_writes.rs` |
| #288 | Identity change, delete, exit safety | recovery | S `lifecycle.rs`, `lifecycle_crashes/` |
| #290 | Swift/Kotlin first session | transports | F `editor_contract.rs` |
| #291 | WASM session + host recovery handshake | transports | E `portable.rs`, `wasm-consumer.mjs` |
| #292 | Inline formatting, hidden markers | interpretation-and-input | E `inline.rs` |
| #293 | Exact history grouping | interpretation-and-input | E `history.rs` |
| #294 | Composition/correction/OS replacement | interpretation-and-input | E `composition.rs`, `native_input_traces.rs` (software only; **parked**, see 7) |
| #295, #296 | Paragraphs; headings, quotes, dividers | interpretation-and-input | E `paragraphs.rs`, `blocks.rs` |
| #297 | Fenced code | fenced-code | E `fences.rs` |
| #298 | Lists and tasks | lists | E `lists.rs` |
| #299 | Nested list/quote containers | lists | E `lists/containers.rs`, `lists/mixed_commands.rs`, `wasm-list-consumer.mjs` |
| #300 | Front matter, HTML, footnotes | foreign-content | E `foreign.rs` |
| #301 | Links and autolinks | links | E `links.rs`, S `links/` |
| #302 | Plain copy, cut, paste | clipboard | E `clipboard.rs`, F `editor_clipboard.rs` |
| #304 | Body and header tags | tags | E `tags.rs`, S `tags.rs` |
| #305 | Wikilink roles, note-id delivery | wikilinks | E `wikilinks.rs`, `wasm-wikilink-consumer.mjs` |
| #306 | Wikilink completion | wikilinks | E `wikilink_completion.rs`, F `editor_links.rs` |
| #307 | Image and divider atoms, claims | images | E `images.rs`, `wasm-image-consumer.mjs`, F `editor_links.rs` |
| #308-#310 | Table cells, rows/cols, single-cell paste | tables | E `tables.rs`, `wasm-table-consumer.mjs`, F `editor_tables.rs` |
| #312 | Find, off-thread scans | find | E `find.rs`, `find/wasm-find-consumer.mjs` |
| #313, #314 | Reinterpretation correctness, long-region locality | long-regions | E `long_regions.rs`, `reinterpretation.rs`; see 8 |
| #315 | Native + WASM consumers | transports | `apps/ios/Tests/Editor/NativeEditorContractSurfaceTests.swift`, `apps/android/app/src/androidTest/java/com/futo/notes/editor/NativeEditorContractSurfaceTest.kt`, `scripts/test-editor-wasm.mjs`, F `editor_*.rs` |
| #316 | Latency and durability | remaining-work | reconnaissance budgets and decision in 9 |
| #303, #311 | Rich HTML paste; rendered block movement | n/a | **deferred**, see 7 |

Inherited engine behavior (bytes, Unicode, history, recovery, identity) is covered by rows
#284-#293. The 218 shared list literals run through six consumers (compiled WASM plus
synthetic Swift/Kotlin FFI/Store tests); native execution covers arm64 iOS Simulator and
an x86 Android process, other native architectures have compilation proof only.

## 2. Host contract

Three layers, same semantics:

- **Portable (desktop):** `PortableSession` (`src/portable.rs`), exposed as `WasmSession`
  (`src/wasm.rs`, `src/wasm/`). The page emits one ordered `HostRequest` (Append, Flush,
  Resume) at a time; a separate worker owns the real Store
  (`crates/futo-notes-store/src/editor_session/portable.rs`) and answers with `HostAck`.
- **Native (Android/iPhone):** `NativeEditorSession` (`crates/futo-notes-ffi/src/editor/`),
  generated to Swift/Kotlin through UniFFI. It retains the opening Store for its lifetime
  and serializes calls on one attachment. `detach` keeps accepted recovery; it does not
  checkpoint Markdown.
- **Engine (Rust embedders, tests):** `EditorSession` and friends re-exported from
  `crates/futo-notes-editor/src/lib.rs`.

Public surface (portable/WASM names; FFI mirrors the input `_utf16` calls with typed errors): input
`replace`, `replace_utf16`, `replace_many_utf16`, `replace_os_utf16`, `compose_utf16`,
`commit_composition_utf16`, `cancel_composition`, `undo`, `redo`; structure
`block_command_utf16`, `paragraph_key_utf16`; tables `inspect_table`, `table_command`,
`table_key` (`*_utf16` for ranges; no cell-specific entry points, since `replace` and
`paste_markdown` handle cells and pipes are escaped on every path, item 11); view `project`,
`select_with_affinity`, `toggle_format`, `active_formats`; clipboard `copy_markdown`,
`cut_markdown`, `paste_markdown`; `inspect_link`, `set_link`; `update_note_ids` (native
`refresh_note_ids`), `wikilink_completion`, `accept_wikilink_completion`; `image_claim`,
`insert_image`; `tags`, `header_tags`, `add_header_tag`, `remove_header_tag`; find
(section 3); recovery `status`, `resume`, `flush`, `draft_text`, native `recovery_issue`,
`recovery_flush_delay`, `checkpoint`, `take_coordinated_changes`.

**Coordinates.** Source offsets are UTF-8 bytes and never leave the engine as editing
coordinates. Display coordinates are UTF-8 bytes in the engine and UTF-16 units at the
WASM/native edge; native input carries exact UTF-16 units (malformed included) with checked
fixed-width ranges, rejecting oversized values on 32-bit runtimes. Portable/WASM table and
find `*_utf16` variants take native units for input; FFI table, find, clipboard, completion
and link calls take byte ranges, so native hosts convert with `utf16_to_display`; results
stay byte ranges, converted with `display_to_utf16` (item 14). Reject surrogate splits. A replacement
addresses the old display; its returned selection addresses the new one. Ranges carry no
anchor/focus direction; the adapter owns direction and history policy.

**Revisions.** Every edit, selection, projection and find call names the revision it
addresses; a stale one returns `StaleRevision` and changes nothing. Apply returned
`ViewChange` values (semantic replacements, correspondence, selection, affinity) together, once.

**Acknowledgement semantics.** Each request carries a session token and monotonic
sequence. A reply binds to exactly one request; duplicate, stale and superseded replies
never apply twice, regress a watermark or claim durability. *Accepted* (Append reply)
releases the display change; *durable* (successful Flush) advances independently. While
Append or Flush is outstanding, input, selection and projection (and find queries) answer
`Busy`; accepted-state projection and copy stay available, so a paused or pending draft is
always copyable. Retain a refused payload and the revision it addressed; the engine does
not rebase it.

**Errors.** Structured values: editor kinds (`StaleRevision`, `StaleClaim`, `InvalidText`,
`CompositionActive`, `Busy`), recovery stage, review-required issues, committed checkpoint
mutations. Storage failure pauses input with the draft copyable; `resume` repairs, flushes
the accepted prefix, then retries. Review-required corruption is never bypassed.

**Ids and lifetimes.** Opening a session binds one note and vault guard. Rename/move
retargets the live session; a committed delete terminates it (late input, saves, resume
and cached requests cannot revive it). Image claims and find scans name their session
incarnation and go stale (`StaleClaim`, rejected scan) if the note is reopened. Stale attachments reject every call.

## 3. Threading and lifetime guide

- **Store and FFI calls block.** Native: call on the I/O worker, never the UI thread.
  Desktop: the Store worker does all filesystem I/O.
- **One in-flight request.** Append before display: the page prepares the edit, the worker
  appends and acknowledges, then the UI shows it. Do not let OS callbacks run ahead;
  hold refused ones (walkthrough 1, 2).
- **Flush scheduling.** Append acceptance arms the oldest recovery deadline before the
  engine applies. Schedule with `recovery_flush_delay()` (optional Store-clock duration:
  none = nothing pending, zero = due); never compare a raw deadline to a platform clock.
- **Find scans** run anywhere: take `find_scan_request` after input settles (carries
  incarnation, revision, generation, text, soft breaks, table `barriers`), run `FindScanRequest.run()`
  natively or WASM `find_scan` on any worker/thread, then `find_apply_scan` on the session
  thread. A result for another session incarnation, revision or query generation, or after
  close, is rejected with no state change. Typing never triggers a scan.
- **Note ids.** The Store delivers vault ids to a live session on open (call
  `refresh_note_ids` only on later vault changes, item 9); delivery never
  changes source, selection, history or a composition. An unreleased change answers `Busy`.
- **Composition conventions** (item 13):

  | Command | While composing |
  | --- | --- |
  | `paste_markdown`, tag edits | staged until the composition ends |
  | `table_key`, `table_command` | `CompositionActive` |
  | `find_step` | no-op |

- **Sessions are single-owner.** Native calls serialize through the attachment lock; do
  not share a portable session across threads.

## 4. Compatibility

- Recovery stream format: streams are written as v3; readers read v2 and v3. Unknown
  versions (including v4 from pre-release bounded-mode builds of this branch) are retained
  and paused; no data is lost. **Rollout:** no shipped build reads `.futo-editor-recovery`
  (nothing on main), so v2/v3 ship together with no reader-first gating (item 8).
- No change to bridge schemas, AppState, sync or shipping defaults.
- Persistent Undo across reopening is not included. The full materializing paragraph
  projection stays available; do not remove it.
- Shared crates `futo-notes-tags` and `futo-notes-image` were split out for wasm32 and
  re-export from their old paths. The `markdown` crate is gone from the engine (its
  `to_mdast` can panic; item 17). WASM test builds enable `test-clock`
  (`scripts/test-editor-wasm.mjs`); never ship with it.

## 5. Renderer responsibilities (engine deliberately leaves these to hosts)

Check each off in your renderer; the engine supplies data, not pixels.

- [ ] Wikilink labels: draw the resolved label over the `[[...]]` source display range as
      a caret-proof atom; keep the caret outside it. Display text keeps source spelling.
- [ ] Image and divider atoms: render, resolve a platform URL for vault images (display
      only), caret stops only before/after, delete through ordinary input. Picker, asset
      writing and decoding stay with existing infrastructure.
- [ ] Front matter panel from the block description's `metadata` flag (selection inside
      snaps to the body start); footnote and HTML-block rendering from descriptions.
- [ ] Find bar, highlight painting and the localized "N of M" label from `FindReport`;
      reveal the returned range; `stale` until a scan lands.
- [ ] Completion menu UI, selection and dismissal memory (Escape for the same run).
- [ ] Tables: draw the grid, drive `table_key`/`table_command`; do not route cell input
      specially; `<br>` shows literally; tables in containers show as ordinary text.
- [ ] Caret, selection direction/history policy, IME/composition adapter (see #294).
- [ ] Copyable-failure UI: Copy Draft, labelled precisely (candidate vs accepted source).

## 6. Verification at handoff

CI runs `cargo test -p futo-notes-editor -p futo-notes-store -p futo-notes-core`,
`node scripts/test-editor-wasm.mjs` (blocking in `ci/test-rust.yml`, also in the release
gate), FFI tests in `crates/futo-notes-ffi/tests/`, and the Swift/Kotlin contract-surface
tests named in the #315 row. At 924888e5e: iOS simulator 305 tests / 59 suites pass (incl. the contract-surface, session, composition and input-trace suites, plus the since-removed bounded suite); Android 32-bit x86 process 14/14 native methods pass; 911 Rust editor/Store/FFI tests and all WASM consumers pass. Device timing script:
`scripts/android-performance-recon.mjs`. No massive campaign was added.

## 7. Deferred (open issues, not accepted capabilities)

- **#303 rich HTML paste** and **#311 rendered block movement** (maintainer, 2026-10-30);
  issues stay open. Plain/Markdown paste (#302) and single-cell table paste are accepted.
- Table alignment commands, row/column reordering, multi-cell/grid paste; tables inside
  containers. Existing alignment and untouched table bytes stay exact.
- **#294** device dictation, correction and crash work: parked; physical IME unproven.
- Physical iPhone latency measurement (follow-up to #316).
- Renderer integration, UI, cutovers and later parallel hardening belong to renderer owners.

## 8. Long regions, reinterpretation and their limits (#313 / #314)

Spec: long-regions.md, remaining-work.md. Scope for this milestone is
**correctness plus locality**; progressive background slices are deferred (item 15).

- **Locality on the full path.** Per-key work is flat from 1k to 20k lines for long
  paragraphs, tight bullet and numbered lists (typing, Backspace), raw HTML kinds 1-5 and
  top-level fenced code (tests `long_regions.rs`, `inline/row/split*`).
- **Correctness of structural reinterpretation.** An accepted edit (paste, replay, Undo)
  that changes how text outside its window reads reparses through to the true end, so the
  projection always equals a fresh open. The twin fuzz (`reinterpretation.rs`, 6k cases,
  raw fence and comment delimiters included) requires every step to match a fresh open.
- **No bounded mode.** The former opt-in endpoint for giant closed top-level fences was
  removed (item 18); the full path's fence locality gives giant fences bounded work.
- **Documented limits** (renderers must not assume otherwise):
  - Numbered-list Enter (renumbers every later marker) and Backspace at an item start
    are whole-list work (about 2.4 M and 13.7 M counted work at 20k items); typing in
    numbered items is local. Lazily numbered, loose and quoted lists stay region-sized.
  - A giant paragraph holding one pairable literal delimiter (`2*3`, `a<b`, an unmatched
    bracket or backtick, a footnote reference) stays uncut: about 4.7 M counted work per key.
  - Fences inside lists or quotes are not cut; a single huge display line is one parser unit.
  - A structure-changing raw edit costs one synchronous region-sized step, e.g. pasting
    over a fence closer above 20k paragraphs parses 687 KB (27 ms release on an M-series
    Mac; Undo 45 ms). Later keys are local again.
  - Progressive background slices are deferred. They need stale-row guards across input,
    queries, find, staged commands and history; schedule that design before renderer GA.

## 9. Measured budgets and their limits

Reconnaissance on the physical Moto g play 2023 (ARM32, Android 13, optimized
release-ffi), full path at head `924888e5e`. These are reconnaissance timings, **not**
p95/100 ms durability acceptance.

| Shape (20k lines unless noted) | Warm typing median / max | Morning baseline |
|---|---|---|
| Separated paragraphs | 11.5 / 15.1 ms | n/a |
| Giant single paragraph | 22.3 / 24.5 ms | 3,237 ms |
| Bullet list | 42.0 / 44.0 ms | 3,844 ms |
| Fenced code | 26.7 / 29.7 ms | 1,146 ms |
| Cold first keys (four shapes) | 47.0 / 61.2 / 85.7 / 53.2 ms | n/a |
| Explicit flushes | 10-22 ms | n/a |

- Small samples, uncontrolled load: no p95, timer, OS typing, blocked-I/O, kill or power-loss
  proof. Flushes are immediate explicit flushes, not 100 ms durability.
- Work counters (`EditWork`, `FindWork`, `NoteIdWork`) are deterministic
  bounds, not latency. Durability evidence is injected-filesystem tests (modeled power loss).
- **iOS:** simulator only (305 native tests pass at 924888e5e). **#316 decision**
  (maintainer, 2026-11-01): simulator plus the Moto suffice for this milestone; physical
  iPhone measurement is a follow-up, and simulator timings are not iPhone timings.

## 10. Reversible judgment calls (2026-11-01)

Numbered as in the MR !558 description, which has the reasons and how to reverse each.

(1) Wikilink labels are a renderer role, not display text (#305). (2) Paste follows the
spec, not TS `plainTextPaste` (strips one trailing line ending). (3) Whole-line copy
includes the block prefix; ordered siblings are not renumbered on paste. (4) Tables are top-
level only; Mod+Enter adds a blank line; Shift+Enter writes `<br>`. (5) Find rebase log cap
is 64 unread edits (`REBASE_LOG_LIMIT`). (6) Select-all + delete keeps front matter. (7)
`futo-notes-tags` and `futo-notes-image` split out for wasm32. (8) No recovery reader ships
today, so v2/v3 ship together. (9) Store auto-delivers note ids on open. (10) #316 iPhone leg replaced by simulator + Moto evidence. (11) Table-cell pipes are
escaped on every input path; no cell entry points. (12) Spans cut by a multi-paragraph paste
close and reopen on both sides. (13) `find_step` during composition is a no-op. (14)
`*_utf16` table/find variants take native units for input only. (15) #313 is correctness +
locality; progressive slices deferred. (16) Numbered-list Enter renumbers synchronously.
(17) `markdown` crate dropped; definitions and bare autolinks use the engine's own parsers.
(18) Bounded mode and its v4 recovery reservation removed (2026-11-02); full-path long-region
locality replaces it.

## Appendix: adapter walkthrough

Five scenarios that challenge the adapter contract (pending Append, composition during
Flush, coordinate changes, copyable failure, worker responsiveness) are in
[text-first-editor-host-walkthrough.md](text-first-editor-host-walkthrough.md).
